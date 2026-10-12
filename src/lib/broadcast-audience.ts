/**
 * Shared custom-field audience matching for the broadcast wizard. The
 * audience-step estimate and the actual send both go through here so the
 * number the user is shown is the number that gets messaged.
 *
 * Matching rules (what people expect when they type a value):
 *   - `is`        case-insensitive, whitespace-trimmed exact match
 *                 ("garden city" matches "Garden City").
 *   - `contains`  case-insensitive substring match.
 *   - `is_not`    every contact EXCEPT those that match `is` — including
 *                 contacts that have no value for the field at all. The
 *                 old `neq` query only looked at rows that had a value,
 *                 so contacts with the field blank were silently dropped.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

/** PostgREST's default `max_rows` — larger reads come back truncated. */
const PAGE_SIZE = 1000;

/** Escape LIKE wildcards so a value containing `%` or `_` matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Read every row of a query, a page at a time. `build` must return a fresh
 * query for the given inclusive range on each call.
 */
export async function fetchAllPages<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

/** Ids of contacts whose value for the field matches `is` / `contains`. */
async function positiveMatchIds(
  supabase: SupabaseClient,
  fieldId: string,
  operator: 'is' | 'contains',
  value: string,
): Promise<Set<string>> {
  const needle = escapeLike(value.trim());
  const pattern = operator === 'contains' ? `%${needle}%` : needle;
  const rows = await fetchAllPages<{ contact_id: string }>((from, to) =>
    supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId)
      .ilike('value', pattern)
      .order('id')
      .range(from, to),
  );
  return new Set(rows.map((r) => r.contact_id));
}

/** Every contact id visible to the caller (RLS scopes it to the account). */
export async function fetchAllContactIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const rows = await fetchAllPages<{ id: string }>((from, to) =>
    supabase.from('contacts').select('id').order('id').range(from, to),
  );
  return rows.map((r) => r.id);
}

/** Contact ids matching a custom-field rule, per the rules above. */
export async function resolveCustomFieldContactIds(
  supabase: SupabaseClient,
  filter: CustomFieldFilter,
): Promise<string[]> {
  const { fieldId, operator, value } = filter;
  if (operator === 'is_not') {
    const [matching, all] = await Promise.all([
      positiveMatchIds(supabase, fieldId, 'is', value),
      fetchAllContactIds(supabase),
    ]);
    return all.filter((id) => !matching.has(id));
  }
  return [...(await positiveMatchIds(supabase, fieldId, operator, value))];
}

/**
 * Distinct existing values for a field (case-insensitive, first spelling
 * wins), sorted — offered as suggestions so the user picks a value that
 * actually exists instead of guessing its spelling.
 */
export async function fetchCustomFieldValues(
  supabase: SupabaseClient,
  fieldId: string,
): Promise<{ value: string; count: number }[]> {
  const rows = await fetchAllPages<{ value: string | null }>((from, to) =>
    supabase
      .from('contact_custom_values')
      .select('value')
      .eq('custom_field_id', fieldId)
      .order('id')
      .range(from, to),
  );
  const byKey = new Map<string, { value: string; count: number }>();
  for (const { value } of rows) {
    const v = value?.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    const hit = byKey.get(key);
    if (hit) hit.count++;
    else byKey.set(key, { value: v, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.value.localeCompare(b.value));
}

/** Fetch full contact rows by id, chunked to keep the URL short. */
export async function fetchContactsByIds<T>(
  supabase: SupabaseClient,
  ids: string[],
): Promise<T[]> {
  const CHUNK = 200;
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', ids.slice(i, i + CHUNK));
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}
