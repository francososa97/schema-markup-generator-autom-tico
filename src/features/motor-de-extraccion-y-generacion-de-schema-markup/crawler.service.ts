import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { chromium, type Browser } from 'playwright';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  CrawlerError,
  type CrawlerOptions,
  type ExtractedHeading,
  type PageMetadata,
  type PageScanResult,
  type RenderStrategy,
} from './types';

interface PinnedResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; SchemaMarkupBot/1.0; +https://example.com/bot)';
// Por debajo de este volumen de texto asumimos que el contenido
// se renderiza vía JS y conviene reintentar con Playwright.
const DEFAULT_JS_CONTENT_THRESHOLD = 200;
const MAX_REDIRECTS = 5;
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/**
 * Crawler que dado un URL público devuelve HTML + metadata + contenido principal.
 * Usa Cheerio para HTML estático y hace fallback a Playwright cuando detecta
 * que la página depende de JavaScript. Respeta un timeout total duro.
 */
export class CrawlerService {
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly jsContentThreshold: number;

  constructor(options: CrawlerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.jsContentThreshold =
      options.jsContentThreshold ?? DEFAULT_JS_CONTENT_THRESHOLD;
  }

  /** Punto de entrada principal: escanea un URL público. */
  public async scan(rawUrl: string): Promise<PageScanResult> {
    const startedAt = Date.now();
    const { url, ip } = await this.validateUrl(rawUrl);

    // 1) Intento estático con fetch + Cheerio.
    const staticHtml = await this.fetchStatic(url, ip, this.timeoutMs);
    const $static = cheerio.load(staticHtml);
    const staticContent = this.extractMainContent($static);

    // 2) Si el contenido es pobre, la página probablemente depende de JS.
    if (staticContent.length >= this.jsContentThreshold) {
      return this.buildResult(url, staticHtml, $static, 'cheerio', startedAt);
    }

    const remainingMs = this.remainingBudget(startedAt);
    if (remainingMs <= 0) {
      // Sin presupuesto para Playwright: devolvemos lo estático igual.
      return this.buildResult(url, staticHtml, $static, 'cheerio', startedAt);
    }

    // 3) Fallback a Playwright dentro del presupuesto restante.
    // Nota: a diferencia de fetchStatic, acá no se revalida cada redirect
    // (Playwright no expone un hook simple para eso sin route interception).
    // El target inicial ya pasó validateUrl; si se necesita blindar también
    // la cadena de redirects en el path renderizado, agregar interceptor de
    // request en `context` que llame a isPrivateOrReservedIp por cada navegación.
    const renderedHtml = await this.fetchRendered(url, remainingMs);
    const $rendered = cheerio.load(renderedHtml);
    return this.buildResult(url, renderedHtml, $rendered, 'playwright', startedAt);
  }

  /**
   * Valida y normaliza el URL; sólo http/https son aceptados, y se
   * bloquean hosts/IPs internos o reservados para evitar SSRF. Devuelve
   * también la IP ya resuelta y validada, para que el fetch posterior se
   * conecte exactamente a esa IP (ver `fetchStatic`/`requestPinned`) en vez
   * de dejar que Node vuelva a resolver DNS por su cuenta — eso es lo que
   * cierra la ventana de DNS rebinding (TOCTOU entre validar y conectar).
   */
  private async validateUrl(rawUrl: string): Promise<{ url: URL; ip: string }> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new CrawlerError('INVALID_URL', `URL inválida: "${rawUrl}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new CrawlerError(
        'INVALID_URL',
        `Protocolo no soportado: "${parsed.protocol}". Usar http o https.`,
      );
    }
    const ip = await this.assertHostAllowed(parsed.hostname);
    return { url: parsed, ip };
  }

  /**
   * Lanza CrawlerError si el hostname (o la IP a la que resuelve) es
   * interno/reservado; si pasa la validación, devuelve la IP resuelta para
   * que el caller la reutilice (pinning) en vez de resolver DNS de nuevo.
   */
  private async assertHostAllowed(hostname: string): Promise<string> {
    const lower = hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(lower) || lower.endsWith('.localhost')) {
      throw new CrawlerError('BLOCKED_HOST', `Host no permitido: "${hostname}"`);
    }

    let ip: string;
    if (isIP(hostname)) {
      ip = hostname;
    } else {
      try {
        ip = (await lookup(hostname)).address;
      } catch {
        throw new CrawlerError('UNREACHABLE', `No se pudo resolver el host: "${hostname}"`);
      }
    }

    if (this.isPrivateOrReservedIp(ip)) {
      throw new CrawlerError(
        'BLOCKED_HOST',
        `Host no permitido: "${hostname}" resuelve a una IP interna/reservada (${ip})`,
      );
    }
    return ip;
  }

  /** true si la IP (v4 o v6) es loopback, privada, link-local o reservada (incl. metadata de cloud). */
  private isPrivateOrReservedIp(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) {
      const parts = ip.split('.').map(Number);
      const [a, b] = parts;
      if (a === 127) return true; // loopback
      if (a === 10) return true; // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true; // 192.168.0.0/16
      if (a === 169 && b === 254) return true; // link-local, incluye metadata 169.254.169.254
      if (a === 0) return true; // 0.0.0.0/8
      if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
      return false;
    }
    if (version === 6) {
      const lower = ip.toLowerCase();
      if (lower === '::1' || lower === '::') return true; // loopback / unspecified
      if (lower.startsWith('fe80:')) return true; // link-local
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (fc00::/7)
      if (lower.startsWith('::ffff:')) {
        // IPv4-mapped IPv6: revalidar como v4
        const mapped = lower.slice('::ffff:'.length);
        return isIP(mapped) === 4 ? this.isPrivateOrReservedIp(mapped) : true;
      }
      return false;
    }
    return true; // IP no reconocible: bloquear por las dudas
  }

  /**
   * Descarga HTML estático siguiendo redirects a mano (cada hop se revalida
   * y se conecta a la IP ya validada, no a la que Node resuelva de nuevo).
   * El presupuesto de tiempo es agregado: se descuenta lo ya gastado en
   * cada hop en vez de reiniciar el timeout completo por redirect.
   */
  private async fetchStatic(url: URL, ip: string, budgetMs: number): Promise<string> {
    const deadline = Date.now() + budgetMs;
    let currentUrl = url;
    let currentIp = ip;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CrawlerError('TIMEOUT', `Timeout de ${budgetMs}ms al descargar el HTML`);
      }

      let response: PinnedResponse;
      try {
        response = await this.requestPinned(currentUrl, currentIp, remaining);
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'TIMEOUT') {
          throw new CrawlerError('TIMEOUT', `Timeout de ${budgetMs}ms al descargar el HTML`);
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new CrawlerError('UNREACHABLE', `URL inaccesible: ${detail}`);
      }

      if (response.statusCode >= 300 && response.statusCode < 400) {
        const rawLocation = response.headers.location;
        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        if (location === undefined) {
          throw new CrawlerError('UNREACHABLE', `Redirect ${response.statusCode} sin header Location`);
        }
        const nextUrl = this.resolveUrl(location, currentUrl);
        if (nextUrl === null) {
          throw new CrawlerError('UNREACHABLE', `Location de redirect inválida: "${location}"`);
        }
        const parsedNext = new URL(nextUrl);
        if (parsedNext.protocol !== 'http:' && parsedNext.protocol !== 'https:') {
          throw new CrawlerError('BLOCKED_HOST', `Redirect a protocolo no soportado: "${parsedNext.protocol}"`);
        }
        currentIp = await this.assertHostAllowed(parsedNext.hostname);
        currentUrl = parsedNext;
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new CrawlerError('HTTP_ERROR', `El servidor respondió ${response.statusCode}`);
      }
      return response.body;
    }
    throw new CrawlerError('UNREACHABLE', `Demasiados redirects (>${MAX_REDIRECTS})`);
  }

  /**
   * Hace un GET conectándose directamente a `pinnedIp` (vía una función
   * `lookup` custom que ignora cualquier resolución DNS nueva), preservando
   * el hostname real en el header Host y en `servername` para que TLS/SNI
   * sigan validando contra el dominio original. Esto es lo que cierra la
   * ventana de TOCTOU/DNS rebinding entre `assertHostAllowed` y la conexión.
   */
  private requestPinned(url: URL, pinnedIp: string, budgetMs: number): Promise<PinnedResponse> {
    return new Promise((resolve, reject) => {
      const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = requestFn(
        url,
        {
          method: 'GET',
          timeout: budgetMs,
          headers: {
            'user-agent': this.userAgent,
            accept: 'text/html,application/xhtml+xml',
            host: url.host,
          },
          // Node invoca este lookup con distinta forma de callback según
          // `options.all` (algunos paths internos lo piden en array); hay
          // que soportar ambas o el request falla con "Invalid IP address".
          lookup: (
            _hostname: string,
            options: { all?: boolean } | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
            callback?: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
          ) => {
            const family = isIP(pinnedIp) === 6 ? 6 : 4;
            const actualCallback = typeof options === 'function' ? options : callback;
            const wantsAll = typeof options === 'object' && options !== null && options.all === true;
            if (wantsAll) {
              (actualCallback as unknown as (err: null, addrs: { address: string; family: number }[]) => void)(
                null,
                [{ address: pinnedIp, family }],
              );
            } else {
              actualCallback?.(null, pinnedIp, family);
            }
          },
          ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
      req.on('error', reject);
      req.end();
    });
  }

  /** Renderiza la página con Playwright (Chromium headless). */
  private async fetchRendered(url: URL, budgetMs: number): Promise<string> {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ userAgent: this.userAgent });
      const page = await context.newPage();
      await page.goto(url.toString(), {
        waitUntil: 'networkidle',
        timeout: budgetMs,
      });
      return await page.content();
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.toLowerCase().includes('timeout')) {
        throw new CrawlerError(
          'TIMEOUT',
          `Timeout de ${budgetMs}ms al renderizar con Playwright`,
        );
      }
      throw new CrawlerError(
        'RENDER_FAILED',
        `Fallo al renderizar la página: ${detail}`,
      );
    } finally {
      if (browser !== null) {
        await browser.close();
      }
    }
  }

  /** Construye el resultado final a partir del HTML y su Cheerio cargado. */
  private buildResult(
    url: URL,
    html: string,
    $: CheerioAPI,
    strategy: RenderStrategy,
    startedAt: number,
  ): PageScanResult {
    return {
      url: url.toString(),
      html,
      metadata: this.extractMetadata($, url),
      mainContent: this.extractMainContent($),
      strategy,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /** Extrae title, description, canonical, lang y headings. */
  private extractMetadata($: CheerioAPI, url: URL): PageMetadata {
    const title =
      this.textOrNull($('head > title').first().text()) ??
      this.attrOrNull($('meta[property="og:title"]').attr('content'));

    const description =
      this.attrOrNull($('meta[name="description"]').attr('content')) ??
      this.attrOrNull($('meta[property="og:description"]').attr('content'));

    const canonicalRaw = this.attrOrNull(
      $('link[rel="canonical"]').attr('href'),
    );
    const canonicalUrl =
      canonicalRaw !== null ? this.resolveUrl(canonicalRaw, url) : null;

    const lang = this.attrOrNull($('html').attr('lang'));

    const headings: ExtractedHeading[] = [];
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const tag = ($(el).prop('tagName') ?? '').toLowerCase();
      const level = Number.parseInt(tag.replace('h', ''), 10);
      const text = this.normalizeWhitespace($(el).text());
      if (text.length > 0 && level >= 1 && level <= 6) {
        headings.push({ level: level as ExtractedHeading['level'], text });
      }
    });

    return { title, description, canonicalUrl, lang, headings };
  }

  /**
   * Extrae el contenido principal con mejor esfuerzo: prioriza <main>,
   * <article>, luego el <body>, descartando scripts/estilos/nav/footer.
   */
  private extractMainContent($: CheerioAPI): string {
    const working = cheerio.load($.html());
    working('script, style, noscript, nav, header, footer, aside').remove();

    const candidates = ['main', 'article', '[role="main"]', 'body'];
    for (const selector of candidates) {
      const node = working(selector).first();
      if (node.length > 0) {
        const text = this.normalizeWhitespace(node.text());
        if (text.length > 0) {
          return text;
        }
      }
    }
    return '';
  }

  /** Presupuesto de tiempo restante respecto al timeout total. */
  private remainingBudget(startedAt: number): number {
    return this.timeoutMs - (Date.now() - startedAt);
  }

  private resolveUrl(candidate: string, base: URL): string | null {
    try {
      return new URL(candidate, base).toString();
    } catch {
      return null;
    }
  }

  private normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private textOrNull(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private attrOrNull(value: string | undefined): string | null {
    if (value === undefined) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
