// Tipos y catálogo de planes para el módulo de billing multi-tenant.
// Si src/shared/types/index.ts expone Tenant/PlanId, reexportar desde ahí en vez de duplicar.

export type PlanId = 'free' | 'starter' | 'pro' | 'business';

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** Price ID de Stripe. null para planes que no generan suscripción en Stripe (free). */
  readonly stripePriceId: string | null;
  readonly pagesPerMonth: number;
}

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

export interface TenantSubscription {
  tenantId: string;
  planId: PlanId;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus;
  pagesPerMonth: number;
  /** ISO-8601. Inicio del período de facturación vigente (clave de la ventana de uso). */
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

export interface UsageRecord {
  tenantId: string;
  periodStart: string;
  pagesScanned: number;
}

export interface SubscribeRequest {
  planId: PlanId;
}

export interface SubscribeResponse {
  tenantId: string;
  planId: PlanId;
  status: SubscriptionStatus;
  pagesPerMonth: number;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string;
}

export interface SubscriptionRepository {
  find(tenantId: string): Promise<TenantSubscription | null>;
  save(sub: TenantSubscription): Promise<TenantSubscription>;
}

export interface UsageRepository {
  find(tenantId: string, periodStart: string): Promise<UsageRecord | null>;
  /** Incrementa atómicamente el contador de páginas del período y devuelve el registro resultante. */
  increment(tenantId: string, periodStart: string): Promise<UsageRecord>;
}

/** Catálogo canónico de planes. Los pagesPerMonth definen el límite mensual por tenant. */
export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: { id: 'free', name: 'Free', stripePriceId: null, pagesPerMonth: 25 },
  starter: { id: 'starter', name: 'Starter', stripePriceId: 'price_starter', pagesPerMonth: 500 },
  pro: { id: 'pro', name: 'Pro', stripePriceId: 'price_pro', pagesPerMonth: 5000 },
  business: { id: 'business', name: 'Business', stripePriceId: 'price_business', pagesPerMonth: 50000 },
};

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLANS, value);
}
