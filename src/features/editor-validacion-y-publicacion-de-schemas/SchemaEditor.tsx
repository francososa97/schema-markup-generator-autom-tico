// src/features/editor-validacion-y-publicacion-de-schemas/SchemaEditor.tsx
// Componente React del editor JSON-LD interactivo.
// Renderiza un form estructurado (no raw JSON) y un preview del JSON-LD que se
// recomputa de forma síncrona en cada cambio (tiempo real). Al guardar dispara
// PATCH /schemas/:id a través de SchemaEditorService.

import React, { useCallback, useMemo, useState } from 'react';
import type {
  FieldError,
  FormFieldType,
  JsonLdObject,
  SchemaForm,
  SchemaRecord,
} from './types';
import type { SaveOutcome } from './service';
import { SchemaEditorService } from './service';

export interface SchemaEditorProps {
  record: SchemaRecord;
  service: SchemaEditorService;
  onSaved?: (outcome: SaveOutcome) => void;
}

function inputType(type: FormFieldType): string {
  switch (type) {
    case 'url':
      return 'url';
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    default:
      return 'text';
  }
}

export function SchemaEditor({ record, service, onSaved }: SchemaEditorProps): React.ReactElement {
  const [form, setForm] = useState<SchemaForm>(() => service.buildForm(record));
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState<boolean>(false);
  const [savedMs, setSavedMs] = useState<number | null>(null);

  // Preview en tiempo real: recomputado en cada cambio del form (operación pura).
  const preview = useMemo<JsonLdObject>(
    () => service.toJsonLd(record.jsonLd, form),
    [record.jsonLd, form, service],
  );

  const validation = useMemo(() => service.validate(form), [form, service]);
  const errors = validation.valid ? serverErrors : validation.errors;

  const handleChange = useCallback(
    (path: string, value: string): void => {
      setForm((prev) => service.applyChange(prev, path, value));
    },
    [service],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setSavedMs(null);
    try {
      const outcome = await service.save(record, form);
      if (outcome.ok) {
        setServerErrors([]);
        setSavedMs(Math.round(outcome.elapsedMs));
        onSaved?.(outcome);
      } else {
        setServerErrors(outcome.validation.errors);
      }
    } finally {
      setSaving(false);
    }
  }, [record, form, service, onSaved]);

  return (
    <div className="sg-editor">
      <form
        className="sg-editor__form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <h2>Editar schema: {form.schemaType}</h2>

        {form.fields.map((field) => {
          const fieldError = errors.find((e) => e.path === field.path);
          return (
            <div className="sg-field" key={field.path}>
              <label htmlFor={field.path}>
                {field.label}
                {field.required ? ' *' : ''}
              </label>
              {field.type === 'textarea' ? (
                <textarea
                  id={field.path}
                  value={field.value}
                  onChange={(e) => handleChange(field.path, e.target.value)}
                />
              ) : (
                <input
                  id={field.path}
                  type={inputType(field.type)}
                  value={field.value}
                  onChange={(e) => handleChange(field.path, e.target.value)}
                />
              )}
              {fieldError ? (
                <span className="sg-field__error" role="alert">
                  {fieldError.message}
                </span>
              ) : null}
            </div>
          );
        })}

        <button type="submit" disabled={saving || !validation.valid}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        {savedMs !== null ? (
          <span className="sg-editor__status">Guardado en {savedMs} ms</span>
        ) : null}
      </form>

      <aside className="sg-editor__preview" aria-label="Preview JSON-LD">
        <h3>Preview JSON-LD</h3>
        <pre>
          <code>{JSON.stringify(preview, null, 2)}</code>
        </pre>
      </aside>
    </div>
  );
}
