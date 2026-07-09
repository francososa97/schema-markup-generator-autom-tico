import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  SnippetService,
  SchemaNotFoundError,
  SchemaNotValidatedError,
  type SchemaRepository,
} from './snippet.service';

type SnippetFormat = 'json' | 'download';

function resolveFormat(raw: unknown): SnippetFormat {
  return raw === 'download' || raw === 'html' ? 'download' : 'json';
}

/**
 * Registra `GET /schemas/:id/snippet` sobre un Router de Express.
 *
 * - `?format=json` (default): 200 con `{ snippet, filename }` (el tag JSON-LD
 *   listo para copiar; el front renderiza el botón 'copiar al portapapeles').
 * - `?format=download` (o `html`): 200 con el documento .html completo
 *   (Content-Disposition: attachment) para descargar el snippet.
 */
export function createSnippetRouter(repository: SchemaRepository): Router {
  const service = new SnippetService(repository);
  const router = Router();

  router.get('/schemas/:id/snippet', async (req: Request, res: Response): Promise<void> => {
    const schemaId = req.params.id;
    const format = resolveFormat(req.query.format);

    try {
      const artifacts = await service.buildArtifacts(schemaId);

      if (format === 'download') {
        res.status(200);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${artifacts.filename}"`);
        res.send(artifacts.downloadHtml);
        return;
      }

      res.status(200).json({
        id: schemaId,
        snippet: artifacts.scriptTag,
        filename: artifacts.filename,
        downloadUrl: `/schemas/${encodeURIComponent(schemaId)}/snippet?format=download`,
      });
    } catch (err: unknown) {
      if (err instanceof SchemaNotFoundError) {
        res.status(404).json({ error: 'schema_not_found', message: err.message });
        return;
      }
      if (err instanceof SchemaNotValidatedError) {
        res.status(409).json({ error: 'schema_not_validated', message: err.message, status: err.status });
        return;
      }
      res.status(500).json({ error: 'internal_error', message: 'No se pudo generar el snippet' });
    }
  });

  return router;
}
