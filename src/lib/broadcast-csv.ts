/**
 * CSV → broadcast audience.
 *
 * The broadcast wizard's "Upload CSV" audience type needs a
 * `{ phone, name }[]` list, which is a narrower shape than the
 * contacts importer's. Rather than re-parse, this reuses the shared
 * `parseContactCsv` + `dedupeByPhone` so a CSV that imports cleanly on
 * the Contacts page also broadcasts cleanly (issue #512).
 *
 * De-duplication happens HERE, on the normalized number, because the
 * downstream contact upsert inserts against a UNIQUE index on
 * (account_id, phone_normalized) (migration 022). Two spellings of the
 * same number in one file ("+1 555-0100" and "15550100") would
 * otherwise reach that index as separate inserts and fail the whole
 * broadcast with a constraint error.
 *
 * Pure and unit-tested: the wizard is a client component and
 * `vitest.config.ts` runs `environment: "node"` with no jsdom, so the
 * logic has to live outside the component to be testable.
 */

import { dedupeByPhone } from '@/lib/contacts/dedupe';
import { parseContactCsv } from '@/lib/contacts/parse-contact-csv';
import { toInternationalPhone } from '@/lib/whatsapp/phone-utils';

/** The shape the wizard hands to `createAndSendBroadcast`. */
export interface BroadcastCsvContact {
  phone: string;
  name?: string;
}

export type BroadcastCsvError =
  /** No `phone` header — the one column we can't work without. */
  | 'missing_phone_column'
  /** Header was fine, but not one row carried a usable number. */
  | 'no_valid_rows';

export type ParseBroadcastCsvResult =
  | {
      ok: true;
      contacts: BroadcastCsvContact[];
      /** Rows dropped as same-number repeats. */
      duplicates: number;
      /**
       * Rows dropped because the number is blank or lacks a leading `+`
       * and country code (issue #586). The wizard warns about these so
       * a CSV of national-format numbers doesn't silently shrink.
       */
      invalid: number;
    }
  | { ok: false; error: BroadcastCsvError };

export function parseBroadcastCsv(
  text: string,
  options: {
    /**
     * Country code (e.g. "91") added to numbers written without one.
     * Without it, such rows are refused as invalid (issue #586).
     */
    defaultCountryCode?: string | null;
  } = {},
): ParseBroadcastCsvResult {
  const { rows: parsed, hasPhoneColumn } = parseContactCsv(text);

  if (!hasPhoneColumn) return { ok: false, error: 'missing_phone_column' };

  const cc = options.defaultCountryCode?.replace(/\D/g, '');
  const rows = cc
    ? parsed.map((row) => ({
        ...row,
        phone: toInternationalPhone(row.phone, cc) ?? row.phone,
      }))
    : parsed;

  const { unique, duplicates, invalid } = dedupeByPhone(rows);
  if (unique.length === 0) return { ok: false, error: 'no_valid_rows' };

  return {
    ok: true,
    // Drop email/company/tags: the broadcast audience only addresses
    // people, and `name` is the sole field template variables can map.
    contacts: unique.map(({ phone, name }) =>
      name ? { phone, name } : { phone }
    ),
    duplicates,
    invalid,
  };
}
