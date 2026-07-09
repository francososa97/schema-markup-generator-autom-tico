// src/features/editor-validacion-y-publicacion-de-schemas/service.ts
// Núcleo framework-agnóstico del editor de JSON-LD:
//   - buildForm:   deriva un form estructurado desde un SchemaRecord
//   - applyChange: actualización inmutable de un campo
//   - toJsonLd:    reconstruye el JSON-LD (preview en tiempo real, síncrono)
//   - validate:    valida requeridos, URLs y números
//   - save:        valida + PATCH /schemas/:id, midiendo latencia (< 1s AC)

import type {
  FieldError,
  FormField,
  FormFieldType,
  JsonLdObject,
  JsonLdValue,
  PatchSchemaResponse,
  SchemaForm,
  SchemaRecord,
  SchemaRepository,
  ValidationResult,
} from './types';

/** Definición de un campo conocido para un tipo schema.org. */
interface FieldDefinition {
  path: string;
  label: string;
  type: FormFieldType;
  required: boolean;
}

/** Campos estructurados por tipo de schema. Tipos no listados usan introspección. */
const FIELD_REGISTRY: Record<string, FieldDefinition[]> = {
  Article: [
    { path: 'headline', label: 'Titular', type: 'text', required: true },
    { path: 'description', label: 'Descripción', type: 'textarea', required: false },
    { path: 'author.name', label: 'Autor', type: 'text', required: true },
    { path: 'datePublished', label: 'Fecha de publicación', type: 'date', required: true },
    { path: 'image', label: 'URL de imagen', type: 'url', required: false },
  ],
  Product: [
    { path: 'name', label: 'Nombre', type: 'text', required: true },
    { path: 'description', label: 'Descripción', type: 'textarea', required: false },
    { path: 'brand.name', label: 'Marca', type: 'text', required: false },
    { path: 'offers.price', label: 'Precio', type: 'number', required: true },
    { path: 'offers.priceCurrency', label: 'Moneda', type: 'text', required: true },
    { path: 'image', label: 'URL de imagen', type: 'url', required: false },
  ],
};

/** Resultado de un intento de guardado. */
export type SaveOutcome =
  | { ok: false; validation: ValidationResult }
  | {
      ok: true;
      validation: ValidationResult;
      response: PatchSchemaResponse;
      jsonLd: JsonLdObject;
      /** Latencia del PATCH en milisegundos (para chequear el AC de < 1s). */
      elapsedMs: number;
    };

export class SchemaEditorService {
  public constructor(private readonly repo: SchemaRepository) {}

  /** Deriva el form estructurado desde el registro persistido. */
  public buildForm(record: SchemaRecord): SchemaForm {
    const defs = FIELD_REGISTRY[record.type];
    const fields: FormField[] =
      defs !== undefined && defs.length > 0
        ? defs.map((def) => ({
            path: def.path,
            label: def.label,
            type: def.type,
            required: def.required,
            value: stringifyValue(getByPath(record.jsonLd, def.path)),
          }))
        : introspect(record.jsonLd);
    return { id: record.id, schemaType: record.type, fields };
  }

  /** Devuelve un nuevo form con el campo `path` actualizado (inmutable). */
  public applyChange(form: SchemaForm, path: string, value: string): SchemaForm {
    return {
      ...form,
      fields: form.fields.map((field) =>
        field.path === path ? { ...field, value } : field,
      ),
    };
  }

  /**
   * Reconstruye el JSON-LD a partir del registro base + los valores del form.
   * Operación pura y síncrona: apta para preview en tiempo real en cada tecla.
   */
  public toJsonLd(base: JsonLdObject, form: SchemaForm): JsonLdObject {
    const draft = deepClone(base);
    for (const field of form.fields) {
      const trimmed = field.value.trim();
      if (trimmed === '' && !field.required) {
        // Campo opcional vacío: no ensucia el JSON-LD.
        deleteByPath(draft, field.path);
        continue;
      }
      setByPath(draft, field.path, coerce(field.type, field.value));
    }
    return draft;
  }

  /** Valida requeridos, formato de URL y numéricos. */
  public validate(form: SchemaForm): ValidationResult {
    const errors: FieldError[] = [];
    for (const field of form.fields) {
      const trimmed = field.value.trim();
      if (field.required && trimmed === '') {
        errors.push({ path: field.path, message: `${field.label} es obligatorio` });
        continue;
      }
      if (field.type === 'url' && trimmed !== '' && !isValidUrl(trimmed)) {
        errors.push({ path: field.path, message: `${field.label} debe ser una URL válida` });
      }
      if (field.type === 'number' && trimmed !== '' && !Number.isFinite(Number(trimmed))) {
        errors.push({ path: field.path, message: `${field.label} debe ser numérico` });
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /** Valida y persiste vía PATCH /schemas/:id, midiendo la latencia. */
  public async save(record: SchemaRecord, form: SchemaForm): Promise<SaveOutcome> {
    const validation = this.validate(form);
    if (!validation.valid) {
      return { ok: false, validation };
    }
    const jsonLd = this.toJsonLd(record.jsonLd, form);
    const start = now();
    const response = await this.repo.patch(record.id, { jsonLd });
    const elapsedMs = now() - start;
    return { ok: true, validation, response, jsonLd, elapsedMs };
  }
}

/** Repositorio HTTP contra el backend `/schemas`. */
export class HttpSchemaRepository implements SchemaRepository {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  public async getById(id: string): Promise<SchemaRecord> {
    const res = await this.fetchFn(`${this.baseUrl}/schemas/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`GET /schemas/${id} falló con status ${res.status}`);
    }
    return (await res.json()) as SchemaRecord;
  }

  public async patch(
    id: string,
    body: { jsonLd: JsonLdObject },
  ): Promise<PatchSchemaResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/schemas/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`PATCH /schemas/${id} falló con status ${res.status}`);
    }
    const record = (await res.json()) as SchemaRecord;
    return { status: res.status, record };
  }
}

// ----------------------------- Helpers internos -----------------------------

function introspect(jsonLd: JsonLdObject): FormField[] {
  const fields: FormField[] = [];
  for (const [key, value] of Object.entries(jsonLd)) {
    if (key === '@context' || key === '@type') {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields.push({
        path: key,
        label: humanize(key),
        type: inferType(key, value),
        required: false,
        value: stringifyValue(value),
      });
    }
  }
  return fields;
}

function getByPath(obj: JsonLdValue, path: string): JsonLdValue | undefined {
  let current: JsonLdValue | undefined = obj;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setByPath(obj: JsonLdObject, path: string, value: JsonLdValue): void {
  const parts = path.split('.');
  let current: { [key: string]: JsonLdValue } = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (part === undefined) {
      continue;
    }
    const next = current[part];
    if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      current = next;
    } else {
      const created: { [key: string]: JsonLdValue } = {};
      current[part] = created;
      current = created;
    }
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) {
    current[last] = value;
  }
}

function deleteByPath(obj: JsonLdObject, path: string): void {
  const parts = path.split('.');
  let current: { [key: string]: JsonLdValue } = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (part === undefined) {
      return;
    }
    const next = current[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return;
    }
    current = next;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) {
    delete current[last];
  }
}

function coerce(type: FormFieldType, value: string): JsonLdValue {
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

function stringifyValue(value: JsonLdValue | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function inferType(key: string, value: JsonLdValue): FormFieldType {
  const lower = key.toLowerCase();
  if (lower.includes('url') || lower.includes('image') || lower.includes('logo')) {
    return 'url';
  }
  if (lower.includes('date')) {
    return 'date';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  return 'text';
}

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function deepClone<T extends JsonLdValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
