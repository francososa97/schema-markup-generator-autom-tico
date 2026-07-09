// Service + handler HTTP para POST /pages/classify (E1-T2).
// Orquesta: valida entrada -> clasifica con Haiku -> escala a Sonnet si confidence < umbral.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SchemaClassifier } from './classifier';
import {
  ClassificationError,
  ClassificationResult,
  ClassifierConfig,
  PageContent,
} from './types';

/** Defaults del clasificador; overridables por config/env. */
const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_SONNET_MODEL = 'claude-sonnet-5';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_MAX_TOKENS = 1024;

export function resolveConfig(
  overrides: Partial<ClassifierConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): ClassifierConfig {
  const apiKey = overrides.apiKey ?? env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClassificationError(
      'missing_api_key',
      'Falta ANTHROPIC_API_KEY para el clasificador.',
      500,
    );
  }
  return {
    apiKey,
    haikuModel: overrides.haikuModel ?? env.CLASSIFIER_HAIKU_MODEL ?? DEFAULT_HAIKU_MODEL,
    sonnetModel:
      overrides.sonnetModel ?? env.CLASSIFIER_SONNET_MODEL ?? DEFAULT_SONNET_MODEL,
    confidenceThreshold:
      overrides.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    maxTokens: overrides.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/** Valida que el body sea un PageContent mínimamente utilizable. */
export function assertValidPageContent(body: unknown): asserts body is PageContent {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ClassificationError('invalid_body', 'El body debe ser un objeto JSON.', 400);
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.bodyText !== 'string' || candidate.bodyText.trim().length === 0) {
    throw new ClassificationError(
      'invalid_body',
      'El campo "bodyText" es obligatorio y no puede estar vacío.',
      400,
    );
  }
}

/**
 * Servicio de clasificación de páginas.
 * Contiene la lógica de fallback Haiku -> Sonnet basada en confidence.
 */
export class PageClassificationService {
  private readonly classifier: SchemaClassifier;
  private readonly threshold: number;

  constructor(config: ClassifierConfig, classifier?: SchemaClassifier) {
    this.classifier = classifier ?? new SchemaClassifier(config);
    this.threshold = config.confidenceThreshold;
  }

  /** Clasifica una página aplicando el fallback por baja confianza. */
  public async classify(page: PageContent): Promise<ClassificationResult> {
    const primary = await this.classifier.classifyWith(page, 'haiku');

    if (primary.confidence >= this.threshold) {
      return { ...primary, usedFallback: false };
    }

    const fallback = await this.classifier.classifyWith(page, 'sonnet');
    return { ...fallback, usedFallback: true };
  }
}

/* --------------------------------------------------------------------------
 * Handler HTTP framework-agnóstico (compatible con node:http y Express).
 * Espera un objeto tipo request con `.body` ya parseado (JSON middleware).
 * ------------------------------------------------------------------------ */

interface RequestLike {
  body?: unknown;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(payload: unknown): void;
}

let cachedService: PageClassificationService | null = null;

function getService(): PageClassificationService {
  if (!cachedService) {
    cachedService = new PageClassificationService(resolveConfig());
  }
  return cachedService;
}

/** Permite inyectar un service (tests) o resetear el singleton. */
export function setService(service: PageClassificationService | null): void {
  cachedService = service;
}

/** Handler estilo Express para POST /pages/classify. */
export async function classifyPageHandler(
  req: RequestLike,
  res: ResponseLike,
): Promise<void> {
  try {
    assertValidPageContent(req.body);
    const result = await getService().classify(req.body);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof ClassificationError) {
      res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Error desconocido';
    res.status(500).json({ error: { code: 'internal_error', message } });
  }
}

/**
 * Handler nativo node:http para montar sin framework.
 * Lee el body, lo parsea como JSON y delega en classifyPageHandler.
 */
export async function classifyPageNodeHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');

  const adapter: ResponseLike = {
    status(code: number): ResponseLike {
      res.statusCode = code;
      return adapter;
    },
    json(payload: unknown): void {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    },
  };

  let parsed: unknown;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
  } catch {
    adapter.status(400).json({
      error: { code: 'invalid_json', message: 'El body no es JSON válido.' },
    });
    return;
  }

  await classifyPageHandler({ body: parsed }, adapter);
}
