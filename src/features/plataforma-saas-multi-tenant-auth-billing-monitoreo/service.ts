// Lógica de negocio de billing: alta de suscripción en Stripe y enforcement del
// límite de páginas/mes por tenant. Framework-agnóstico (los handlers HTTP viven en routes.ts).

import Stripe from 'stripe';
import {
  Plan,
  PlanId,
  PLANS,
  SubscribeResponse,
  SubscriptionRepository,
  SubscriptionStatus,
  TenantSubscription,
  UsageRecord,
  UsageRepository,
  isPlanId,
} from './types';

export class PlanNotFoundError extends Error {
  constructor(public readonly planId: string) {
    super(`Plan desconocido: ${planId}`);
    this.name = 'PlanNotFoundError';
  }
}

/** Se mapea a HTTP 402 Payment Required en la capa de rutas. */
export class PageLimitExceededError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`Límite mensual de ${limit} páginas superado para el tenant ${tenantId}`);
    this.name = 'PageLimitExceededError';
  }
}

function mapStripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'unpaid':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addOneMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
}

/**
 * Lee el período de facturación de la suscripción de Stripe de forma resiliente a la
 * versión de API (los campos current_period_* migraron a los items en versiones nuevas).
 * Cae a un período mensual calculado si no están presentes.
 */
function readPeriod(sub: Stripe.Subscription, now: Date): { start: Date; end: Date } {
  const raw = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const start = typeof raw.current_period_start === 'number'
    ? new Date(raw.current_period_start * 1000)
    : startOfMonthUtc(now);
  const end = typeof raw.current_period_end === 'number'
    ? new Date(raw.current_period_end * 1000)
    : addOneMonthUtc(start);
  return { start, end };
}

function isActiveStatus(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing';
}

export class BillingService {
  constructor(
    private readonly stripe: Stripe,
    private readonly subscriptions: SubscriptionRepository,
    private readonly usage: UsageRepository,
  ) {}

  getPlan(planId: PlanId): Plan {
    if (!isPlanId(planId)) {
      throw new PlanNotFoundError(planId);
    }
    return PLANS[planId];
  }

  private async ensureCustomer(
    existing: TenantSubscription | null,
    tenantId: string,
    tenantEmail: string,
  ): Promise<string> {
    if (existing && existing.stripeCustomerId) {
      return existing.stripeCustomerId;
    }
    const customer = await this.stripe.customers.create({
      email: tenantEmail,
      metadata: { tenantId },
    });
    return customer.id;
  }

  /**
   * AC: dado un plan seleccionado, crea la suscripción en Stripe y activa el límite
   * de páginas/mes correspondiente. Idempotente por tenant: reemplaza la suscripción
   * de pago previa si el tenant cambia de plan.
   */
  async subscribe(tenantId: string, tenantEmail: string, planId: PlanId): Promise<SubscribeResponse> {
    const plan = this.getPlan(planId);
    const existing = await this.subscriptions.find(tenantId);
    const customerId = await this.ensureCustomer(existing, tenantId, tenantEmail);
    const now = new Date();

    let stripeSubscriptionId: string | null = null;
    let status: SubscriptionStatus = 'active';
    let periodStart: Date;
    let periodEnd: Date;

    if (plan.stripePriceId === null) {
      // Plan free: no se crea suscripción en Stripe, ventana mensual calendario.
      if (existing && existing.stripeSubscriptionId) {
        await this.stripe.subscriptions.cancel(existing.stripeSubscriptionId);
      }
      periodStart = startOfMonthUtc(now);
      periodEnd = addOneMonthUtc(periodStart);
    } else {
      if (existing && existing.stripeSubscriptionId) {
        await this.stripe.subscriptions.cancel(existing.stripeSubscriptionId);
      }
      const sub = await this.stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: plan.stripePriceId }],
        metadata: { tenantId, planId: plan.id },
      });
      stripeSubscriptionId = sub.id;
      status = mapStripeStatus(sub.status);
      const period = readPeriod(sub, now);
      periodStart = period.start;
      periodEnd = period.end;
    }

    const record: TenantSubscription = {
      tenantId,
      planId: plan.id,
      stripeCustomerId: customerId,
      stripeSubscriptionId,
      status,
      pagesPerMonth: plan.pagesPerMonth,
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
    };
    const saved = await this.subscriptions.save(record);

    return {
      tenantId: saved.tenantId,
      planId: saved.planId,
      status: saved.status,
      pagesPerMonth: saved.pagesPerMonth,
      stripeSubscriptionId: saved.stripeSubscriptionId,
      currentPeriodEnd: saved.currentPeriodEnd,
    };
  }

  /** Límite efectivo: si no hay suscripción activa, aplica el del plan free. */
  private effectiveLimit(sub: TenantSubscription | null): { limit: number; periodStart: string } {
    if (sub && isActiveStatus(sub.status)) {
      return { limit: sub.pagesPerMonth, periodStart: sub.currentPeriodStart };
    }
    return {
      limit: PLANS.free.pagesPerMonth,
      periodStart: startOfMonthUtc(new Date()).toISOString(),
    };
  }

  /**
   * AC: al superar el límite, la operación falla y la ruta responde 402.
   * Consume una página del cupo mensual; lanza PageLimitExceededError si ya se alcanzó.
   */
  async consumePageScan(tenantId: string): Promise<UsageRecord> {
    const sub = await this.subscriptions.find(tenantId);
    const { limit, periodStart } = this.effectiveLimit(sub);

    const current = await this.usage.find(tenantId, periodStart);
    const used = current ? current.pagesScanned : 0;
    if (used >= limit) {
      throw new PageLimitExceededError(tenantId, limit, used);
    }
    return this.usage.increment(tenantId, periodStart);
  }
}

// --- Implementaciones en memoria (útiles para tests e integración local) ---
// Reemplazar por adaptadores a la DB real (Postgres/Prisma) en producción.

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly store = new Map<string, TenantSubscription>();

  async find(tenantId: string): Promise<TenantSubscription | null> {
    return this.store.get(tenantId) ?? null;
  }

  async save(sub: TenantSubscription): Promise<TenantSubscription> {
    this.store.set(sub.tenantId, { ...sub });
    return { ...sub };
  }
}

export class InMemoryUsageRepository implements UsageRepository {
  private readonly store = new Map<string, UsageRecord>();

  private key(tenantId: string, periodStart: string): string {
    return `${tenantId}::${periodStart}`;
  }

  async find(tenantId: string, periodStart: string): Promise<UsageRecord | null> {
    return this.store.get(this.key(tenantId, periodStart)) ?? null;
  }

  async increment(tenantId: string, periodStart: string): Promise<UsageRecord> {
    const key = this.key(tenantId, periodStart);
    const prev = this.store.get(key);
    const next: UsageRecord = {
      tenantId,
      periodStart,
      pagesScanned: (prev ? prev.pagesScanned : 0) + 1,
    };
    this.store.set(key, next);
    return { ...next };
  }
}
