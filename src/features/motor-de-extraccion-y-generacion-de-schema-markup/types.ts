// Tipos de dominio para el crawler de páginas (E1-T1).
// Si más adelante existen tipos compartidos en src/shared/types/index.ts,
// estos deben migrarse/reexportarse desde ahí.

/** Estrategia de renderizado usada para extraer el contenido. */
export type RenderStrategy = 'cheerio' | 'playwright';

/** Encabezado extraído de la página. */
export interface ExtractedHeading {
  /** Nivel del encabezado (1 = h1, 6 = h6). */
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Texto plano del encabezado, ya normalizado. */
  readonly text: string;
}

/** Metadata relevante extraída del documento. */
export interface PageMetadata {
  /** Título del documento (<title> o og:title como fallback). */
  readonly title: string | null;
  /** Meta description si existe. */
  readonly description: string | null;
  /** URL canónica declarada por la página, si existe. */
  readonly canonicalUrl: string | null;
  /** Idioma declarado en <html lang>. */
  readonly lang: string | null;
  /** Encabezados h1..h6 en orden de aparición. */
  readonly headings: readonly ExtractedHeading[];
}

/** Resultado exitoso de un scan. */
export interface PageScanResult {
  /** URL final tras redirecciones. */
  readonly url: string;
  /** HTML crudo obtenido (renderizado si se usó Playwright). */
  readonly html: string;
  /** Metadata estructurada. */
  readonly metadata: PageMetadata;
  /** Texto del contenido principal (mejor esfuerzo). */
  readonly mainContent: string;
  /** Estrategia efectivamente utilizada. */
  readonly strategy: RenderStrategy;
  /** Duración total de la extracción en milisegundos. */
  readonly elapsedMs: number;
}

/** Opciones de configuración del crawler. */
export interface CrawlerOptions {
  /** Timeout total duro en ms (default 10000, acorde al AC). */
  readonly timeoutMs?: number;
  /** User-Agent a enviar en las requests. */
  readonly userAgent?: string;
  /**
   * Umbral de texto (en caracteres) por debajo del cual se asume
   * que la página depende de JS y se reintenta con Playwright.
   */
  readonly jsContentThreshold?: number;
}

/** Error tipado del crawler para poder mapearlo a HTTP 400. */
export class CrawlerError extends Error {
  public readonly code:
    | 'INVALID_URL'
    | 'UNREACHABLE'
    | 'HTTP_ERROR'
    | 'TIMEOUT'
    | 'RENDER_FAILED'
    | 'BLOCKED_HOST'
    | 'BODY_TOO_LARGE'
    | 'UNSUPPORTED_CONTENT_TYPE';

  constructor(
    code: CrawlerError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'CrawlerError';
    this.code = code;
    Object.setPrototypeOf(this, CrawlerError.prototype);
  }
}
