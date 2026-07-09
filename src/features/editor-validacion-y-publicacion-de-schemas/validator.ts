/**
 * E2-T2 — Validacion contra Google Rich Results
 *
 * Validador puro (sin side-effects) de JSON-LD contra los requisitos de
 * Google Rich Results. No depende de la red: replica las reglas de
 * required/recommended properties que publica Google para los tipos de
 * schema soportados, de modo que el resultado sea determinista y testeable.
 *
 * NOTA: cuando exista src/shared/types/index.ts, ValidationResult /
 * ValidationIssue deberian moverse alli y reexportarse desde este modulo.
 */

/** Nodo JSON-LD: un objeto o un grafo (@graph) de objetos. */
export type JsonLdNode = Record<string, unknown>;
export type JsonLd = JsonLdNode | JsonLdNode[];

export type ValidationSeverity = 'error' | 'warning';

/** Estado agregado de una validacion. */
export type ValidationStatus = 'valid' | 'warnings' | 'errors';

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  /** Tipo de schema al que aplica la observacion (null si es estructural). */
  readonly schemaType: string | null;
  /** Propiedad afectada (null si es un problema del nodo completo). */
  readonly property: string | null;
  readonly message: string;
}

export interface ValidationResult {
  readonly status: ValidationStatus;
  readonly valid: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  /** Tipos de schema detectados en el documento. */
  readonly detectedTypes: readonly string[];
  /** ISO-8601 del momento en que se corrio la validacion. */
  readonly validatedAt: string;
  readonly durationMs: number;
}

interface TypeRule {
  /** Propiedades sin las cuales Google NO muestra el rich result -> error. */
  readonly required: readonly string[];
  /** Propiedades que Google recomienda -> warning si faltan. */
  readonly recommended: readonly string[];
  /**
   * Validacion especifica del tipo (ej: estructura de FAQPage.mainEntity).
   * Devuelve issues adicionales.
   */
  readonly custom?: (node: JsonLdNode, type: string) => ValidationIssue[];
}

const issue = (
  severity: ValidationSeverity,
  schemaType: string | null,
  property: string | null,
  message: string,
): ValidationIssue => ({ severity, schemaType, property, message });

const hasValue = (node: JsonLdNode, prop: string): boolean => {
  const value = node[prop];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

/**
 * Reglas por tipo derivadas de la documentacion de Google Search Central
 * (structured-data). Se cubren los tipos mas habituales del generador.
 */
const TYPE_RULES: Readonly<Record<string, TypeRule>> = {
  Article: {
    required: ['headline'],
    recommended: ['image', 'author', 'datePublished', 'dateModified', 'publisher'],
  },
  NewsArticle: {
    required: ['headline'],
    recommended: ['image', 'author', 'datePublished', 'dateModified', 'publisher'],
  },
  BlogPosting: {
    required: ['headline'],
    recommended: ['image', 'author', 'datePublished', 'dateModified', 'publisher'],
  },
  Product: {
    required: ['name'],
    recommended: ['image', 'description', 'sku', 'brand'],
    custom: (node, type): ValidationIssue[] => {
      const hasOffer = hasValue(node, 'offers');
      const hasReview = hasValue(node, 'review');
      const hasRating = hasValue(node, 'aggregateRating');
      if (!hasOffer && !hasReview && !hasRating) {
        return [
          issue(
            'error',
            type,
            'offers',
            'Product requiere al menos una de: offers, review o aggregateRating para calificar como rich result.',
          ),
        ];
      }
      return [];
    },
  },
  FAQPage: {
    required: ['mainEntity'],
    recommended: [],
    custom: (node, type): ValidationIssue[] => {
      const out: ValidationIssue[] = [];
      const raw = node['mainEntity'];
      const entities = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
      if (entities.length === 0) {
        out.push(issue('error', type, 'mainEntity', 'FAQPage debe contener al menos una Question en mainEntity.'));
        return out;
      }
      entities.forEach((entity, index): void => {
        const path = 'mainEntity[' + index + ']';
        if (typeof entity !== 'object' || entity === null) {
          out.push(issue('error', type, path, 'Cada mainEntity debe ser un objeto Question.'));
          return;
        }
        const q = entity as JsonLdNode;
        if (!hasValue(q, 'name')) {
          out.push(issue('error', type, path + '.name', 'Question requiere la propiedad name (el texto de la pregunta).'));
        }
        const answer = q['acceptedAnswer'];
        if (typeof answer !== 'object' || answer === null || !hasValue(answer as JsonLdNode, 'text')) {
          out.push(issue('error', type, path + '.acceptedAnswer', 'Question requiere acceptedAnswer con la propiedad text.'));
        }
      });
      return out;
    },
  },
  Recipe: {
    required: ['name', 'image'],
    recommended: ['recipeIngredient', 'recipeInstructions', 'author', 'datePublished', 'aggregateRating'],
  },
  BreadcrumbList: {
    required: ['itemListElement'],
    recommended: [],
  },
  Event: {
    required: ['name', 'startDate', 'location'],
    recommended: ['endDate', 'description', 'image', 'offers'],
  },
  VideoObject: {
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    recommended: ['description', 'duration', 'contentUrl'],
  },
  LocalBusiness: {
    required: ['name', 'address'],
    recommended: ['telephone', 'openingHours', 'image', 'priceRange', 'geo'],
  },
  Organization: {
    required: ['name'],
    recommended: ['logo', 'url', 'sameAs'],
  },
};

/** Normaliza @type que puede ser string o array de strings. */
const typesOf = (node: JsonLdNode): string[] => {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
};

/** Aplana un documento JSON-LD a la lista de nodos con @type. */
const flattenNodes = (doc: JsonLd): JsonLdNode[] => {
  const roots = Array.isArray(doc) ? doc : [doc];
  const nodes: JsonLdNode[] = [];
  for (const root of roots) {
    if (typeof root !== 'object' || root === null) continue;
    const graph = root['@graph'];
    if (Array.isArray(graph)) {
      for (const g of graph) {
        if (typeof g === 'object' && g !== null) nodes.push(g as JsonLdNode);
      }
    } else {
      nodes.push(root);
    }
  }
  return nodes;
};

const validateNode = (node: JsonLdNode): { issues: ValidationIssue[]; types: string[] } => {
  const issues: ValidationIssue[] = [];
  const types = typesOf(node);

  if (!hasValue(node, '@context')) {
    issues.push(issue('error', null, '@context', 'Falta @context. Google requiere https://schema.org como contexto del JSON-LD.'));
  }

  if (types.length === 0) {
    issues.push(issue('error', null, '@type', 'El nodo no declara @type; Google no puede clasificar el structured data.'));
    return { issues, types };
  }

  for (const type of types) {
    const rule = TYPE_RULES[type];
    if (rule === undefined) {
      issues.push(issue('warning', type, null, 'Tipo ' + type + ' no esta entre los rich results soportados por el validador; se omiten chequeos especificos.'));
      continue;
    }
    for (const prop of rule.required) {
      if (!hasValue(node, prop)) {
        issues.push(issue('error', type, prop, type + ' requiere la propiedad ' + prop + ' para generar un rich result valido.'));
      }
    }
    for (const prop of rule.recommended) {
      if (!hasValue(node, prop)) {
        issues.push(issue('warning', type, prop, type + ' recomienda la propiedad ' + prop + ' para mejorar la elegibilidad del rich result.'));
      }
    }
    if (rule.custom !== undefined) {
      issues.push(...rule.custom(node, type));
    }
  }

  return { issues, types };
};

/**
 * Valida un documento JSON-LD contra los requisitos de Google Rich Results.
 * Es una funcion pura: no lanza excepciones por contenido invalido, las
 * reporta como errores dentro del ValidationResult.
 *
 * @param jsonLd Documento ya parseado (objeto, array o @graph).
 * @param nowIso ISO-8601 inyectable para determinismo en tests.
 * @param durationMs Duracion medida por el caller (default 0).
 */
export const validateAgainstRichResults = (
  jsonLd: JsonLd,
  nowIso: string,
  durationMs = 0,
): ValidationResult => {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const detectedTypes = new Set<string>();

  const nodes = flattenNodes(jsonLd);
  if (nodes.length === 0) {
    errors.push(issue('error', null, null, 'El documento no contiene ningun nodo de structured data.'));
  }

  for (const node of nodes) {
    const { issues, types } = validateNode(node);
    for (const t of types) detectedTypes.add(t);
    for (const it of issues) {
      if (it.severity === 'error') errors.push(it);
      else warnings.push(it);
    }
  }

  const status: ValidationStatus =
    errors.length > 0 ? 'errors' : warnings.length > 0 ? 'warnings' : 'valid';

  return {
    status,
    valid: errors.length === 0,
    errors,
    warnings,
    detectedTypes: [...detectedTypes],
    validatedAt: nowIso,
    durationMs,
  };
};
