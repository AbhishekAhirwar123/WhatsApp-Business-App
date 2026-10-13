/**
 * Detects "this database hasn't been migrated yet" errors, so code that
 * depends on a newer migration (e.g. 044_inbox_parity) can fall back to the
 * previous behaviour instead of breaking — the app must keep working in the
 * window between deploying code and applying the migration.
 *
 * PostgREST codes: PGRST202 function not found, PGRST205 table not found,
 * PGRST204 column not found (insert/update). Postgres codes: 42703
 * undefined column, 42883 undefined function, 42P01 undefined table.
 */
const MISSING_CODES = new Set(['PGRST202', 'PGRST204', 'PGRST205', '42703', '42883', '42P01']);

export function isMissingSchemaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: string; message?: string };
  if (code && MISSING_CODES.has(code)) return true;
  return typeof message === 'string' && /schema cache|does not exist/i.test(message);
}

/** Shown to admins while migration 044 is missing. */
export const MIGRATION_044_NOTICE =
  'Database update needed: apply supabase/migrations/044_inbox_parity.sql (see docs/WACRM_INBOX_SETUP.md). ' +
  'Until then the inbox runs in basic mode — saved views, per-user unread, SLA, scheduling and audit history are unavailable.';
