/**
 * Custom field types. `text` is free text; `select` is a dropdown whose
 * choices live in `custom_fields.field_options.options` (e.g. a "Lead
 * Status" field with "Hot - 60 Days", "Warm - 120 Days", …). Values are
 * stored as plain text in `contact_custom_values`, so broadcasts,
 * automations and CSV import treat both types the same way.
 */

export type CustomFieldType = 'text' | 'select';

interface FieldLike {
  field_type?: string | null;
  field_options?: Record<string, unknown> | null;
}

/** The dropdown choices of a `select` field (empty for text fields). */
export function getFieldOptions(field: FieldLike): string[] {
  const raw = field.field_options?.options;
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is string => typeof o === 'string' && o.trim() !== '');
}

export function isDropdownField(field: FieldLike): boolean {
  return field.field_type === 'select';
}

/**
 * Options to render in a dropdown, keeping a value that isn't (or is no
 * longer) one of the options — e.g. imported from CSV — so opening the
 * dropdown never silently blanks it.
 */
export function withCurrentValue(options: string[], current?: string | null): string[] {
  const v = current?.trim();
  if (!v || options.some((o) => o.toLowerCase() === v.toLowerCase())) return options;
  return [v, ...options];
}

/** Parse the options editor's text (one per line, or comma-separated). */
export function parseOptionsInput(text: string): string[] {
  const parts = text.includes('\n') ? text.split('\n') : text.split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const v = p.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}
