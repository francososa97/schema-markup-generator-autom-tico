import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { PutObjectCommand, GetObjectCommand, NoSuchKey, type S3Client } from '@aws-sdk/client-s3';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { MonitoringService } from './service.js';
import type {
  MonitorJobData,
  MonitoredPage,
  MonitoredPageStore,
  Notification,
  NotificationStore,
  PageId,
  PageSnapshot,
  SnapshotStore,
  TenantId,
} from './types.js';

export const MONITOR_QUEUE_NAME = 'page-monitoring';
/** 24hs en milisegundos: cadencia del re-crawl exigida por el AC. */
export const EVERY_24H_MS = 24 * 60 * 60 * 1000;

// --- Adaptador SnapshotStore sobre S3/R2 ---
// La clave incluye tenantId para aislamiento multi-tenant.
export class S3SnapshotStore implements SnapshotStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  private key(tenantId: TenantId, pageId: PageId): string {
    return `snapshots/${tenantId}/${pageId}/latest.json`;
  }

  async getLatest(tenantId: TenantId, pageId: PageId): Promise<PageSnapshot | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(tenantId, pageId) }),
      );
      const body = await res.Body?.transformToString();
      if (body === undefined || body.length === 0) {
        return null;
      }
      return JSON.parse(body) as PageSnapshot;
    } catch (err) {
      if (err instanceof NoSuchKey) {
        return null;
      }
      // R2 puede devolver un error genérico con name distinto ante key ausente.
      if (err instanceof Error && err.name === 'NoSuchKey') {
        return null;
      }
      throw err;
    }
  }

  async put(snapshot: PageSnapshot): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(snapshot.tenantId, snapshot.pageId),
        Body: JSON.stringify(snapshot),
        ContentType: 'application/json',
      }),
    );
  }
}

export interface MonitoringWorkerDeps {
  connection: ConnectionOptions;
  service: MonitoringService;
  pages: MonitoredPageStore;
}

/**
 * Crea la Queue de monitoreo. Se expone para poder encolar el schedule
 * recurrente por página desde el flujo que marca una página como monitoreada.
 */
export function createMonitorQueue(connection: ConnectionOptions): Queue<MonitorJobData> {
  return new Queue<MonitorJobData>(MONITOR_QUEUE_NAME, { connection });
}

/**
 * Registra (o actualiza) el job repetible cada 24hs para una página.
 * jobId estable => reprogramar no duplica schedules.
 */
export async function scheduleRecurringMonitor(
  queue: Queue<MonitorJobData>,
  page: Pick<MonitoredPage, 'id' | 'tenantId'>,
): Promise<void> {
  const jobId = `monitor:${page.tenantId}:${page.id}`;
  await queue.add(
    'monitor-page',
    { pageId: page.id, tenantId: page.tenantId },
    {
      jobId,
      repeat: { every: EVERY_24H_MS },
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  );
}

/** Elimina el schedule recurrente (al desmarcar una página). */
export async function unscheduleRecurringMonitor(
  queue: Queue<MonitorJobData>,
  page: Pick<MonitoredPage, 'id' | 'tenantId'>,
): Promise<void> {
  await queue.removeJobScheduler(`monitor:${page.tenantId}:${page.id}`);
}

/**
 * Arranca el Worker que procesa cada corrida del schedule.
 * Delega toda la lógica de negocio en MonitoringService (testeable sin Redis).
 */
export function startMonitorWorker(deps: MonitoringWorkerDeps): Worker<MonitorJobData> {
  return new Worker<MonitorJobData>(
    MONITOR_QUEUE_NAME,
    async (job: Job<MonitorJobData>) => {
      return deps.service.processMonitoredPage(job.data);
    },
    { connection: deps.connection, concurrency: 5 },
  );
}

// --- Endpoint in-app: GET /notifications ---
// El AC pide que la notificación sea visible vía GET /notifications con 200.
// El tenant se resuelve desde el contexto de auth (middleware previo).

interface AuthedRequest extends Request {
  tenant?: { id: TenantId };
}

export function createNotificationsRouter(store: NotificationStore): Router {
  const router = createRouter();

  router.get('/notifications', async (req: AuthedRequest, res: Response): Promise<void> => {
    const tenantId = req.tenant?.id;
    if (tenantId === undefined) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const notifications: Notification[] = await store.listByTenant(tenantId);
      res.status(200).json({ ok: true, notifications });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
      res.status(500).json({ ok: false, error: message });
    }
  });

  return router;
}
