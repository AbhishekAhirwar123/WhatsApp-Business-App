import type { Conversation, Contact, SenderType, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
};

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Inbox folders & sorting
// ---------------------------------------------------------------------------

/**
 * Inbox list select: {@link CONVERSATION_SELECT} plus the conversation's
 * latest message (sender + time), which is what "Awaiting reply" and the
 * "Waiting longest for reply" sort need. Must be paired with
 * {@link LATEST_MESSAGE_EMBED} ordering/limit so PostgREST returns one
 * message per conversation instead of the whole thread.
 */
export const INBOX_CONVERSATION_SELECT = `${CONVERSATION_SELECT}, latest_message:messages(sender_type, created_at)`;

/** Alias of the embedded latest message — the `referencedTable` for order/limit. */
export const LATEST_MESSAGE_EMBED = "latest_message";

type LatestMessage = { sender_type: SenderType; created_at: string };

/**
 * Lift the embedded latest message onto `last_sender` / `last_sender_at`.
 * Picks the newest row itself, so it's correct even if the embed limit was
 * not applied. Rows without the embed pass through unchanged.
 */
export function withLastSender<T extends Conversation>(
  conv: T & { latest_message?: LatestMessage[] | null },
): T {
  const { latest_message, ...rest } = conv;
  if (!latest_message) return conv;
  const latest = latest_message.reduce<LatestMessage | null>(
    (best, m) => (!best || m.created_at > best.created_at ? m : best),
    null,
  );
  return {
    ...(rest as unknown as T),
    last_sender: latest?.sender_type ?? null,
    last_sender_at: latest?.created_at ?? null,
  };
}

export type InboxFolder =
  | "open"
  | "pending"
  | "closed"
  | "awaiting"
  | "unread"
  | "all"
  | "mine"
  | "unassigned";

/** The customer spoke last and nobody has answered yet. */
export function isAwaitingReply(conv: Conversation): boolean {
  return conv.last_sender === "customer" && conv.status !== "closed";
}

export function matchesFolder(
  conv: Conversation,
  folder: InboxFolder,
  currentUserId: string | null,
): boolean {
  switch (folder) {
    case "open":
    case "pending":
    case "closed":
      return conv.status === folder;
    case "awaiting":
      return isAwaitingReply(conv);
    case "unread":
      return conv.unread_count > 0;
    case "mine":
      return !!currentUserId && conv.assigned_agent_id === currentUserId;
    case "unassigned":
      return !conv.assigned_agent_id && conv.status !== "closed";
    case "all":
    default:
      return true;
  }
}

export type InboxSort = "newest" | "waiting_longest";

/**
 * "newest": latest activity first (default). "waiting_longest": chats
 * awaiting a reply first, oldest unanswered customer message on top, then
 * everything else newest-first.
 */
export function sortConversations(
  list: Conversation[],
  sort: InboxSort,
): Conversation[] {
  const time = (c: Conversation) => c.last_message_at ?? c.updated_at ?? "";
  const newestFirst = (a: Conversation, b: Conversation) =>
    time(b).localeCompare(time(a));
  if (sort === "newest") return [...list].sort(newestFirst);
  return [...list].sort((a, b) => {
    const aw = isAwaitingReply(a);
    const bw = isAwaitingReply(b);
    if (aw !== bw) return aw ? -1 : 1;
    if (aw) {
      return (a.last_sender_at ?? time(a)).localeCompare(b.last_sender_at ?? time(b));
    }
    return newestFirst(a, b);
  });
}
