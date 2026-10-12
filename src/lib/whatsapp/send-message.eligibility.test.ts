import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Server-side send eligibility + idempotent outbox (inbox parity, pass B).
// Meta is mocked; no network, synthetic data only.

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }));
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.tpl' }));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...a: unknown[]) =>
    (sendTextMessage as unknown as (...x: unknown[]) => unknown)(...a),
  sendTemplateMessage: (...a: unknown[]) =>
    (sendTemplateMessage as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
    }),
  }),
}));

import {
  isWithinCustomerWindow,
  sendMessageToConversation,
  SendMessageError,
} from './send-message';

interface Row extends Record<string, unknown> {
  id: string;
}

/** In-memory fake: one conversation, a messages table with the
 *  (conversation_id, client_message_id) unique constraint. */
function fakeDb(opts: {
  lastInboundAt: string | null;
  contact?: Record<string, unknown>;
}) {
  const messages: Row[] = [];
  let seq = 0;
  const conversation = {
    id: 'cv-1',
    last_inbound_at: opts.lastInboundAt,
    contact: { id: 'ct-1', phone: '+15550000001', ...opts.contact },
  };
  const config = { id: 'cfg', phone_number_id: 'pn', access_token: 't' };

  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Record<string, unknown> = {};
      const run = () => {
        if (table === 'conversations' && op === 'select') return { data: conversation, error: null };
        if (table === 'whatsapp_config') return { data: config, error: null };
        if (table !== 'messages') return { data: null, error: null };
        if (op === 'insert') {
          const dup = payload.client_message_id &&
            messages.some((m) => m.conversation_id === payload.conversation_id &&
              m.client_message_id === payload.client_message_id);
          if (dup) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          const row = { id: `msg-${++seq}`, ...payload } as Row;
          messages.push(row);
          return { data: row, error: null };
        }
        const match = messages.find((m) =>
          Object.entries(filters).every(([k, v]) => m[k] === v));
        if (op === 'update') {
          if (match) Object.assign(match, payload);
          return { data: match ?? null, error: null };
        }
        return { data: match ?? null, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters[k] = v; return b; },
        order: () => b,
        limit: () => b,
        insert: (p: Record<string, unknown>) => { op = 'insert'; payload = p; return b; },
        update: (p: Record<string, unknown>) => { op = 'update'; payload = p; return b; },
        single: async () => run(),
        maybeSingle: async () => run(),
        then: (resolve: (r: unknown) => unknown) =>
          resolve(table === 'message_templates' ? { data: [], error: null } : run()),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, messages };
}

const recent = () => new Date(Date.now() - 60_000).toISOString();
const stale = () => new Date(Date.now() - 25 * 3600_000).toISOString();

beforeEach(() => {
  sendTextMessage.mockClear();
  sendTemplateMessage.mockClear();
});

describe('isWithinCustomerWindow', () => {
  it('is open for 24h after the last inbound message only', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    expect(isWithinCustomerWindow('2026-10-11T12:00:01Z', now)).toBe(true);
    expect(isWithinCustomerWindow('2026-10-11T12:00:00Z', now)).toBe(false);
    expect(isWithinCustomerWindow(null, now)).toBe(false);
  });
});

describe('server-side send eligibility', () => {
  it('rejects free-form text outside the 24h window before calling Meta', async () => {
    const { db } = fakeDb({ lastInboundAt: stale() });
    const err = await sendMessageToConversation(db, 'acct', {
      conversationId: 'cv-1', messageType: 'text', contentText: 'hi',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect((err as SendMessageError).code).toBe('window_closed');
    expect((err as SendMessageError).status).toBe(422);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('treats a conversation with no inbound message as closed', async () => {
    const { db } = fakeDb({ lastInboundAt: null });
    await expect(
      sendMessageToConversation(db, 'acct', { conversationId: 'cv-1', messageType: 'text', contentText: 'hi' }),
    ).rejects.toMatchObject({ code: 'window_closed' });
  });

  it('still allows an approved template when the window is closed', async () => {
    const { db } = fakeDb({ lastInboundAt: stale() });
    const res = await sendMessageToConversation(db, 'acct', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'follow_up',
    });
    expect(res.whatsappMessageId).toBe('wamid.tpl');
  });

  it('refuses every send to a CRM-blocked contact', async () => {
    const { db } = fakeDb({ lastInboundAt: recent(), contact: { blocked_at: recent() } });
    await expect(
      sendMessageToConversation(db, 'acct', { conversationId: 'cv-1', messageType: 'template', templateName: 'x' }),
    ).rejects.toMatchObject({ code: 'contact_blocked', status: 403 });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('refuses templates to an opted-out contact but allows an in-window reply', async () => {
    const { db } = fakeDb({ lastInboundAt: recent(), contact: { opt_in_status: 'opted_out' } });
    await expect(
      sendMessageToConversation(db, 'acct', { conversationId: 'cv-1', messageType: 'template', templateName: 'x' }),
    ).rejects.toMatchObject({ code: 'contact_opted_out' });
    const res = await sendMessageToConversation(db, 'acct', {
      conversationId: 'cv-1', messageType: 'text', contentText: 'Answering your question',
    });
    expect(res.whatsappMessageId).toBe('wamid.text');
  });
});

describe('idempotent outbox (clientMessageId)', () => {
  it('a retried request returns the original message and never re-sends', async () => {
    const { db, messages } = fakeDb({ lastInboundAt: recent() });
    const params = {
      conversationId: 'cv-1', messageType: 'text', contentText: 'hi',
      clientMessageId: 'ui:1', senderId: 'agent-1',
    };
    const first = await sendMessageToConversation(db, 'acct', params);
    const second = await sendMessageToConversation(db, 'acct', params);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ messageId: first.messageId, duplicate: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: 'sent', message_id: 'wamid.text', sender_id: 'agent-1' });
  });

  it('marks the pending row failed (never "sent") when Meta rejects', async () => {
    const { db, messages } = fakeDb({ lastInboundAt: recent() });
    sendTextMessage.mockRejectedValueOnce(new Error('(#131026) Message undeliverable'));
    await expect(
      sendMessageToConversation(db, 'acct', {
        conversationId: 'cv-1', messageType: 'text', contentText: 'hi', clientMessageId: 'ui:2',
      }),
    ).rejects.toMatchObject({ code: 'meta_error' });
    expect(messages[0]).toMatchObject({ status: 'failed' });
    expect(String(messages[0].error_title)).toMatch(/131026/);
  });

  it('refuses a replay of an in-flight or failed key instead of sending twice', async () => {
    const { db, messages } = fakeDb({ lastInboundAt: recent() });
    messages.push({ id: 'msg-x', conversation_id: 'cv-1', client_message_id: 'ui:3', status: 'sending', message_id: null });
    await expect(
      sendMessageToConversation(db, 'acct', {
        conversationId: 'cv-1', messageType: 'text', contentText: 'hi', clientMessageId: 'ui:3',
      }),
    ).rejects.toMatchObject({ code: 'duplicate_request', status: 409 });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
