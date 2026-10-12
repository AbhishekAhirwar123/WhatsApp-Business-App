import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// A plain stub (not vi.fn): vitest's spy result tracking reported the
// worker's *handled* rejection as a test failure.
type SendImpl = (...a: unknown[]) => Promise<unknown>;
const send = {
  calls: [] as unknown[][],
  impl: (async () => ({ messageId: 'msg-9', whatsappMessageId: 'wamid.9' })) as SendImpl,
};
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessageToConversation: (...a: unknown[]) => {
    send.calls.push(a);
    return send.impl(...a);
  },
}));

import { SendMessageError } from '@/lib/whatsapp/send-message';
import {
  processScheduledMessage,
  scheduledClientMessageId,
  type ScheduledMessageRow,
} from './scheduler';
import { validateScheduleInput } from './schedule-validation';

/** Fake with just what the worker touches; records schedule updates. */
function fakeDb(state: {
  creator?: { account_id: string; account_role: string } | null;
  priorMessage?: { id: string; status: string; message_id: string | null } | null;
  lockedBy?: string;
}) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters[k] = v; return b; },
        update: (p: Record<string, unknown>) => { patch = p; return b; },
        maybeSingle: async () => {
          if (table === 'profiles') return { data: state.creator ?? null, error: null };
          if (table === 'messages') return { data: state.priorMessage ?? null, error: null };
          if (table === 'scheduled_messages' && patch) {
            // Conditional completion: only the lease owner may finish.
            if (filters.locked_by !== (state.lockedBy ?? 'w1')) return { data: null, error: null };
            updates.push(patch);
            return { data: { id: filters.id }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

const row = (over: Partial<ScheduledMessageRow> = {}): ScheduledMessageRow => ({
  id: 'sch-1',
  account_id: 'acct-1',
  conversation_id: 'cv-1',
  contact_id: 'ct-1',
  created_by: 'agent-1',
  message_type: 'text',
  content_text: 'Following up on the site visit',
  template_name: null,
  template_language: null,
  template_params: {},
  scheduled_for: '2026-10-12T10:00:00Z',
  attempts: 1,
  ...over,
});

const agent = { account_id: 'acct-1', account_role: 'agent' };

beforeEach(() => {
  send.calls = [];
  send.impl = async () => ({ messageId: 'msg-9', whatsappMessageId: 'wamid.9' });
});

describe('processScheduledMessage', () => {
  it('sends with the schedule idempotency key and records the message', async () => {
    const { db, updates } = fakeDb({ creator: agent });
    const out = await processScheduledMessage(db, 'w1', row());
    expect(out).toEqual({ id: 'sch-1', result: 'sent', messageId: 'msg-9' });
    expect(send.calls[0]).toEqual([db, 'acct-1', expect.objectContaining({
      clientMessageId: scheduledClientMessageId('sch-1'),
      senderId: 'agent-1',
      messageType: 'text',
    })]);
    expect(updates[0]).toMatchObject({ status: 'sent', message_id: 'msg-9' });
  });

  it('fails clearly (never substitutes content) when the 24h window closed', async () => {
    send.impl = async () => {
      throw new SendMessageError('window_closed', 'closed', 422);
    };
    const { db, updates } = fakeDb({ creator: agent });
    const out = await processScheduledMessage(db, 'w1', row());
    expect(out.result).toBe('failed');
    expect(updates[0]).toMatchObject({ status: 'failed' });
    expect(String(updates[0].error)).toMatch(/24-hour customer window/);
  });

  it('refuses to send for a creator who lost access', async () => {
    const { db, updates } = fakeDb({ creator: { account_id: 'acct-1', account_role: 'viewer' } });
    const out = await processScheduledMessage(db, 'w1', row());
    expect(out.result).toBe('failed');
    expect(send.calls).toHaveLength(0);
    expect(String(updates[0].error)).toMatch(/no longer has permission/);
  });

  it('after a worker restart, reconciles an already-sent message instead of re-sending', async () => {
    const { db, updates } = fakeDb({
      creator: agent,
      priorMessage: { id: 'msg-1', status: 'delivered', message_id: 'wamid.1' },
    });
    const out = await processScheduledMessage(db, 'w1', row({ attempts: 2 }));
    expect(out).toEqual({ id: 'sch-1', result: 'sent', messageId: 'msg-1' });
    expect(send.calls).toHaveLength(0);
    expect(updates[0]).toMatchObject({ status: 'sent' });
  });

  it('marks an interrupted, unconfirmed send as uncertain rather than re-sending', async () => {
    const { db, updates } = fakeDb({
      creator: agent,
      priorMessage: { id: 'msg-1', status: 'sending', message_id: null },
    });
    const out = await processScheduledMessage(db, 'w1', row({ attempts: 2 }));
    expect(out.result).toBe('failed');
    expect(send.calls).toHaveLength(0);
    expect(String(updates[0].error)).toMatch(/uncertain/);
  });

  it('a worker whose lease was taken over cannot overwrite the outcome', async () => {
    const { db, updates } = fakeDb({ creator: agent, lockedBy: 'w2' });
    await processScheduledMessage(db, 'w1', row());
    expect(updates).toHaveLength(0);
  });
});

describe('validateScheduleInput', () => {
  const now = Date.parse('2026-10-12T06:30:00Z');
  it('accepts a future text message and normalises to UTC', () => {
    const r = validateScheduleInput(
      { message_type: 'text', content_text: ' Hi ', scheduled_for: '2026-10-12T15:00:00+05:30', timezone: 'Asia/Kolkata' },
      now,
    );
    expect(r).toMatchObject({ ok: true, value: { scheduled_for: '2026-10-12T09:30:00.000Z', content_text: 'Hi' } });
  });
  it('rejects past times, blank text, missing template variables and bad zones', () => {
    expect(validateScheduleInput({ message_type: 'text', content_text: 'x', scheduled_for: '2026-10-12T06:00:00Z' }, now).ok).toBe(false);
    expect(validateScheduleInput({ message_type: 'text', content_text: '  ', scheduled_for: '2026-10-13T06:00:00Z' }, now).ok).toBe(false);
    expect(validateScheduleInput({ message_type: 'template', template_name: 't', template_params: { body: ['ok', ''] }, scheduled_for: '2026-10-13T06:00:00Z' }, now).ok).toBe(false);
    expect(validateScheduleInput({ message_type: 'text', content_text: 'x', scheduled_for: '2026-10-13T06:00:00Z', timezone: 'Mars/Base' }, now).ok).toBe(false);
  });
});
