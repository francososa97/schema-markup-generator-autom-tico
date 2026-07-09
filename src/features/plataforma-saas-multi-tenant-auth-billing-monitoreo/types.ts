// Tipos de dominio para el monitoreo recurrente de páginas (E3-T3).
// Se definen aquí porque src/shared/types/index.ts todavía no existe en el repo;
// cuando exista, mover PageId/TenantId/etc. allí y reexportarlos.

export type TenantId = string;
export type PageId = string;
export type NotificationId = string;

/** Página que un tenant marcó para monitoreo recurrente. */
export interface MonitoredPage {
  id: PageId;
  tenantId: TenantId;
  url: string;
  /** Si false, el worker la ignora sin borrar el schedule. */
  active: boolean;
}

/** Snapshot persistido en S3/R2 del contenido relevante de una página. */
export interface PageSnapshot {
  pageId: PageId;
  tenantId: TenantId;
  url: string;
  /** SHA-256 del contenido normalizado; base de la comparación. */
  contentHash: string;
  /** Longitud del contenido normalizado, para heurística de cambio relevante. */
  contentLength: number;
  /** ISO-8601. */
  capturedAt: string;
}

export type NotificationType = 'page_change_detected';

export interface Notification {
  id: NotificationId;
  tenantId: TenantId;
  type: NotificationType;
  title: string;
  body: string;
  /** Metadatos tipados para render in-app / deep-link. */
  data: {
    pageId: PageId;
    url: string;
    previousHash: string;
    currentHash: string;
  };
  read: boolean;
  createdAt: string;
}

/** Resultado de comparar el crawl nuevo contra el último snapshot. */
export interface ChangeComparison {
  changed: boolean;
  /** Fracción de cambio [0,1] usada como umbral de relevancia. */
  magnitude: number;
  previousHash: string | null;
  currentHash: string;
}

/** Payload del job BullMQ. */
export interface MonitorJobData {
  pageId: PageId;
  tenantId: TenantId;
}

// --- Puertos (dependency inversion, ver ARCHITECTURE.md convención hexagonal) ---

export interface PageCrawler {
  /** Descarga la página y devuelve el HTML crudo. Lanza si falla la red. */
  fetchHtml(url: string): Promise<string>;
}

export interface SnapshotStore {
  /** Último snapshot o null si es la primera vez que se monitorea. */
  getLatest(tenantId: TenantId, pageId: PageId): Promise<PageSnapshot | null>;
  put(snapshot: PageSnapshot): Promise<void>;
}

export interface NotificationStore {
  create(notification: Notification): Promise<void>;
  listByTenant(tenantId: TenantId): Promise<Notification[]>;
}

export interface MonitoredPageStore {
  get(tenantId: TenantId, pageId: PageId): Promise<MonitoredPage | null>;
  listActive(): Promise<MonitoredPage[]>;
}

/** Genera ids y timestamps; inyectable para tests deterministas. */
export interface Clock {
  nowIso(): string;
}

export interface IdGenerator {
  next(): string;
}
