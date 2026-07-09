import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { chromium, type Browser } from 'playwright';
import {
  CrawlerError,
  type CrawlerOptions,
  type ExtractedHeading,
  type PageMetadata,
  type PageScanResult,
  type RenderStrategy,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; SchemaMarkupBot/1.0; +https://example.com/bot)';
// Por debajo de este volumen de texto asumimos que el contenido
// se renderiza vía JS y conviene reintentar con Playwright.
const DEFAULT_JS_CONTENT_THRESHOLD = 200;

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
    const url = this.validateUrl(rawUrl);

    // 1) Intento estático con fetch + Cheerio.
    const staticHtml = await this.fetchStatic(url, this.timeoutMs);
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
    const renderedHtml = await this.fetchRendered(url, remainingMs);
    const $rendered = cheerio.load(renderedHtml);
    return this.buildResult(url, renderedHtml, $rendered, 'playwright', startedAt);
  }

  /** Valida y normaliza el URL; sólo http/https son aceptados. */
  private validateUrl(rawUrl: string): URL {
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
    return parsed;
  }

  /** Descarga HTML estático con fetch nativo y un AbortController por timeout. */
  private async fetchStatic(url: URL, budgetMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await fetch(url.toString(), {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!response.ok) {
        throw new CrawlerError(
          'HTTP_ERROR',
          `El servidor respondió ${response.status} ${response.statusText}`,
        );
      }
      return await response.text();
    } catch (error: unknown) {
      if (error instanceof CrawlerError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CrawlerError(
          'TIMEOUT',
          `Timeout de ${budgetMs}ms al descargar el HTML`,
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new CrawlerError('UNREACHABLE', `URL inaccesible: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
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
