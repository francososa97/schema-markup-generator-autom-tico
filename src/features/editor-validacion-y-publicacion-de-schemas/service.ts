/**
 * E2-T2 — Servicio de validacion contra Google Rich Results (BullMQ).
 *
 * Expone SchemaValidationService, que encola un job por schema, espera el
 * resultado hasta 15s y lo devuelve. El procesamiento corre en un Worker de
 * BullMQ con attempts: 3; si el job agota los 3 intentos, el schema se marca
 * como 'validation_failed' via el listener 'failed'.
 *
 * La persistencia se abstrae en SchemaRepository para no acoplar la feature
 * a una implementacion concreta de base de datos.
 */
import { Queue, Worker, QueueEvents } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { validateAgainstRichResults } from './validator';
import type { JsonLd, ValidationResult } from './validator';

export const VALIDATION_QUEUE_NAME = 'schema-validation';
export const MAX_VALIDATION_ATTEMPTS = 3;
export const VALIDATION_TIMEOUT_MS = 15_000;

export type SchemaStatus =
  | 'draft'
  | 'published'
  | 'validating'
  | 'validated'
  | 'validation_failed';

export interface SchemaRecord {
  readonly id: string;
  readonly jsonLd: JsonLd;
  readonly status: SchemaStatus;
}

/** Puerto de persistencia que debe implementar el caller (Prisma, TypeORM, etc.). */
export interface SchemaRepository {
  findById(id: string): Promise<SchemaRecord | null>;
  saveValidationResult(id: string, result: ValidationResult): Promise<void>;
  markValidationFailed(id: string, reason: string): Promise<void>;
}

export interface ValidationJobData {
  readonly schemaId: string;
}

export class SchemaNotFoundError extends Error {
  constructor(public readonly schemaId: string) {
    super('Schema ' + schemaId + ' no encontrado');
    this.name = 'SchemaNotFoundError';
  }
}

export class ValidationTimeoutError extends Error {
  constructor(public readonly schemaId: string, public readonly timeoutMs: number) {
    super('La validacion del schema ' + schemaId + ' supero ' + timeoutMs + 'ms');
    this.name = 'ValidationTimeoutError';
  }
}

const nowIso = (): string => new Date().toISOString();
const now = (): number => Date.now();

export class SchemaValidationService {
  private readonly queue: Queue<ValidationJobData, ValidationResult>;
  private readonly queueEvents: QueueEvents;
  private readonly worker: Worker<ValidationJobData, ValidationResult>;

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly repository: SchemaRepository,
  ) {
    this.queue = new Queue<ValidationJobData, ValidationResult>(VALIDATION_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: MAX_VALIDATION_ATTEMPTS,
        backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    this.queueEvents = new QueueEvents(VALIDATION_QUEUE_NAME, { connection });
    this.worker = new Worker<ValidationJobData, ValidationResult>(
      VALIDATION_QUEUE_NAME,
      (job): Promise<ValidationResult> => this.process(job),
      { connection },
    );
    this.registerFailureHandler();
  }

  /** Procesa un job: carga el schema, lo valida y persiste el resultado. */
  private async process(job: Job<ValidationJobData, ValidationResult>): Promise<ValidationResult> {
    const { schemaId } = job.data;
    const schema = await this.repository.findById(schemaId);
    if (schema === null) {
      throw new SchemaNotFoundError(schemaId);
    }
    const startedAt = now();
    const result = validateAgainstRichResults(schema.jsonLd, nowIso(), now() - startedAt);
    await this.repository.saveValidationResult(schemaId, result);
    return result;
  }

  /**
   * Cuando un job agota los 3 intentos, BullMQ emite 'failed' con
   * attemptsMade === MAX_VALIDATION_ATTEMPTS; recien ahi marcamos el schema
   * como 'validation_failed' (los reintentos intermedios no lo marcan).
   */
  private registerFailureHandler(): void {
    this.worker.on('failed', (job, err): void => {
      if (job === undefined) return;
      if (job.attemptsMade >= MAX_VALIDATION_ATTEMPTS) {
        void this.repository.markValidationFailed(job.data.schemaId, err.message);
      }
    });
  }

  /** Encola una validacion sin esperar el resultado (fire-and-forget). */
  async enqueueValidation(schemaId: string): Promise<string> {
    const job = await this.queue.add('validate', { schemaId });
    return job.id ?? '';
  }

  /**
   * Encola la validacion y espera el resultado hasta timeoutMs (default 15s).
   * @throws SchemaNotFoundError si el schema no existe.
   * @throws ValidationTimeoutError si no termina dentro del timeout.
   * @throws Error si el job fallo tras los 3 intentos (schema ya marcado).
   */
  async validateNow(
    schemaId: string,
    timeoutMs: number = VALIDATION_TIMEOUT_MS,
  ): Promise<ValidationResult> {
    const job = await this.queue.add('validate', { schemaId });
    try {
      return await job.waitUntilFinished(this.queueEvents, timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      if (lower.includes('timed out') || lower.includes('timeout')) {
        throw new ValidationTimeoutError(schemaId, timeoutMs);
      }
      if (message.includes('no encontrado')) {
        throw new SchemaNotFoundError(schemaId);
      }
      // El worker ya marco el schema como 'validation_failed' en el 3er intento.
      throw new Error('La validacion del schema ' + schemaId + ' fallo: ' + message);
    }
  }

  /** Cierra worker, eventos y cola. Llamar en el shutdown de la app. */
  async close(): Promise<void> {
    await this.worker.close();
    await this.queueEvents.close();
    await this.queue.close();
  }
}
