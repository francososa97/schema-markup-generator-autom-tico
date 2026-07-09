/**
 * Registro de definiciones schema.org y utilidades de construccion/validacion
 * usadas por el generador de JSON-LD. E1-T3.
 */

import type { ExtractedFields, SupportedSchemaType } from './types';

/** Firma de un constructor de propiedades JSON-LD para un tipo. */
export type BuildFn = (fields: ExtractedFields, allowed: readonly string[]) => Record<string, unknown>;

/** Definicion de un tipo schema.org soportado. */
export interface SchemaDefinition {
  /** Valor de @type en el JSON-LD generado. */
  readonly type: SupportedSchemaType;
  /** Campos obligatorios: si falta alguno se responde 422. */
  readonly requiredFields: readonly string[];
  /** Campos opcionales admitidos que se copian si estan presentes. */
  readonly optionalFields: readonly string[];
  /** Construye las propiedades JSON-LD (sin @context / @type). */
  readonly build?: BuildFn;
}

/** Indica si un valor debe considerarse ausente para validacion/copia. */
export function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

/** Envuelve un valor en un nodo tipado (p. ej. Person/Organization/Brand). */
function namedNode(nodeType: string, value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return { '@type': nodeType, ...value };
  }
  return { '@type': nodeType, name: readString(value) };
}

/** Lista completa de campos admitidos (obligatorios + opcionales). */
export function getAllowedFields(definition: SchemaDefinition): readonly string[] {
  return [...definition.requiredFields, ...definition.optionalFields];
}

/** Copia los campos permitidos que esten presentes y no vacios. */
export function copyKnown(fields: ExtractedFields, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = fields[key];
    if (!isEmpty(value)) {
      out[key] = value;
    }
  }
  return out;
}

const buildArticle: BuildFn = (fields, allowed) => {
  const base = copyKnown(fields, allowed);
  if (!isEmpty(fields.author)) {
    base.author = namedNode('Person', fields.author);
  }
  if (!isEmpty(fields.publisher)) {
    base.publisher = namedNode('Organization', fields.publisher);
  }
  return base;
};

const buildProduct: BuildFn = (fields, allowed) => {
  const base = copyKnown(fields, allowed);
  if (!isEmpty(fields.brand)) {
    base.brand = namedNode('Brand', fields.brand);
  }
  if (!isEmpty(fields.price)) {
    const offer: Record<string, unknown> = {
      '@type': 'Offer',
      price: readString(fields.price),
      priceCurrency: isEmpty(fields.priceCurrency) ? 'USD' : readString(fields.priceCurrency),
    };
    if (!isEmpty(fields.availability)) {
      offer.availability = fields.availability;
    }
    base.offers = offer;
  }
  delete base.price;
  delete base.priceCurrency;
  delete base.availability;
  return base;
};

const buildRecipe: BuildFn = (fields, allowed) => {
  const base = copyKnown(fields, allowed);
  if (!isEmpty(fields.author)) {
    base.author = namedNode('Person', fields.author);
  }
  return base;
};

const buildFaqPage: BuildFn = (fields) => ({
  mainEntity: toRecordArray(fields.questions).map((q) => ({
    '@type': 'Question',
    name: readString(q.question ?? q.name),
    acceptedAnswer: {
      '@type': 'Answer',
      text: readString(q.answer ?? q.text),
    },
  })),
});

const buildBreadcrumb: BuildFn = (fields) => ({
  itemListElement: toRecordArray(fields.itemListElement).map((item, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: readString(item.name),
    item: readString(item.url ?? item.item),
  })),
});

const ARTICLE_OPTIONAL: readonly string[] = [
  'description',
  'image',
  'dateModified',
  'publisher',
  'mainEntityOfPage',
  'articleBody',
];

/** Definiciones indexadas por tipo schema.org. */
export const SCHEMA_REGISTRY: Readonly<Record<SupportedSchemaType, SchemaDefinition>> = {
  Article: {
    type: 'Article',
    requiredFields: ['headline', 'author', 'datePublished'],
    optionalFields: ARTICLE_OPTIONAL,
    build: buildArticle,
  },
  NewsArticle: {
    type: 'NewsArticle',
    requiredFields: ['headline', 'author', 'datePublished'],
    optionalFields: ARTICLE_OPTIONAL,
    build: buildArticle,
  },
  BlogPosting: {
    type: 'BlogPosting',
    requiredFields: ['headline', 'author', 'datePublished'],
    optionalFields: ARTICLE_OPTIONAL,
    build: buildArticle,
  },
  Product: {
    type: 'Product',
    requiredFields: ['name'],
    optionalFields: ['description', 'image', 'sku', 'brand', 'price', 'priceCurrency', 'availability', 'aggregateRating'],
    build: buildProduct,
  },
  FAQPage: {
    type: 'FAQPage',
    requiredFields: ['questions'],
    optionalFields: [],
    build: buildFaqPage,
  },
  Recipe: {
    type: 'Recipe',
    requiredFields: ['name', 'recipeIngredient', 'recipeInstructions'],
    optionalFields: ['image', 'author', 'description', 'prepTime', 'cookTime', 'totalTime', 'recipeYield', 'nutrition', 'datePublished'],
    build: buildRecipe,
  },
  Organization: {
    type: 'Organization',
    requiredFields: ['name', 'url'],
    optionalFields: ['logo', 'sameAs', 'description', 'email', 'telephone'],
  },
  LocalBusiness: {
    type: 'LocalBusiness',
    requiredFields: ['name', 'address'],
    optionalFields: ['telephone', 'openingHours', 'priceRange', 'image', 'url', 'geo'],
  },
  Event: {
    type: 'Event',
    requiredFields: ['name', 'startDate', 'location'],
    optionalFields: ['endDate', 'description', 'image', 'eventStatus', 'performer', 'organizer'],
  },
  BreadcrumbList: {
    type: 'BreadcrumbList',
    requiredFields: ['itemListElement'],
    optionalFields: [],
    build: buildBreadcrumb,
  },
};
