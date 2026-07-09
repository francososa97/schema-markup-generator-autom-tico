// Tipos del motor de extracción y generación de Schema Markup.
// Nota: cuando `src/shared/types/index.ts` exista, los tipos comunes
// (p.ej. ApiError, PageContent) deberían migrarse allí y reexportarse desde aquí.

/** Tipos de schema.org soportados por el clasificador en E1. */
export type SchemaOrgType =
  | 'Article'
  | 'NewsArticle'
  | 'BlogPosting'
  | 'Product'
  | 'FAQPage'
  | 'Recipe'
  | 'Event'
  | 'LocalBusiness'
  | 'Organization'
  | 'Person'
  | 'HowTo'
  | 'VideoObject'
  | 'JobPosting'
  | 'WebPage';

export const SUPPORTED_SCHEMA_TYPES: readonly SchemaOrgType[] = [
  'Article',
  'NewsArticle',
  'BlogPosting',
  'Product',
  'FAQPage',
  'Recipe',
  'Event',
  'LocalBusiness',
  'Organization',
  'Person',
  'HowTo',
  'VideoObject',
  'JobPosting',
  'WebPage',
] as const;

/**
 * Contenido ya extraído de una página (salida esperada de E1-T1).
 * Es la entrada del endpoint POST /pages/classify.
 */
export interface PageContent {
  /** URL canónica de la página, si se conoce. */
  url?: string;
  /** <title> o encabezado principal. */
  title?: string;
  /** Meta description, si existe. */
  metaDescription?: string;
  /** Texto principal ya limpiado (sin nav/footer/boilerplate). */
  bodyText: string;
  /** Encabezados (h1..h6) en orden de aparición. */
  headings?: string[];
}

/** Valor primitivo o anidado de un campo estructurado extraído. */
export type StructuredFieldValue =
  | string
  | number
  | boolean
  | null
  | StructuredFieldValue[]
  | { [key: string]: StructuredFieldValue };

/** Mapa de campos estructurados alineados a las propiedades de schema.org. */
export type StructuredFields = Record<string, StructuredFieldValue>;

/** Modelo de Claude usado para producir una clasificación. */
export type ClassifierModel = 'haiku' | 'sonnet';

/** Resultado de una única llamada al LLM. */
export interface ClassificationAttempt {
  schemaType: SchemaOrgType;
  confidence: number;
  fields: StructuredFields;
  model: ClassifierModel;
}

/** Respuesta final del servicio de clasificación. */
export interface ClassificationResult {
  /** Tipo schema.org sugerido. */
  schemaType: SchemaOrgType;
  /** Confianza [0..1] de la clasificación finalmente elegida. */
  confidence: number;
  /** Campos estructurados extraídos, alineados a schema.org. */
  fields: StructuredFields;
  /** Modelo que produjo el resultado final. */
  model: ClassifierModel;
  /** true si se escaló de Haiku a Sonnet por baja confianza. */
  usedFallback: boolean;
}

/** Error de dominio con código HTTP asociado. */
export class ClassificationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ClassificationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Config del clasificador; los defaults se resuelven en el service. */
export interface ClassifierConfig {
  apiKey: string;
  haikuModel: string;
  sonnetModel: string;
  /** Umbral de confianza por debajo del cual se escala a Sonnet. */
  confidenceThreshold: number;
  maxTokens: number;
}
