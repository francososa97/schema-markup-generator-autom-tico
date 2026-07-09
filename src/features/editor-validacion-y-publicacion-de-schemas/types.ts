// src/features/editor-validacion-y-publicacion-de-schemas/types.ts
// Tipos del dominio del editor de JSON-LD. Se mantienen JSON-safe (serializables)
// para poder persistirlos vía PATCH /schemas/:id sin transformaciones extra.

/** Valores primitivos que puede contener un campo JSON-LD. */
export type JsonLdPrimitive = string | number | boolean | null;

/** Valor JSON-LD recursivo (objeto, arreglo o primitivo). */
export type JsonLdValue = JsonLdPrimitive | JsonLdValue[] | { [key: string]: JsonLdValue };

/** Documento JSON-LD. Siempre expone `@context` y `@type` de schema.org. */
export interface JsonLdObject {
  '@context': string;
  '@type': string;
  [key: string]: JsonLdValue;
}

/** Identificador único de un schema persistido. */
export type SchemaId = string;

/** Registro de schema tal como lo almacena el backend. */
export interface SchemaRecord {
  id: SchemaId;
  /** Tipo schema.org, ej. "Article", "Product", "FAQPage". */
  type: string;
  jsonLd: JsonLdObject;
  /** Timestamp ISO-8601 de la última actualización. */
  updatedAt: string;
}

/** Controles de input soportados por el form estructurado. */
export type FormFieldType = 'text' | 'textarea' | 'url' | 'date' | 'number';

/** Campo editable individual renderizado en el form. */
export interface FormField {
  /** Ruta con puntos dentro del JSON-LD, ej. "author.name". */
  path: string;
  label: string;
  type: FormFieldType;
  value: string;
  required: boolean;
}

/** Representación estructurada (no raw JSON) de un schema, lista para renderizar. */
export interface SchemaForm {
  id: SchemaId;
  schemaType: string;
  fields: FormField[];
}

export interface FieldError {
  path: string;
  message: string;
}

/** Resultado de validar el form antes de persistir. */
export interface ValidationResult {
  valid: boolean;
  errors: FieldError[];
}

/** Cuerpo enviado a PATCH /schemas/:id. */
export interface PatchSchemaRequest {
  jsonLd: JsonLdObject;
}

/** Respuesta devuelta por PATCH /schemas/:id. */
export interface PatchSchemaResponse {
  status: number;
  record: SchemaRecord;
}

/** Límite de persistencia. Lo implementa un cliente HTTP o un store en memoria. */
export interface SchemaRepository {
  getById(id: SchemaId): Promise<SchemaRecord>;
  patch(id: SchemaId, body: PatchSchemaRequest): Promise<PatchSchemaResponse>;
}
