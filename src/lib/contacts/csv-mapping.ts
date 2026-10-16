/**
 * CSV → contacts with user-controlled column mapping.
 *
 * The importer used to require exact header names (`phone`, `name`, …),
 * so a sheet exported with "Mobile No" or "Customer Name" imported
 * nothing. Here the file is read as a plain table, each system field is
 * mapped to a column (auto-guessed from the header, editable in the UI),
 * and phone numbers without a country code get a default one.
 *
 * Pure and unit-tested; the import modal is a thin UI over it.
 */

import { toInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { parseTagCell } from '@/lib/contacts/parse-contact-csv';

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** Built-in contact fields a column can be mapped to. */
export const SYSTEM_FIELDS = ['phone', 'name', 'email', 'company', 'tags'] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

/**
 * Column index per field; -1 = not mapped. `custom` is keyed by
 * custom_fields.id.
 */
export interface ColumnMapping {
  phone: number;
  name: number;
  email: number;
  company: number;
  tags: number;
  custom: Record<string, number>;
}

export interface MappedContactRow {
  /** E.164 (`+<digits>`) when it could be normalized, else the raw cell. */
  phone: string;
  /** False when `phone` could not be turned into a usable number. */
  phoneValid: boolean;
  name?: string;
  email?: string;
  company?: string;
  tagNames: string[];
  /** custom_fields.id → value (blank cells omitted). */
  customValues: Record<string, string>;
}

const ALIASES: Record<SystemField, string[]> = {
  phone: [
    'phone', 'phone number', 'phone no', 'mobile', 'mobile number',
    'mobile no', 'cell', 'whatsapp', 'whatsapp number', 'whatsapp no',
    'contact', 'contact number', 'contact no', 'number', 'msisdn', 'tel',
    'telephone',
  ],
  name: [
    'name', 'full name', 'fullname', 'customer name', 'client name',
    'contact name', 'customer', 'client',
  ],
  email: ['email', 'e-mail', 'email address', 'mail'],
  company: ['company', 'company name', 'organisation', 'organization', 'business'],
  tags: ['tags', 'tag', 'labels', 'label', 'groups', 'group', 'segment'],
};

/** Too generic to match as a substring ("contact name" is not a phone). */
const EXACT_ONLY = new Set([
  'contact', 'customer', 'client', 'number', 'group', 'mail', 'cell', 'tel', 'tag',
]);

function normHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[_\-.:#*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pick the delimiter that splits the header line into the most cells. */
function detectDelimiter(firstLine: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const n = firstLine.split(d).length;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * RFC-4180-ish parser: quoted fields may contain the delimiter, newlines
 * and `""` escapes. Handles a UTF-8 BOM and CRLF. Fully blank lines are
 * dropped.
 */
export function parseCsvTable(text: string): CsvTable {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = detectDelimiter(firstLine);

  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim());
      records.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    records.push(row);
  }

  const nonBlank = records.filter((r) => r.some((c) => c !== ''));
  if (nonBlank.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = nonBlank;
  return { headers, rows };
}

/**
 * Best-guess mapping from header names. Exact alias matches win over
 * "header contains alias" matches, and a column is never used twice.
 * Custom fields are matched by their name.
 */
export function guessMapping(
  headers: string[],
  customFields: { id: string; field_name: string }[] = [],
): ColumnMapping {
  const normalized = headers.map(normHeader);
  const used = new Set<number>();

  const find = (aliases: string[]): number => {
    for (const alias of aliases) {
      const idx = normalized.findIndex((h, i) => !used.has(i) && h === alias);
      if (idx >= 0) return idx;
    }
    for (const alias of aliases) {
      if (EXACT_ONLY.has(alias)) continue;
      const idx = normalized.findIndex(
        (h, i) => !used.has(i) && h.includes(alias),
      );
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const mapping: ColumnMapping = {
    phone: -1,
    name: -1,
    email: -1,
    company: -1,
    tags: -1,
    custom: {},
  };

  // Custom fields first: a sheet with a "Property" column and a custom
  // field named "Property" should land there, not in a fuzzy built-in.
  for (const f of customFields) {
    const idx = normalized.findIndex(
      (h, i) => !used.has(i) && h === normHeader(f.field_name),
    );
    if (idx >= 0) {
      mapping.custom[f.id] = idx;
      used.add(idx);
    }
  }

  for (const field of SYSTEM_FIELDS) {
    const idx = find(ALIASES[field]);
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }

  return mapping;
}

/** Apply a mapping to every data row. Rows that are entirely blank in the
 *  mapped columns are skipped. */
export function applyMapping(
  table: CsvTable,
  mapping: ColumnMapping,
  options: { defaultCountryCode?: string | null } = {},
): MappedContactRow[] {
  const cell = (row: string[], idx: number): string | undefined => {
    if (idx < 0) return undefined;
    const v = row[idx]?.trim();
    return v ? v : undefined;
  };

  const out: MappedContactRow[] = [];
  for (const row of table.rows) {
    const rawPhone = cell(row, mapping.phone) ?? '';
    const normalized = toInternationalPhone(rawPhone, options.defaultCountryCode);

    const customValues: Record<string, string> = {};
    for (const [fieldId, idx] of Object.entries(mapping.custom)) {
      const v = cell(row, idx);
      if (v) customValues[fieldId] = v;
    }

    const mapped: MappedContactRow = {
      phone: normalized ?? rawPhone,
      phoneValid: normalized !== null,
      name: cell(row, mapping.name),
      email: cell(row, mapping.email),
      company: cell(row, mapping.company),
      tagNames: parseTagCell(cell(row, mapping.tags)),
      customValues,
    };

    const empty =
      !rawPhone &&
      !mapped.name &&
      !mapped.email &&
      !mapped.company &&
      mapped.tagNames.length === 0 &&
      Object.keys(customValues).length === 0;
    if (!empty) out.push(mapped);
  }
  return out;
}
