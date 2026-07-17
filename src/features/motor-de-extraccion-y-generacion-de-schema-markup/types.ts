/**
 * Tipos del motor de extracción y generación de Schema Markup.
 *
 * NOTA: src/shared/types/index.ts aún no existe en el repo. Cuando se cree,
 * estos tipos deberían re-exportarse desde allí para evitar duplicación.
 */

/** Valores admitidos dentro de un nodo JSON-LD. */
export type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonLdValue[]
  | { readonly [key: string]: JsonLdValue };

/** Mapa de campos extraídos de una página, indexados por propiedad schema.org. */
export type ExtractedFields = Readonly<Record<string, JsonLdValue>>;

/** Payload del POST /schemas/generate. */
export interface GenerateSchemaRequest {
  /** Tipo schema.org, ej: "Article", "Product", "FAQPage". */
  readonly type: string;
  /** Campos ya extraídos por el motor de extracción. */
  readonly fields: ExtractedFields;
}

/** Documento JSON-LD resultante, sintácticamente válido. */
export interface JsonLdDocument {
  readonly '@context': 'https://schema.org';
  readonly '@type': string;
  readonly [key: string]: JsonLdValue;
}

export interface GenerateSuccess {
  readonly ok: true;
  readonly status: 200;
  readonly jsonLd: JsonLdDocument;
}

export type GenerateErrorCode = 'UNSUPPORTED_TYPE' | 'MISSING_REQUIRED_FIELDS';

export interface GenerateFailure {
  readonly ok: false;
  readonly status: 422;
  readonly code: GenerateErrorCode;
  readonly message: string;
  /** Campos obligatorios ausentes (vacío cuando code === 'UNSUPPORTED_TYPE'). */
  readonly missingFields: readonly string[];
}

export type GenerateResult = GenerateSuccess | GenerateFailure;
