/**
 * E2-T2 — Ruta HTTP de validacion contra Google Rich Results.
 *
 * POST /schemas/:id/validate -> 200 con { status, valid, errors, warnings, ... }
 * Mapea los errores de dominio a codigos HTTP:
 *   - SchemaNotFoundError    -> 404
 *   - ValidationTimeoutError -> 504
 *   - cualquier otro fallo   -> 500
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  SchemaValidationService,
  SchemaNotFoundError,
  ValidationTimeoutError,
} from './service';

export const createSchemaValidationRouter = (
  service: SchemaValidationService,
): Router => {
  const router = Router();

  router.post(
    '/schemas/:id/validate',
    async (req: Request, res: Response): Promise<void> => {
      const schemaId = req.params.id;
      if (typeof schemaId !== 'string' || schemaId.trim().length === 0) {
        res.status(400).json({ error: 'schema id invalido' });
        return;
      }

      try {
        const result = await service.validateNow(schemaId);
        res.status(200).json({ schemaId, ...result });
      } catch (err) {
        if (err instanceof SchemaNotFoundError) {
          res.status(404).json({ error: err.message, schemaId });
          return;
        }
        if (err instanceof ValidationTimeoutError) {
          res.status(504).json({ error: err.message, schemaId, status: 'timeout' });
          return;
        }
        const detail = err instanceof Error ? err.message : 'error desconocido';
        res.status(500).json({ error: 'La validacion fallo', detail, schemaId });
      }
    },
  );

  return router;
};
