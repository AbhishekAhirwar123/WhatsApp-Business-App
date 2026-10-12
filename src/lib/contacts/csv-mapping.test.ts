import { describe, expect, it } from 'vitest';
import { applyMapping, guessMapping, parseCsvTable } from './csv-mapping';

describe('parseCsvTable', () => {
  it('handles quotes, embedded commas/newlines, BOM and CRLF', () => {
    const csv = '﻿Name,Mobile No.,Notes\r\n"Sharma, Ashutosh",9174824860,"line1\nline2"\r\n\r\n';
    expect(parseCsvTable(csv)).toEqual({
      headers: ['Name', 'Mobile No.', 'Notes'],
      rows: [['Sharma, Ashutosh', '9174824860', 'line1\nline2']],
    });
  });

  it('detects semicolon-delimited files', () => {
    expect(parseCsvTable('phone;name\n+15551230000;Ada').rows).toEqual([
      ['+15551230000', 'Ada'],
    ]);
  });
});

describe('guessMapping', () => {
  it('maps common spreadsheet headers and custom fields by name', () => {
    const m = guessMapping(
      ['Customer Name', 'Mobile No.', 'Email Address', 'Property'],
      [{ id: 'cf-property', field_name: 'property' }],
    );
    expect(m).toMatchObject({
      name: 0,
      phone: 1,
      email: 2,
      company: -1,
      tags: -1,
      custom: { 'cf-property': 3 },
    });
  });

  it('does not take "Contact Name" as the phone column', () => {
    const m = guessMapping(['Contact Name', 'WhatsApp Number']);
    expect(m.phone).toBe(1);
    expect(m.name).toBe(0);
  });
});

describe('applyMapping', () => {
  it('adds the default country code and carries custom values', () => {
    const table = parseCsvTable(
      'name,mobile,property\nAda,98765 43210,Garden City\nBob,919876543211,\nEve,123,Nature Park',
    );
    const rows = applyMapping(
      table,
      { phone: 1, name: 0, email: -1, company: -1, tags: -1, custom: { cf: 2 } },
      { defaultCountryCode: '91' },
    );
    expect(rows.map((r) => [r.phone, r.phoneValid, r.customValues])).toEqual([
      ['+919876543210', true, { cf: 'Garden City' }],
      ['+919876543211', true, {}],
      ['123', false, { cf: 'Nature Park' }],
    ]);
  });
});
