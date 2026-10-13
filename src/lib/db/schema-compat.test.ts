import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingSchemaError } from './schema-compat';
import { selectContactForSend } from '@/lib/contacts/send-contact';

describe('isMissingSchemaError', () => {
  it('recognises the errors a not-yet-migrated database returns', () => {
    expect(isMissingSchemaError({ code: 'PGRST202', message: 'Could not find the function public.inbox_counts(p_filters) in the schema cache' })).toBe(true);
    expect(isMissingSchemaError({ code: 'PGRST205', message: "Could not find the table 'public.inbox_views' in the schema cache" })).toBe(true);
    expect(isMissingSchemaError({ code: 'PGRST204', message: "Could not find the 'client_message_id' column" })).toBe(true);
    expect(isMissingSchemaError({ code: '42703', message: 'column contacts.blocked_at does not exist' })).toBe(true);
  });
  it('does not swallow real failures', () => {
    expect(isMissingSchemaError({ code: '23505', message: 'duplicate key value' })).toBe(false);
    expect(isMissingSchemaError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });
});

describe('selectContactForSend', () => {
  it('retries without blocked_at on an un-migrated database', async () => {
    const selects: string[] = [];
    const db = {
      from: () => {
        let cols = '';
        const b: Record<string, unknown> = {
          select: (c: string) => { cols = c; selects.push(c); return b; },
          eq: () => b,
          maybeSingle: async () =>
            cols.includes('blocked_at')
              ? { data: null, error: { code: '42703', message: 'column contacts.blocked_at does not exist' } }
              : { data: { id: 'ct', phone: '+15550000001', wa_user_id: null }, error: null },
        };
        return b;
      },
    } as unknown as SupabaseClient;
    const res = await selectContactForSend(db, 'acct', 'ct');
    expect(res.data?.id).toBe('ct');
    expect(selects).toEqual(['id, phone, wa_user_id, blocked_at', 'id, phone, wa_user_id']);
  });
});
