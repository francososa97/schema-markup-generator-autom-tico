import type {
  ExtractedFields,
  GenerateResult,
  GenerateSchemaRequest,
  JsonLdDocument,
  JsonLdValue,
} from './types';

/** Definición de un tipo schema.org soportado por el generador. */
interface SchemaTypeDefinition {
  readonly type: string;
  /** Propiedades obligatorias mínimas para que el markup sea considerado válido. */
  readonly requiredFields: readonly string[];
}

/**
 * Registro de tipos schema.org soportados y sus campos obligatorios.
 * Los campos obligatorios reflejan los mínimos exigidos por los Rich Results
 * de Google / la definición de schema.org para cada tipo.
 */
const SCHEMA_REGISTRY: Readonly<Record<string, SchemaTypeDefinition>> = {
  Article: {
    type: 'Article',
    requiredFields: ['headline', 'author', 'datePublished'],
  },
  NewsArticle: {
    type: 'NewsArticle',
    requiredFields: ['headline', 'author', 'datePublished'],
  },
  BlogPosting: {
    type: 'BlogPosting',
    requiredFields: ['headline', 'author', 'datePublished'],
  },
  Product: {
    type: 'Product',
    requiredFields: ['name', 'image', 'offers'],
  },
  FAQPage: {
    type: 'FAQPage',
    requiredFields: ['mainEntity'],
  },
  Recipe: {
    type: 'Recipe',
    requiredFields: ['name', 'image', 'recipeIngredient', 'recipeInstructions'],
  },
  Event: {
    type: 'Event',
    requiredFields: ['name', 'startDate', 'location'],
  },
  Organization: {
    type: 'Organization',
    requiredFields: ['name', 'url'],
  },
  LocalBusiness: {
    type: 'LocalBusiness',
    requiredFields: ['name', 'address'],
  },
  Person: {
    type: 'Person',
    requiredFields: ['name'],
  },
  BreadcrumbList: {
    type: 'BreadcrumbList',
    requiredFields: ['itemListElement'],
  },
  WebSite: {
    type: 'WebSite',
    requiredFields: ['name', 'url'],
  },
};

export const SUPPORTED_SCHEMA_TYPES: readonly string[] = Object.freeze(
  Object.keys(SCHEMA_REGISTRY),
);

/**
 * Un valor se considera "presente" si no es undefined/null, ni string vacío
 * (tras trim), ni array vacío. Así se evita generar markup con campos vacíos.
 */
function isFieldPresent(value: JsonLdValue | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

/** Devuelve solo los campos presentes, listos para inyectar en el JSON-LD. */
function pickPresentFields(fields: ExtractedFields): Record<string, JsonLdValue> {
  const result: Record<string, JsonLdValue> = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (isFieldPresent(value)) {
      result[key] = value as JsonLdValue;
    }
  }
  return result;
}

/**
 * Genera un documento JSON-LD validado contra la definición del tipo schema.org.
 *
 * - Tipo no soportado -> 422 UNSUPPORTED_TYPE.
 * - Faltan campos obligatorios -> 422 MISSING_REQUIRED_FIELDS con la lista.
 * - Caso feliz -> 200 con el JSON-LD sintácticamente válido.
 */
export function generateSchema(request: GenerateSchemaRequest): GenerateResult {
  const definition: SchemaTypeDefinition | undefined = SCHEMA_REGISTRY[request.type];

  if (definition === undefined) {
    return {
      ok: false,
      status: 422,
      code: 'UNSUPPORTED_TYPE',
      message:
        `Tipo schema.org no soportado: "${request.type}". ` +
        `Tipos soportados: ${SUPPORTED_SCHEMA_TYPES.join(', ')}.`,
      missingFields: [],
    };
  }

  const missingFields: string[] = definition.requiredFields.filter(
    (fieldName) => !isFieldPresent(request.fields[fieldName]),
  );

  if (missingFields.length > 0) {
    return {
      ok: false,
      status: 422,
      code: 'MISSING_REQUIRED_FIELDS',
      message:
        `Faltan campos obligatorios para el tipo "${definition.type}": ` +
        `${missingFields.join(', ')}.`,
      missingFields,
    };
  }

  const jsonLd: JsonLdDocument = {
    '@context': 'https://schema.org',
    '@type': definition.type,
    ...pickPresentFields(request.fields),
  };

  return { ok: true, status: 200, jsonLd };
}
