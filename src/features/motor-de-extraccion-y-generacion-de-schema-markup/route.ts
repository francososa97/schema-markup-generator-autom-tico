import { generateSchema } from './service';
import type {
  ExtractedFields,
  GenerateSchemaRequest,
  JsonLdValue,
} from './types';

/**
 * Interfaces HTTP mínimas y estructurales: compatibles con Express
 * (Request/Response) sin acoplar el módulo a @types/express.
 */
export interface HttpRequest {
  readonly body: unknown;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(payload: unknown): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Valida y normaliza el body crudo del request al contrato GenerateSchemaRequest.
 * Devuelve null si el payload es sintácticamente inválido (-> 400).
 */
function parseRequest(body: unknown): GenerateSchemaRequest | null {
  if (!isRecord(body)) {
    return null;
  }
  const { type, fields } = body;
  if (typeof type !== 'string' || type.trim().length === 0) {
    return null;
  }
  if (!isRecord(fields)) {
    return null;
  }
  // Los valores de fields ya fueron producidos por el motor de extracción
  // (JSON serializable); el generador se encarga de descartar vacíos/nulos.
  return {
    type: type.trim(),
    fields: fields as ExtractedFields as Readonly<Record<string, JsonLdValue>>,
  };
}

/**
 * Handler de POST /schemas/generate.
 *
 * 200 -> { jsonLd } válido.
 * 422 -> { code, message, missingFields } cuando faltan campos obligatorios
 *        o el tipo no está soportado.
 * 400 -> body malformado (no cumple el contrato { type, fields }).
 */
export function postGenerateSchema(req: HttpRequest, res: HttpResponse): unknown {
  const parsed = parseRequest(req.body);

  if (parsed === null) {
    return res.status(400).json({
      code: 'INVALID_REQUEST_BODY',
      message: 'El body debe tener la forma { type: string, fields: object }.',
    });
  }

  const result = generateSchema(parsed);

  if (result.ok) {
    return res.status(200).json({ jsonLd: result.jsonLd });
  }

  return res.status(422).json({
    code: result.code,
    message: result.message,
    missingFields: result.missingFields,
  });
}
