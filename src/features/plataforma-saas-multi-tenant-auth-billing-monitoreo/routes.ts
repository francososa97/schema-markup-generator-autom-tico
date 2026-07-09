// Rutas HTTP (Express) del módulo de billing.
// - POST /billing/subscribe -> crea suscripción en Stripe y activa el límite (200).
// - POST /pages/scan -> protegido por enforcePageLimit; devuelve 402 al superar el cupo.

import { NextFunction, Request, Response, Router } from 'express';
import {
  BillingService,
  PageLimitExceededError,
  PlanNotFoundError,
} from './service';
import { SubscribeRequest, UsageRecord, isPlanId } from './types';

/** El middleware de auth/tenant debe poblar req.tenant aguas arriba. */
export interface TenantContext {
  id: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  tenant?: TenantContext;
  pageUsage?: UsageRecord;
}

function getTenant(req: Request, res: Response): TenantContext | null {
  const tenant = (req as AuthenticatedRequest).tenant;
  if (!tenant) {
    res.status(401).json({ error: 'unauthenticated', message: 'Tenant no autenticado' });
    return null;
  }
  return tenant;
}

/**
 * Guard de cupo mensual. Consume una página del plan del tenant y, si el cupo está
 * agotado, corta la cadena con 402 Payment Required.
 */
export function enforcePageLimit(billing: BillingService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenant = getTenant(req, res);
    if (!tenant) {
      return;
    }
    try {
      const usage = await billing.consumePageScan(tenant.id);
      (req as AuthenticatedRequest).pageUsage = usage;
      next();
    } catch (err) {
      if (err instanceof PageLimitExceededError) {
        res.status(402).json({
          error: 'Payment Required',
          message: err.message,
          limit: err.limit,
          used: err.used,
        });
        return;
      }
      next(err);
    }
  };
}

export function createBillingRouter(billing: BillingService): Router {
  const router = Router();

  router.post('/billing/subscribe', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenant = getTenant(req, res);
    if (!tenant) {
      return;
    }
    const body = req.body as Partial<SubscribeRequest> | undefined;
    if (!body || !isPlanId(body.planId)) {
      res.status(400).json({ error: 'invalid_request', message: 'planId requerido y válido' });
      return;
    }
    try {
      const result = await billing.subscribe(tenant.id, tenant.email, body.planId);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PlanNotFoundError) {
        res.status(400).json({ error: 'invalid_plan', message: err.message });
        return;
      }
      next(err);
    }
  });

  // La ruta protegida: enforcePageLimit corre ANTES del handler de escaneo real.
  // El scan concreto pertenece a otra épica; aquí sólo se confirma el consumo del cupo.
  router.post('/pages/scan', enforcePageLimit(billing), (req: Request, res: Response): void => {
    const usage = (req as AuthenticatedRequest).pageUsage;
    res.status(200).json({
      ok: true,
      pagesScannedThisPeriod: usage ? usage.pagesScanned : 0,
    });
  });

  return router;
}
