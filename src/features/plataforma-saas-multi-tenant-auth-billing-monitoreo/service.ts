import { createHash } from 'node:crypto';
import type {
  ChangeComparison,
  Clock,
  IdGenerator,
  MonitorJobData,
  MonitoredPageStore,
  Notification,
  NotificationStore,
  PageCrawler,
  PageId,
  PageSnapshot,
  SnapshotStore,
  TenantId,
} from './types.js';

/**
 * Umbral por defecto: se considera "cambio relevante" si el contenido
 * normalizado difiere en su hash Y la magnitud de cambio supera este valor.
 * Evita alertar por micro-cambios (timestamps, contadores de visitas, etc.).
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.02;

export interface MonitoringServiceDeps {
  crawler: PageCrawler;
  snapshots: SnapshotStore;
  notifications: NotificationStore;
  pages: MonitoredPageStore;
  clock: Clock;
  ids: IdGenerator;
  relevanceThreshold?: number;
}

export interface ProcessResult {
  status: 'skipped_inactive' | 'first_snapshot' | 'no_change' | 'change_notified';
  comparison?: ChangeComparison;
  notificationId?: string;
}

/**
 * Núcleo de E3-T3. Sin acoplar a BullMQ ni a Express: recibe puertos e
 * implementa la lógica de crawl -> normalizar -> hashear -> comparar -> notificar.
 */
export class MonitoringService {
  private readonly threshold: number;

  constructor(private readonly deps: MonitoringServiceDeps) {
    this.threshold = deps.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  }

  /**
   * Extrae el contenido textual relevante del HTML y lo normaliza para que la
   * comparación sea estable frente a diferencias de whitespace/markup irrelevante.
   * Nota: extractor liviano sin dependencias; para producción se puede sustituir
   * por cheerio/readability manteniendo la misma firma.
   */
  static normalizeContent(html: string): string {
    const withoutScripts = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
    const decoded = withoutTags
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
    return decoded.replace(/\s+/g, ' ').trim();
  }

  static hashContent(normalized: string): string {
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  /**
   * Compara el contenido nuevo contra el último snapshot.
   * magnitude = |len_actual - len_previo| / max(len_previo, len_actual, 1).
   */
  compare(previous: PageSnapshot | null, currentHash: string, currentLength: number): ChangeComparison {
    if (previous === null) {
      return { changed: true, magnitude: 1, previousHash: null, currentHash };
    }
    if (previous.contentHash === currentHash) {
      return { changed: false, magnitude: 0, previousHash: previous.contentHash, currentHash };
    }
    const denom = Math.max(previous.contentLength, currentLength, 1);
    const magnitude = Math.abs(currentLength - previous.contentLength) / denom;
    return { changed: true, magnitude, previousHash: previous.contentHash, currentHash };
  }

  /**
   * Punto de entrada invocado por el worker BullMQ una vez por corrida (cada 24hs).
   * Idempotente respecto al almacenamiento: siempre persiste el snapshot nuevo,
   * pero sólo genera notificación si el cambio supera el umbral de relevancia.
   */
  async processMonitoredPage(job: MonitorJobData): Promise<ProcessResult> {
    const page = await this.deps.pages.get(job.tenantId, job.pageId);
    if (page === null || !page.active) {
      return { status: 'skipped_inactive' };
    }

    const html = await this.deps.crawler.fetchHtml(page.url);
    const normalized = MonitoringService.normalizeContent(html);
    const currentHash = MonitoringService.hashContent(normalized);
    const currentLength = normalized.length;

    const previous = await this.deps.snapshots.getLatest(page.tenantId, page.id);
    const comparison = this.compare(previous, currentHash, currentLength);

    const nowIso = this.deps.clock.nowIso();
    const snapshot: PageSnapshot = {
      pageId: page.id,
      tenantId: page.tenantId,
      url: page.url,
      contentHash: currentHash,
      contentLength: currentLength,
      capturedAt: nowIso,
    };
    await this.deps.snapshots.put(snapshot);

    if (previous === null) {
      return { status: 'first_snapshot', comparison };
    }
    if (!comparison.changed) {
      return { status: 'no_change', comparison };
    }
    // Hash distinto pero cambio menor al umbral => no relevante.
    if (comparison.magnitude < this.threshold) {
      return { status: 'no_change', comparison };
    }

    const notification = this.buildNotification(page.tenantId, page.id, page.url, comparison, nowIso);
    await this.deps.notifications.create(notification);
    return { status: 'change_notified', comparison, notificationId: notification.id };
  }

  private buildNotification(
    tenantId: TenantId,
    pageId: PageId,
    url: string,
    comparison: ChangeComparison,
    createdAt: string,
  ): Notification {
    const pct = Math.round(comparison.magnitude * 100);
    return {
      id: this.deps.ids.next(),
      tenantId,
      type: 'page_change_detected',
      title: 'Cambio detectado en una página monitoreada',
      body: `Detectamos un cambio (~${pct}%) en ${url}. Revisá si conviene regenerar el schema markup.`,
      data: {
        pageId,
        url,
        previousHash: comparison.previousHash ?? '',
        currentHash: comparison.currentHash,
      },
      read: false,
      createdAt,
    };
  }
}
