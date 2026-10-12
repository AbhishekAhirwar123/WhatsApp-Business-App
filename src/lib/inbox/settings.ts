import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Per-account inbox behaviour (table `inbox_settings`, migration 044).
 * An account without a row uses DEFAULT_INBOX_SETTINGS, which matches the
 * column defaults — so nothing changes until an admin opts in.
 */
export interface InboxSettings {
  reopen_on_inbound: boolean;
  sla_enabled: boolean;
  sla_first_response_minutes: number;
  sla_next_response_minutes: number;
  timezone: string;
  tag_selection_limit: number;
}

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  reopen_on_inbound: true,
  sla_enabled: false,
  sla_first_response_minutes: 15,
  sla_next_response_minutes: 30,
  timezone: 'Asia/Kolkata',
  tag_selection_limit: 50,
};

export async function loadInboxSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<InboxSettings> {
  const { data, error } = await db
    .from('inbox_settings')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return DEFAULT_INBOX_SETTINGS;
  return { ...DEFAULT_INBOX_SETTINGS, ...(data as Partial<InboxSettings>) };
}

/** SLA due time for a chat awaiting a reply, or null when not applicable. */
export function slaDueAt(
  conv: {
    status?: string | null;
    awaiting_reply_since?: string | null;
    first_human_reply_at?: string | null;
  },
  settings: InboxSettings,
): Date | null {
  if (!settings.sla_enabled || !conv.awaiting_reply_since || conv.status === 'closed') {
    return null;
  }
  const minutes = conv.first_human_reply_at
    ? settings.sla_next_response_minutes
    : settings.sla_first_response_minutes;
  return new Date(Date.parse(conv.awaiting_reply_since) + minutes * 60_000);
}
