import { Router, type Request, type Response } from 'express';
import { CrawlerService } from './crawler.service';
import { CrawlerError } from './types';

interface ScanRequestBody {
  readonly url?: unknown;
}

/**
 * Router para el crawler de páginas (E1-T1).
 * Expone POST /pages/scan.
 */
export function createPagesRouter(
  crawler: CrawlerService = new CrawlerService(),
): Router {
  const router = Router();

  router.post('/pages/scan', async (req: Request, res: Response): Promise<void> => {
    const body = req.body as ScanRequestBody;

    if (typeof body.url !== 'string' || body.url.trim().length === 0) {
      res.status(400).json({
        error: 'INVALID_URL',
        message: 'El campo "url" es obligatorio y debe ser un string no vacío.',
      });
      return;
    }

    try {
      const result = await crawler.scan(body.url.trim());
      res.status(200).json(result);
    } catch (error: unknown) {
      if (error instanceof CrawlerError) {
        // Todos los errores de crawling (URL inválida/inaccesible/timeout)
        // se mapean a 400 según el Acceptance Criteria.
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : 'Error desconocido';
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  });

  return router;
}
