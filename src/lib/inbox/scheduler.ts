/**
 * Scheduled-message worker (inbox parity). Drains `scheduled_messages`
 * (migration 044), driven by `GET /api/inbox/cron`.
 *
 * Durability / duplicate prevention:
 *   - Rows are claimed with `claim_scheduled_messages` (FOR UPDATE SKIP
 *     LOCKED + a lease). Competing workers never claim the same row at
 *     once; a crashed worker's rows become claimable when the lease ends.
 *   - Every send uses the outbound idempotency key
 *     `scheduled:<schedule id>`. A reclaimed row therefore can't send a
 *     second WhatsApp message: if the first attempt reached the provider,
 *     its message row exists and is reconciled instead of re-sent.
 *   - Completion writes are conditional on `locked_by = <this worker>`,
 *     so a worker whose lease expired can't overwrite the new owner.
 *
 * Execution-time checks (nothing is trusted from schedule time): the
 * creator must still be an agent+ of the account, and the send core
 * re-checks block / opt-out / the 24h window. A free-form schedule whose
 * window has closed FAILS with a clear reason — it is never swapped for
 * different content.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message';

export interface ScheduledMessageRow {
  id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  created_by: string;
  message_type: 'text' | 'template';
  content_text: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: { body?: string[]; headerText?: string; buttonParams?: Record<number, string> } | null;
  scheduled_for: string;
  attempts: number;
}

export type ScheduleOutcome =
  | { id: string; result: 'sent'; messageId: string }
  | { id: string; result: 'failed'; error: string }
  | { id: string; result: 'skipped'; reason: string };

export const scheduledClientMessageId = (scheduleId: string) => `scheduled:${scheduleId}`;

/** Human-readable failure for the drawer. */
export function describeSendFailure(err: unknown): string {
  if (err instanceof SendMessageError) {
    switch (err.code) {
      case 'window_closed':
        return 'The 24-hour customer window was closed at send time. Schedule an approved template instead.';
      case 'contact_blocked':
        return 'The contact is blocked in the CRM.';
      case 'contact_opted_out':
        return 'The contact opted out of business-initiated messages.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

async function finish(
  db: SupabaseClient,
  worker: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data } = await db
    .from('scheduled_messages')
    .update({ ...patch, locked_until: null })
    .eq('id', id)
    .eq('status', 'processing')
    .eq('locked_by', worker)
    .select('id')
    .maybeSingle();
  return !!data;
}

/** Process one claimed row. Exported for tests. */
export async function processScheduledMessage(
  db: SupabaseClient,
  worker: string,
  row: ScheduledMessageRow,
): Promise<ScheduleOutcome> {
  const clientMessageId = scheduledClientMessageId(row.id);

  // Reclaimed after a crash: reconcile with whatever the first attempt did.
  if (row.attempts > 1) {
    const { data: prior } = await db
      .from('messages')
      .select('id, status, message_id')
      .eq('conversation_id', row.conversation_id)
      .eq('client_message_id', clientMessageId)
      .maybeSingle();
    const p = prior as { id: string; status: string; message_id: string | null } | null;
    if (p) {
      if (p.message_id && ['sent', 'delivered', 'read'].includes(p.status)) {
        await finish(db, worker, row.id, { status: 'sent', message_id: p.id, sent_at: new Date().toISOString(), error: null });
        return { id: row.id, result: 'sent', messageId: p.id };
      }
      // Pending with no provider id: the earlier attempt may or may not
      // have reached WhatsApp. Don't guess — fail visibly.
      const error =
        p.status === 'failed'
          ? 'The send failed on an earlier attempt.'
          : 'Delivery is uncertain after a worker interruption. Check the chat before re-sending.';
      await finish(db, worker, row.id, { status: 'failed', message_id: p.id, error });
      return { id: row.id, result: 'failed', error };
    }
  }

  // The creator must still be allowed to send in this account.
  const { data: creator } = await db
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', row.created_by)
    .maybeSingle();
  const c = creator as { account_id: string; account_role: string } | null;
  if (!c || c.account_id !== row.account_id || !['owner', 'admin', 'agent'].includes(c.account_role)) {
    const error = 'The person who scheduled this no longer has permission to send in this account.';
    await finish(db, worker, row.id, { status: 'failed', error });
    return { id: row.id, result: 'failed', error };
  }

  try {
    const params = row.template_params ?? {};
    const result = await sendMessageToConversation(db, row.account_id, {
      conversationId: row.conversation_id,
      messageType: row.message_type,
      contentText: row.message_type === 'text' ? row.content_text : null,
      templateName: row.template_name,
      templateLanguage: row.template_language,
      templateParams: params.body ?? [],
      templateMessageParams: row.message_type === 'template' ? params : undefined,
      senderId: row.created_by,
      clientMessageId,
    });
    await finish(db, worker, row.id, {
      status: 'sent',
      message_id: result.messageId,
      sent_at: new Date().toISOString(),
      error: null,
    });
    return { id: row.id, result: 'sent', messageId: result.messageId };
  } catch (err) {
    const error = describeSendFailure(err);
    await finish(db, worker, row.id, { status: 'failed', error });
    return { id: row.id, result: 'failed', error };
  }
}

export async function runScheduledMessagesWorker(
  db: SupabaseClient,
  worker: string,
  limit = 20,
): Promise<ScheduleOutcome[]> {
  const { data, error } = await db.rpc('claim_scheduled_messages', {
    p_worker: worker,
    p_limit: limit,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(`claim failed: ${error.message}`);
  const outcomes: ScheduleOutcome[] = [];
  // Sequential on purpose: keeps per-number send rate modest.
  for (const row of (data ?? []) as ScheduledMessageRow[]) {
    outcomes.push(await processScheduledMessage(db, worker, row));
  }
  return outcomes;
}
