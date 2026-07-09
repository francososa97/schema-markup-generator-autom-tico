import type { Request, Response, Router } from 'express';

/**
 * Dominio mínimo del snippet. En el proyecto real estos tipos viven en
 * `src/shared/types/index.ts` (Schema, SchemaStatus). Se declaran aquí de forma
 * compatible para mantener el feature autocontenido y compilable en strict mode.
 */
export type SchemaStatus = 'draft' | 'valid' | 'invalid' | 'published';

export interface Schema {
  readonly id: string;
  readonly name: string;
  /** JSON-LD ya construido (objeto o array de objetos @type). */
  readonly jsonLd: Readonly<Record<string, unknown>> | ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly status: SchemaStatus;
}

/** Puerto de persistencia. La implementación concreta (DB/ORM) se inyecta. */
export interface SchemaRepository {
  findById(id: string): Promise<Schema | null>;
}

export interface SnippetArtifacts {
  /** Tag <script type="application/ld+json"> listo para pegar en el <head>. */
  readonly scriptTag: string;
  /** Documento .html completo y descargable que contiene el snippet. */
  readonly downloadHtml: string;
  /** Nombre de archivo sugerido para la descarga. */
  readonly filename: string;
}

export class SchemaNotFoundError extends Error {
  constructor(public readonly schemaId: string) {
    super(`Schema ${schemaId} no encontrado`);
    this.name = 'SchemaNotFoundError';
  }
}

export class SchemaNotValidatedError extends Error {
  constructor(public readonly schemaId: string, public readonly status: SchemaStatus) {
    super(`Schema ${schemaId} no está validado (estado actual: ${status})`);
    this.name = 'SchemaNotValidatedError';
  }
}

const VALIDATED_STATUSES: ReadonlySet<SchemaStatus> = new Set<SchemaStatus>(['valid', 'published']);

/**
 * Serializa el JSON-LD escapando '<', '>' y '&' a secuencias unicode para que el
 * contenido nunca pueda cerrar prematuramente el <script> ni inyectar HTML.
 */
function serializeJsonLd(jsonLd: Schema['jsonLd']): string {
  return JSON.stringify(jsonLd, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug.length > 0 ? slug : 'schema';
}

/** Construye el tag <script type="application/ld+json"> listo para copiar. */
export function buildScriptTag(schema: Schema): string {
  return `<script type="application/ld+json">\n${serializeJsonLd(schema.jsonLd)}\n</script>`;
}

/**
 * Genera un documento .html completo y autónomo: incluye el snippet embebido,
 * un botón 'Copiar al portapapeles' y un botón para descargar el propio snippet.
 */
export function buildDownloadHtml(schema: Schema, scriptTag: string): string {
  const title = escapeHtml(schema.name);
  const snippetForPre = escapeHtml(scriptTag);
  const snippetForJs = JSON.stringify(scriptTag);
  const downloadName = `${slugify(schema.name)}-schema.html`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Snippet Schema — ${title}</title>
  <!-- ↓↓↓ Pegá este bloque dentro del <head> de tu página ↓↓↓ -->
  ${scriptTag}
  <!-- ↑↑↑ Fin del snippet JSON-LD ↑↑↑ -->
  <style>
    body { font-family: system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
    pre { background: #0d1117; color: #e6edf3; padding: 1rem; border-radius: 8px; overflow: auto; }
    button { cursor: pointer; padding: .55rem 1rem; border: 0; border-radius: 6px; font-size: .95rem; margin-right: .5rem; }
    .primary { background: #2563eb; color: #fff; }
    .secondary { background: #e5e7eb; color: #111; }
    #status { margin-left: .5rem; color: #16a34a; font-size: .9rem; }
  </style>
</head>
<body>
  <h1>Snippet Schema — ${title}</h1>
  <p>Copiá el bloque y pegalo dentro del <code>&lt;head&gt;</code> de tu página.</p>
  <pre id="snippet">${snippetForPre}</pre>
  <button class="primary" id="copy">Copiar al portapapeles</button>
  <button class="secondary" id="download">Descargar .html</button>
  <span id="status" role="status" aria-live="polite"></span>
  <script>
    (function () {
      var snippet = ${snippetForJs};
      var statusEl = document.getElementById('status');
      function flash(msg) { statusEl.textContent = msg; setTimeout(function () { statusEl.textContent = ''; }, 2500); }
      document.getElementById('copy').addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(snippet).then(function () { flash('¡Copiado!'); }, function () { flash('No se pudo copiar'); });
        } else {
          var ta = document.createElement('textarea');
          ta.value = snippet; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); flash('¡Copiado!'); } catch (e) { flash('No se pudo copiar'); }
          document.body.removeChild(ta);
        }
      });
      document.getElementById('download').addEventListener('click', function () {
        var blob = new Blob([snippet], { type: 'text/html;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = ${JSON.stringify(downloadName)};
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url); flash('Descarga iniciada');
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Servicio de dominio: valida el estado del schema y produce los artefactos del
 * snippet (tag, documento descargable y filename). Lanza errores tipados si el
 * schema no existe o no está validado.
 */
export class SnippetService {
  constructor(private readonly repository: SchemaRepository) {}

  async buildArtifacts(schemaId: string): Promise<SnippetArtifacts> {
    const schema = await this.repository.findById(schemaId);
    if (schema === null) {
      throw new SchemaNotFoundError(schemaId);
    }
    if (!VALIDATED_STATUSES.has(schema.status)) {
      throw new SchemaNotValidatedError(schemaId, schema.status);
    }

    const scriptTag = buildScriptTag(schema);
    return {
      scriptTag,
      downloadHtml: buildDownloadHtml(schema, scriptTag),
      filename: `${slugify(schema.name)}-schema.html`,
    };
  }
}

export type { Request, Response, Router };
