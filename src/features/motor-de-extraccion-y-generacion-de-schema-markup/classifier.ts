// Cliente de clasificación vía LLM (Anthropic SDK).
// Usa tool-use para forzar salida estructurada y obtener un confidence score confiable.

import Anthropic from '@anthropic-ai/sdk';
import {
  ClassificationAttempt,
  ClassificationError,
  ClassifierConfig,
  ClassifierModel,
  PageContent,
  StructuredFields,
  SUPPORTED_SCHEMA_TYPES,
  SchemaOrgType,
} from './types';

const CLASSIFY_TOOL_NAME = 'emit_classification';

const SYSTEM_PROMPT = [
  'Sos un experto en SEO técnico y en el vocabulario schema.org.',
  'Recibís el contenido ya extraído de una página web y debés:',
  '1) Clasificar la página en UN único tipo de schema.org de la lista permitida.',
  '2) Extraer los campos estructurados relevantes para ese tipo, usando los',
  '   nombres de propiedad exactos de schema.org (p.ej. headline, author, datePublished,',
  '   name, offers, price, priceCurrency, mainEntity, recipeIngredient, etc.).',
  '3) Reportar un confidence score honesto en [0,1]: alto solo si la evidencia es clara.',
  'No inventes datos que no estén presentes en el contenido. Si un campo no está,',
  'omitilo en lugar de rellenarlo. Respondé exclusivamente llamando a la herramienta.',
].join('\n');

/** Construye el JSON Schema de la herramienta de salida estructurada. */
function buildClassifyTool(): Anthropic.Tool {
  return {
    name: CLASSIFY_TOOL_NAME,
    description:
      'Emite la clasificación schema.org de la página y sus campos estructurados extraídos.',
    input_schema: {
      type: 'object',
      properties: {
        schemaType: {
          type: 'string',
          enum: [...SUPPORTED_SCHEMA_TYPES],
          description: 'Tipo schema.org más apropiado para la página.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confianza de la clasificación en [0,1].',
        },
        fields: {
          type: 'object',
          description:
            'Campos estructurados extraídos, con claves = propiedades schema.org.',
          additionalProperties: true,
        },
      },
      required: ['schemaType', 'confidence', 'fields'],
      additionalProperties: false,
    },
  };
}

/** Serializa el contenido de la página al mensaje de usuario. */
function buildUserMessage(page: PageContent): string {
  const parts: string[] = [];
  if (page.url) parts.push(`URL: ${page.url}`);
  if (page.title) parts.push(`Título: ${page.title}`);
  if (page.metaDescription) parts.push(`Meta description: ${page.metaDescription}`);
  if (page.headings && page.headings.length > 0) {
    parts.push(`Encabezados:\n- ${page.headings.join('\n- ')}`);
  }
  parts.push(`Contenido principal:\n${page.bodyText}`);
  return parts.join('\n\n');
}

function isSupportedType(value: string): value is SchemaOrgType {
  return (SUPPORTED_SCHEMA_TYPES as readonly string[]).includes(value);
}

interface RawToolInput {
  schemaType: unknown;
  confidence: unknown;
  fields: unknown;
}

/** Valida y normaliza el input crudo del tool_use. */
function parseToolInput(input: unknown, model: ClassifierModel): ClassificationAttempt {
  const raw = input as RawToolInput;

  if (typeof raw.schemaType !== 'string' || !isSupportedType(raw.schemaType)) {
    throw new ClassificationError(
      'invalid_llm_output',
      `El modelo devolvió un schemaType no soportado: ${String(raw.schemaType)}`,
      502,
    );
  }

  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 0;

  const fields: StructuredFields =
    raw.fields !== null && typeof raw.fields === 'object' && !Array.isArray(raw.fields)
      ? (raw.fields as StructuredFields)
      : {};

  return { schemaType: raw.schemaType, confidence, fields, model };
}

export class SchemaClassifier {
  private readonly client: Anthropic;
  private readonly config: ClassifierConfig;
  private readonly tool: Anthropic.Tool;

  constructor(config: ClassifierConfig, client?: Anthropic) {
    this.config = config;
    this.client = client ?? new Anthropic({ apiKey: config.apiKey });
    this.tool = buildClassifyTool();
  }

  private modelId(model: ClassifierModel): string {
    return model === 'haiku' ? this.config.haikuModel : this.config.sonnetModel;
  }

  /** Ejecuta una única clasificación con el modelo indicado. */
  public async classifyWith(
    page: PageContent,
    model: ClassifierModel,
  ): Promise<ClassificationAttempt> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.modelId(model),
        max_tokens: this.config.maxTokens,
        system: SYSTEM_PROMPT,
        tools: [this.tool],
        tool_choice: { type: 'tool', name: CLASSIFY_TOOL_NAME },
        messages: [{ role: 'user', content: buildUserMessage(page) }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ClassificationError(
        'llm_request_failed',
        `Falló la llamada al modelo (${model}): ${message}`,
        502,
      );
    }

    const toolBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === 'tool_use' && block.name === CLASSIFY_TOOL_NAME,
    );

    if (!toolBlock) {
      throw new ClassificationError(
        'invalid_llm_output',
        `El modelo (${model}) no devolvió una llamada a ${CLASSIFY_TOOL_NAME}.`,
        502,
      );
    }

    return parseToolInput(toolBlock.input, model);
  }
}
