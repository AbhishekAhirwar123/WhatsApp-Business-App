/**
 * Client data layer for the server-driven inbox (migration 044 RPCs).
 *
 * The list, its badges and saved-view counts all come from SQL functions
 * that share ONE predicate (`inbox_conversation_matches`) and run as the
 * caller under RLS — so a badge can never disagree with the list, and a
 * user can never count rows they could not open.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation } from '@/types';
import {
  INBOX_CONVERSATION_SELECT,
  LATEST_MESSAGE_EMBED,
  normalizeConversation,
  sortConversations,
  withLastSender,
} from '@/lib/inbox/conversations';
import { isMissingSchemaError } from '@/lib/db/schema-compat';

export type InboxQueue =
  | 'open'
  | 'pending'
  | 'closed'
  | 'awaiting'
  | 'unread'
  | 'all'
  | 'unassigned'
  | 'sla_breached';

export type InboxScope = 'all' | 'mine';
export type InboxSortKey = 'newest' | 'waiting_longest';

/** Same keys as the SQL `p_filters` JSON. Empty values mean "no filter". */
export interface InboxFilters {
  queue: InboxQueue;
  scope: InboxScope;
  assignee?: string | null;
  tag_ids?: string[];
  field_id?: string | null;
  field_value?: string | null;
  /** Last-activity range, inclusive start / exclusive end (ISO). */
  date_from?: string | null;
  date_to?: string | null;
  search?: string | null;
}

export const DEFAULT_FILTERS: InboxFilters = { queue: 'open', scope: 'all' };

export const QUEUE_LABELS: Record<InboxQueue, string> = {
  open: 'Open',
  pending: 'Pending',
  // The reference product titles the closed queue "Resolved".
  closed: 'Resolved',
  awaiting: 'Awaiting reply',
  unread: 'Unread',
  all: 'All',
  unassigned: 'Unassigned',
  sla_breached: 'SLA breached',
};

export interface InboxCursor {
  k1: number;
  k2: number;
  id: string;
}

export interface InboxPage {
  rows: Conversation[];
  next: InboxCursor | null;
  /** True when migration 044 is missing and the list was built in the browser. */
  basic?: boolean;
}

export const PAGE_SIZE = 50;

/** Drop empty values so the JSON sent to SQL is minimal and canonical. */
export function compactFilters(f: InboxFilters): Record<string, unknown> {
  const out: Record<string, unknown> = { queue: f.queue, scope: f.scope };
  if (f.assignee) out.assignee = f.assignee;
  if (f.tag_ids && f.tag_ids.length > 0) out.tag_ids = [...f.tag_ids].sort();
  if (f.field_id && f.field_value?.trim()) {
    out.field_id = f.field_id;
    out.field_value = f.field_value.trim();
  }
  if (f.date_from) out.date_from = f.date_from;
  if (f.date_to) out.date_to = f.date_to;
  if (f.search?.trim()) out.search = f.search.trim();
  return out;
}

export async function fetchInboxPage(
  db: SupabaseClient,
  filters: InboxFilters,
  sort: InboxSortKey,
  cursor: InboxCursor | null,
  limit = PAGE_SIZE,
): Promise<InboxPage> {
  const { data, error } = await db.rpc('inbox_query', {
    p_filters: compactFilters(filters),
    p_sort: sort,
    p_limit: limit,
    p_cursor_k1: cursor?.k1 ?? null,
    p_cursor_k2: cursor?.k2 ?? null,
    p_cursor_id: cursor?.id ?? null,
  });
  if (error) {
    if (isMissingSchemaError(error)) return fetchInboxPageBasic(db, filters, sort, cursor, limit);
    throw new Error(error.message);
  }

  const keys = (data ?? []) as {
    conversation_id: string;
    sort_k1: number;
    sort_k2: number;
    my_last_read_at: string | null;
    my_unread_count: number;
    sla_due_at: string | null;
  }[];
  if (keys.length === 0) return { rows: [], next: null };

  const { data: rows, error: rowsErr } = await db
    .from('conversations')
    .select(INBOX_CONVERSATION_SELECT)
    .in('id', keys.map((k) => k.conversation_id))
    .order('created_at', { referencedTable: LATEST_MESSAGE_EMBED, ascending: false })
    .limit(1, { referencedTable: LATEST_MESSAGE_EMBED });
  if (rowsErr) throw new Error(rowsErr.message);

  const byId = new Map(
    (rows ?? []).map((r) => {
      const c = withLastSender(normalizeConversation(r as Conversation));
      return [c.id, c] as const;
    }),
  );
  // Keep the server's order; attach the per-user fields.
  const ordered: Conversation[] = [];
  for (const k of keys) {
    const c = byId.get(k.conversation_id);
    if (!c) continue;
    ordered.push({
      ...c,
      my_unread_count: k.my_unread_count,
      my_last_read_at: k.my_last_read_at,
      sla_due_at: k.sla_due_at,
    });
  }
  const last = keys[keys.length - 1];
  return {
    rows: ordered,
    next: keys.length < limit ? null : { k1: last.sort_k1, k2: last.sort_k2, id: last.conversation_id },
  };
}

/** `"all:open" → 12`, `"mine:awaiting" → 3`, …, plus `sla_enabled`. */
export interface InboxCounts {
  [key: string]: number | boolean | undefined;
  sla_enabled?: boolean;
  /** Set when counts were computed in the browser (migration 044 missing). */
  basic_mode?: boolean;
}

export async function fetchInboxCounts(
  db: SupabaseClient,
  filters: InboxFilters,
): Promise<InboxCounts> {
  const { data, error } = await db.rpc('inbox_counts', { p_filters: compactFilters(filters) });
  if (error) {
    if (isMissingSchemaError(error)) return fetchInboxCountsBasic(db, filters);
    throw new Error(error.message);
  }
  return (data ?? {}) as InboxCounts;
}

// ── Basic mode (migration 044 not applied yet) ───────────────────────
// Loads the account's conversations directly (RLS-scoped) and applies the
// same queue rules in the browser. Per-user unread falls back to the
// shared counter, awaiting reply is derived from who sent the latest
// message, and custom-field filters / SLA are unavailable.

const BASIC_MAX_ROWS = 2000;

async function loadBasicRows(db: SupabaseClient): Promise<Conversation[]> {
  const rows: Conversation[] = [];
  for (let from = 0; from < BASIC_MAX_ROWS; from += 500) {
    const { data, error } = await db
      .from('conversations')
      .select(INBOX_CONVERSATION_SELECT)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { referencedTable: LATEST_MESSAGE_EMBED, ascending: false })
      .limit(1, { referencedTable: LATEST_MESSAGE_EMBED })
      .range(from, from + 499);
    if (error) throw new Error(error.message);
    const page = (data ?? []).map((r) => {
      const c = withLastSender(normalizeConversation(r as Conversation));
      return {
        ...c,
        my_unread_count: c.unread_count ?? 0,
        awaiting_reply_since:
          c.last_sender === 'customer' && c.status !== 'closed' ? (c.last_sender_at ?? null) : null,
      };
    });
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

function basicMatches(c: Conversation, f: InboxFilters, userId: string | null): boolean {
  if (!rowMatchesQueue(c, f, userId)) return false;
  if (f.tag_ids?.length && !(c.contact?.tags ?? []).some((t) => f.tag_ids!.includes(t.id))) return false;
  const activity = c.last_message_at ?? c.created_at;
  if (f.date_from && activity < f.date_from) return false;
  if (f.date_to && activity >= f.date_to) return false;
  const q = f.search?.trim().toLowerCase();
  if (q) {
    const hay = `${c.contact?.name ?? ''} ${c.contact?.phone ?? ''} ${c.last_message_text ?? ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

async function currentUserId(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.auth.getSession();
  return data.session?.user.id ?? null;
}

async function fetchInboxPageBasic(
  db: SupabaseClient,
  filters: InboxFilters,
  sort: InboxSortKey,
  cursor: InboxCursor | null,
  limit: number,
): Promise<InboxPage> {
  const [all, userId] = await Promise.all([loadBasicRows(db), currentUserId(db)]);
  const matched = sortConversations(all.filter((c) => basicMatches(c, filters, userId)), sort);
  // Offset cursor in basic mode (k1 = -1 marks it).
  const offset = cursor && cursor.k1 === -1 ? cursor.k2 : 0;
  const rows = matched.slice(offset, offset + limit);
  const nextOffset = offset + rows.length;
  return {
    rows,
    next: nextOffset < matched.length ? { k1: -1, k2: nextOffset, id: '' } : null,
    basic: true,
  };
}

async function fetchInboxCountsBasic(db: SupabaseClient, filters: InboxFilters): Promise<InboxCounts> {
  const [all, userId] = await Promise.all([loadBasicRows(db), currentUserId(db)]);
  const out: InboxCounts = { sla_enabled: false, basic_mode: true };
  const queues: InboxQueue[] = ['open', 'pending', 'closed', 'awaiting', 'unread', 'all', 'unassigned'];
  for (const scope of ['all', 'mine'] as InboxScope[]) {
    for (const queue of queues) {
      if (scope === 'mine' && queue === 'unassigned') continue;
      const f = { ...filters, scope, queue };
      out[`${scope}:${queue}`] = all.filter((c) => basicMatches(c, f, userId)).length;
    }
  }
  return out;
}

export function countFor(counts: InboxCounts | null, scope: InboxScope, queue: InboxQueue): number | null {
  const v = counts?.[`${scope}:${queue}`];
  return typeof v === 'number' ? v : null;
}

export function formatCount(n: number | null): string {
  if (n === null) return '…';
  return n > 999 ? '1K+' : String(n);
}

// ── Saved views ──────────────────────────────────────────────────────

export interface InboxView {
  id: string;
  name: string;
  owner_user_id: string | null;
  filters: Partial<InboxFilters>;
  position: number;
}

export async function fetchViews(db: SupabaseClient): Promise<InboxView[]> {
  const { data, error } = await db
    .from('inbox_views')
    .select('id, name, owner_user_id, filters, position')
    .order('position')
    .order('created_at');
  if (error) {
    // Saved views arrive with migration 044; none exist before it.
    if (isMissingSchemaError(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as InboxView[];
}

export async function fetchViewCounts(db: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await db.rpc('inbox_view_counts');
  if (error) {
    if (isMissingSchemaError(error)) return {};
    throw new Error(error.message);
  }
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { view_id: string; total: number }[]) out[r.view_id] = r.total;
  return out;
}

/** A view's predicates applied on top of defaults. */
export function filtersForView(view: InboxView): InboxFilters {
  return { ...DEFAULT_FILTERS, queue: 'all', ...view.filters } as InboxFilters;
}

// ── URL state ────────────────────────────────────────────────────────

const QUEUES = Object.keys(QUEUE_LABELS) as InboxQueue[];

/** Serialise filters into URL params (only non-default values). */
export function filtersToParams(
  f: InboxFilters,
  extra: { view?: string | null; sort?: InboxSortKey } = {},
): URLSearchParams {
  const p = new URLSearchParams();
  if (extra.view) p.set('view', extra.view);
  if (f.queue !== DEFAULT_FILTERS.queue) p.set('q', f.queue);
  if (f.scope !== 'all') p.set('scope', f.scope);
  if (f.assignee) p.set('member', f.assignee);
  if (f.tag_ids?.length) p.set('tags', f.tag_ids.join(','));
  if (f.field_id && f.field_value) {
    p.set('field', f.field_id);
    p.set('fv', f.field_value);
  }
  if (f.date_from) p.set('from', f.date_from);
  if (f.date_to) p.set('to', f.date_to);
  if (f.search) p.set('s', f.search);
  if (extra.sort && extra.sort !== 'newest') p.set('sort', extra.sort);
  return p;
}

export function paramsToFilters(p: URLSearchParams): {
  filters: InboxFilters;
  view: string | null;
  sort: InboxSortKey;
} {
  const q = p.get('q');
  const tags = p.get('tags');
  return {
    filters: {
      queue: q && (QUEUES as string[]).includes(q) ? (q as InboxQueue) : DEFAULT_FILTERS.queue,
      scope: p.get('scope') === 'mine' ? 'mine' : 'all',
      assignee: p.get('member') || null,
      tag_ids: tags ? tags.split(',').filter(Boolean) : [],
      field_id: p.get('field') || null,
      field_value: p.get('fv') || null,
      date_from: p.get('from') || null,
      date_to: p.get('to') || null,
      search: p.get('s') || null,
    },
    view: p.get('view'),
    sort: p.get('sort') === 'waiting_longest' ? 'waiting_longest' : 'newest',
  };
}

/**
 * Client-side mirror of the SQL predicate for rows that arrive via
 * realtime between refetches. Only fields present on the row are
 * checked; anything it can't evaluate (tags/custom field/search on the
 * contact) is left to the next server refetch.
 */
export function rowMatchesQueue(
  c: Conversation,
  f: InboxFilters,
  userId: string | null,
): boolean {
  if (f.scope === 'mine' && c.assigned_agent_id !== userId) return false;
  if (f.assignee && c.assigned_agent_id !== f.assignee) return false;
  switch (f.queue) {
    case 'open':
    case 'pending':
    case 'closed':
      return c.status === f.queue;
    case 'awaiting':
      return !!c.awaiting_reply_since && c.status !== 'closed';
    case 'unread':
      return (c.my_unread_count ?? 0) > 0;
    case 'unassigned':
      return !c.assigned_agent_id && c.status !== 'closed';
    case 'sla_breached':
      return !!c.sla_due_at && Date.parse(c.sla_due_at) < Date.now();
    default:
      return true;
  }
}
