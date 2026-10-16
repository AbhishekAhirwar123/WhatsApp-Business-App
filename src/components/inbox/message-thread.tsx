"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  UserMinus,
  Check,
  CheckCircle2,
  Clock,
  ArrowDown,
  ArrowLeft,
  RefreshCw,
  RotateCcw,
  PanelRightOpen,
  PanelRightClose,
  Search,
  MoreVertical,
  CalendarClock,
  Megaphone,
  Bot,
  History,
  Eraser,
  Ban,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCan } from "@/hooks/use-can";
import { AddToGroupsDialog } from "./bulk-action-dialogs";
import type { RightPanelState } from "./inbox-right-panel";
import type { Tag } from "@/types";
import { format, isToday, isYesterday, differenceInHours } from "date-fns";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { MediaLightbox } from "./media-lightbox";
import { collectMediaGallery } from "@/lib/media/gallery";
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { AiThreadBanner } from "./ai-thread-banner";
import { buildReplyPreview } from "./reply-quote";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { toast } from "sonner";
import { isMissingSchemaError } from "@/lib/db/schema-compat";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
  /** Account members (assignee picker, sender attribution, events). */
  members?: Profile[];
  /** The contact row changed here (block / unblock). */
  onContactChange?: (contact: Contact) => void;
  /** Open a right-panel tab or drawer (search, scheduled, bot runs). */
  onOpenPanel?: (state: RightPanelState) => void;
  /** Message to scroll to (from message search); cleared via onFocusHandled. */
  focusMessageId?: string | null;
  onFocusHandled?: () => void;
}

/** Messages per page; older history loads on demand. */
const PAGE_SIZE = 50;

interface ConversationEvent {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  from_user_id: string | null;
  to_user_id: string | null;
  from_value: string | null;
  to_value: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

type TimelineItem =
  | { kind: "message"; at: string; message: Message }
  | { kind: "event"; at: string; event: ConversationEvent };

function formatDateSeparator(dateStr: string, t: ReturnType<typeof useTranslations>): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t("today");
  if (isYesterday(date)) return t("yesterday");
  return format(date, "MMMM d, yyyy");
}

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}

const STATUS_NAMES: Record<string, string> = { open: "Open", pending: "Pending", closed: "Resolved" };

/** Readable timeline text for an audit event, e.g. "Neha assigned conversation to self". */
function describeEvent(
  e: ConversationEvent,
  nameOf: (id: string | null) => string,
  meId: string | undefined,
): string {
  const actor = e.actor_user_id ? (e.actor_user_id === meId ? "You" : nameOf(e.actor_user_id)) : "System";
  switch (e.event_type) {
    case "assigned":
      if (e.to_user_id && e.to_user_id === e.actor_user_id) return `${actor} assigned conversation to self`;
      return `Conversation assigned to ${nameOf(e.to_user_id)} by ${actor}`;
    case "unassigned":
      return `${actor} unassigned ${nameOf(e.from_user_id)}`;
    case "status_changed":
      return `${actor} marked the chat ${STATUS_NAMES[e.to_value ?? ""] ?? e.to_value}`;
    case "collaborator_added":
      return `${actor} added ${nameOf(e.to_user_id)} as collaborator`;
    case "collaborator_removed":
      return `${actor} removed ${nameOf(e.from_user_id)} as collaborator`;
    case "contact_blocked":
      return `${actor} blocked this contact in the CRM`;
    case "contact_unblocked":
      return `${actor} unblocked this contact`;
    default:
      return e.event_type.replace(/_/g, " ");
  }
}

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
  members,
  onContactChange,
  onOpenPanel,
  focusMessageId,
  onFocusHandled,
}: MessageThreadProps) {
  const t = useTranslations("Inbox.messageThread");
  const tTimer = useTranslations("Inbox.sessionTimer");
  const tQuote = useTranslations("Inbox.replyQuote");

  const { user } = useAuth();
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [newBelow, setNewBelow] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignQuery, setAssignQuery] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupTags, setGroupTags] = useState<Tag[]>([]);
  const [groupsBusy, setGroupsBusy] = useState(false);
  const canSend = useCan("send-messages");
  const [clearedBefore, setClearedBefore] = useState<string | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // Which attachment the media viewer is showing. Lives here rather than in
  // the bubble so the viewer can page through every image/video in the
  // thread (issue #373). Paired with the conversation it belongs to and read
  // back through that check below, so switching threads closes the viewer
  // without an effect racing the messages refetch.
  const [openMedia, setOpenMedia] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    if (members) {
      setProfiles(members);
      return;
    }
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch profiles:", error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [members]);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: "" };

    // Find last customer message — loaded page or the server-maintained
    // last_inbound_at (older history may not be loaded).
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");
    const lastInbound = [lastCustomerMsg?.created_at, conversation?.last_inbound_at]
      .filter((x): x is string => !!x)
      .sort()
      .pop();

    // Business-started chat: not an error, just waiting for the first reply.
    if (!lastInbound) return { expired: true, awaiting: true, remaining: tTimer("noCustomerMessages") };

    const hoursSince = differenceInHours(new Date(), new Date(lastInbound));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: tTimer("expired") };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? tTimer("xhRemaining", { hours: Math.floor(hoursLeft) })
        : tTimer("xmRemaining", { minutes: Math.floor(hoursLeft * 60) });

    return { expired, remaining };
  }, [messages, tTimer, conversation?.last_inbound_at]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  const mediaMessageId =
    openMedia && openMedia.conversationId === conversationId
      ? openMedia.messageId
      : null;
  const handleMediaChange = useCallback(
    (messageId: string | null) => {
      setOpenMedia(
        messageId && conversationId ? { conversationId, messageId } : null,
      );
    },
    [conversationId],
  );

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);
      setLoadError(null);

      // Newest page only; older history loads on demand (loadOlder).
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch messages:", error);
        setLoadError(error.message);
      } else {
        const rows = (data ?? []).reverse();
        setHasOlder(rows.length === PAGE_SIZE);
        stickToBottomRef.current = true;
        onMessagesLoadedRef.current(rows);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .eq("conversation_id", conversationId);
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch reactions:", error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith("temp-") &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id,
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversationId)
      .then(({ error }) => {
        if (error) console.error("Failed to reset unread_count:", error);
      });
  }, [conversationId, hasUnread]);

  // ── Scrolling ──────────────────────────────────────────────────────
  // Stick to the bottom only while the agent is already there. A new
  // inbound message must not yank someone reading older history; they
  // get a "new messages" pill instead. Prepending older pages keeps the
  // viewport anchored on what they were reading.
  const prevEdgesRef = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = messages[0]?.id;
    const last = messages[messages.length - 1]?.id;
    const prev = prevEdgesRef.current;
    if (prev.last === last && prev.first !== first && prev.first) {
      // Older page prepended: keep the same content in view.
      el.scrollTop += el.scrollHeight - prev.height;
    } else if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (prev.last && prev.last !== last) {
      setNewBelow(true);
    }
    prevEdgesRef.current = { first, last, height: el.scrollHeight };
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottomRef.current = nearBottom;
    if (nearBottom) setNewBelow(false);
    prevEdgesRef.current.height = el.scrollHeight;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setNewBelow(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  // ── Older history ───────────────────────────────────────────────────
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });

  const loadOlder = useCallback(async (): Promise<Message[]> => {
    const current = messagesRef.current;
    const oldest = current.find((m) => !m.id.startsWith("temp-"));
    if (!conversationId || !oldest || loadingOlder) return [];
    setLoadingOlder(true);
    stickToBottomRef.current = false;
    const { data, error } = await createClient()
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .lt("created_at", oldest.created_at)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);
    setLoadingOlder(false);
    if (error) {
      toast.error(`Couldn't load older messages: ${error.message}`);
      return [];
    }
    const older = (data ?? []).reverse() as Message[];
    setHasOlder(older.length === PAGE_SIZE);
    if (older.length) {
      prevEdgesRef.current.height = scrollRef.current?.scrollHeight ?? 0;
      onMessagesLoadedRef.current([...older, ...messagesRef.current]);
    }
    return older;
  }, [conversationId, loadingOlder]);

  // ── Jump to a message (from message search) ─────────────────────────
  useEffect(() => {
    if (!focusMessageId || !conversationId) return;
    let cancelled = false;
    (async () => {
      if (!messagesRef.current.some((m) => m.id === focusMessageId)) {
        // Load the segment from the target up to what's already loaded.
        const supabase = createClient();
        const { data: target } = await supabase
          .from("messages")
          .select("created_at")
          .eq("id", focusMessageId)
          .eq("conversation_id", conversationId)
          .maybeSingle();
        const oldest = messagesRef.current.find((m) => !m.id.startsWith("temp-"));
        if (!target || !oldest || cancelled) {
          onFocusHandled?.();
          return;
        }
        const { data } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", conversationId)
          .gte("created_at", target.created_at)
          .lt("created_at", oldest.created_at)
          .order("created_at", { ascending: true })
          .limit(2000);
        if (cancelled) return;
        stickToBottomRef.current = false;
        onMessagesLoadedRef.current([...((data ?? []) as Message[]), ...messagesRef.current]);
        setHasOlder(true);
      }
      // Wait a frame for the DOM, then scroll + highlight.
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${focusMessageId}`);
        if (el) {
          stickToBottomRef.current = false;
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          setHighlightId(focusMessageId);
          setTimeout(() => setHighlightId((h) => (h === focusMessageId ? null : h)), 2500);
        }
        onFocusHandled?.();
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [focusMessageId, conversationId, onFocusHandled]);

  // ── System events (assignment, status, collaborators, block) ────────
  useEffect(() => {
    if (!conversationId) {
      setEvents([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    supabase
      .from("conversation_events")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at")
      .limit(500)
      .then(({ data }) => {
        if (!cancelled) setEvents((data as ConversationEvent[] | null) ?? []);
      });
    const channel = supabase
      .channel(`conv-events:${conversationId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversation_events", filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const row = payload.new as ConversationEvent;
          setEvents((prev) => (prev.some((e) => e.id === row.id) ? prev : [...prev, row]));
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [conversationId, resyncToken]);

  useEffect(() => {
    if (!groupsOpen) return;
    createClient()
      .from("tags")
      .select("*")
      .order("name")
      .then(({ data }) => setGroupTags(((data as Tag[] | null) ?? []).filter((x) => !x.archived_at)));
  }, [groupsOpen]);

  // ── Per-user "clear chat" ───────────────────────────────────────────
  useEffect(() => {
    if (!conversationId || !user?.id) {
      setClearedBefore(null);
      return;
    }
    let cancelled = false;
    createClient()
      .from("conversation_clears")
      .select("cleared_before")
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setClearedBefore((data?.cleared_before as string | undefined) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, user?.id]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "text",
        content_text: text,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            // Idempotency key: a duplicated request returns the original
            // message instead of sending a second WhatsApp message.
            client_message_id: tempId,
            message_type: "text",
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send message:", reason);
          toast.error(t("sendFailed", { reason }));
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === "document"
          ? payload.caption || payload.filename || "Document"
          : payload.caption;

      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            // Idempotency key: a duplicated request returns the original
            // message instead of sending a second WhatsApp message.
            client_message_id: tempId,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send media:", reason);
          toast.error(t("sendFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "interactive",
        content_text: payload.body,
        interactive_payload: payload,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            // Idempotency key: a duplicated request returns the original
            // message instead of sending a second WhatsApp message.
            client_message_id: tempId,
            message_type: "interactive",
            interactive_payload: payload,
            reply_to_message_id: replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send interactive message:", reason);
          toast.error(t("sendFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send interactive message:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ status })
        .eq("id", conversation.id);
      if (error) {
        toast.error(`Couldn't update the chat: ${error.message}`);
        return;
      }
      onStatusChange(conversation.id, status);
      toast.success(status === "closed" ? "Chat resolved" : status === "open" ? "Chat reopened" : "Chat marked pending");
    },
    [conversation, onStatusChange]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      },
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "template",
        content_text: renderedBody,
        template_name: template.name,
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            // Idempotency key: a duplicated request returns the original
            // message instead of sending a second WhatsApp message.
            client_message_id: tempId,
            message_type: "template",
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send template:", reason);
          toast.error(t("sendTemplateFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send template:", err);
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("sendTemplateFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Images + videos in the thread, in order — the set the media viewer
  // pages through with ← / →.
  const mediaGallery = useMemo(() => collectMediaGallery(messages), [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName =
    contact?.name || (contact ? contactHandle(contact) : "") || t("customer");

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" || m.sender_type === "bot";
      return isAgentMsg ? "You" : contactDisplayName;
    },
    [contactDisplayName],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor],
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn("[reactions] missing user or conversation");
        return;
      }
      if (messageId.startsWith("temp-")) {
        toast.error(t("waitForSending"));
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === "agent" &&
            r.actor_id === userId,
        );
        if (emoji === "") return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: "agent",
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch("/api/whatsapp/react", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "network error";
        toast.error(t("reactionFailed", { reason }));
        setReactions(snapshot);
      }
    },
    [conversation, user?.id, t],
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      // Compare-and-set: only applies if nobody reassigned the chat
      // since we loaded it, so two agents can't silently overwrite each
      // other. The DB logs the change (actor, from, to) in
      // conversation_events.
      const expected = conversation.assigned_agent_id ?? null;
      const supabase = createClient();
      let { data, error } = await supabase.rpc("assign_conversation", {
        p_conversation_id: conversation.id,
        p_assignee: agentId,
        p_expected_assignee: expected,
        p_check_expected: true,
      });
      if (error && isMissingSchemaError(error)) {
        // Migration 044 not applied: plain update (no race check / audit).
        ({ error } = await supabase
          .from("conversations")
          .update({ assigned_agent_id: agentId })
          .eq("id", conversation.id));
        data = error ? null : { ok: true, assigned_agent_id: agentId };
      }

      if (error) {
        console.error("Failed to update assignment:", error);
        toast.error(error.message || t("assignmentUpdateFailed"));
        return;
      }
      const result = data as { ok: boolean; conflict?: boolean; assigned_agent_id?: string | null };
      if (!result.ok && result.conflict) {
        const current = result.assigned_agent_id ?? null;
        const who = profiles.find((p) => p.user_id === current)?.full_name;
        toast.warning(
          current
            ? `${who ?? "Someone"} was just assigned by a teammate. Check before reassigning.`
            : "This chat was just unassigned by a teammate.",
        );
        onAssignChange(conversation.id, current);
        return;
      }
      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange, t, profiles],
  );

  // ── Clear chat (for me only) ────────────────────────────────────────
  const handleClearChat = useCallback(async () => {
    if (!conversation || !user?.id) return;
    if (!window.confirm("Clear this chat for you? Messages are hidden only from your view — your team and the customer still have the full history. You can undo.")) return;
    const supabase = createClient();
    const cutoff = new Date().toISOString();
    const { error } = await supabase.from("conversation_clears").upsert(
      {
        conversation_id: conversation.id,
        user_id: user.id,
        account_id: (conversation as Conversation & { account_id?: string }).account_id,
        cleared_before: cutoff,
      },
      { onConflict: "conversation_id,user_id" },
    );
    if (error) {
      toast.error(`Couldn't clear chat: ${error.message}`);
      return;
    }
    setClearedBefore(cutoff);
    toast("Chat cleared for you", {
      action: {
        label: "Undo",
        onClick: async () => {
          await supabase
            .from("conversation_clears")
            .delete()
            .eq("conversation_id", conversation.id)
            .eq("user_id", user.id);
          setClearedBefore(null);
        },
      },
    });
  }, [conversation, user?.id]);

  const handleRestoreHistory = useCallback(async () => {
    if (!conversation || !user?.id) return;
    await createClient()
      .from("conversation_clears")
      .delete()
      .eq("conversation_id", conversation.id)
      .eq("user_id", user.id);
    setClearedBefore(null);
  }, [conversation, user?.id]);

  // ── Local CRM block ─────────────────────────────────────────────────
  const handleToggleBlock = useCallback(async () => {
    if (!contact) return;
    const blocking = !contact.blocked_at;
    let reason: string | null = null;
    if (blocking) {
      const input = window.prompt(
        "Block this contact in the CRM? No messages, scheduled messages, broadcasts or automations will be sent to them. Incoming messages are still received.\n\nReason (optional):",
        "",
      );
      if (input === null) return;
      reason = input.trim() || null;
    }
    const { data, error } = await createClient()
      .from("contacts")
      .update(
        blocking
          ? { blocked_at: new Date().toISOString(), blocked_by: user?.id ?? null, blocked_reason: reason }
          : { blocked_at: null, blocked_by: null, blocked_reason: null },
      )
      .eq("id", contact.id)
      .select("*")
      .single();
    if (error || !data) {
      toast.error(`Couldn't ${blocking ? "block" : "unblock"}: ${error?.message ?? "unknown error"}`);
      return;
    }
    onContactChange?.({ ...contact, ...(data as Contact) });
    toast.success(blocking ? "Contact blocked in the CRM" : "Contact unblocked");
  }, [contact, user?.id, onContactChange]);

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center", DOODLE_BG_CLASSES)}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-muted-foreground">
          {t("selectConversation")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("selectConversationHint")}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const nameOf = (id: string | null) =>
    (id && profiles.find((p) => p.user_id === id)?.full_name) || "a teammate";
  // Messages hidden by this user's "clear chat" are filtered out locally;
  // shared history is untouched.
  const visibleMessages = clearedBefore
    ? messages.filter((m) => m.created_at > clearedBefore)
    : messages;
  const oldestLoaded = visibleMessages.find((m) => !m.id.startsWith("temp-"))?.created_at;
  const timeline: TimelineItem[] = [
    ...visibleMessages.map((m) => ({ kind: "message" as const, at: m.created_at, message: m })),
    // Only events within the loaded window, so paging stays coherent.
    ...events
      .filter((e) => (!oldestLoaded || e.created_at >= oldestLoaded || !hasOlder) && (!clearedBefore || e.created_at > clearedBefore))
      .map((e) => ({ kind: "event" as const, at: e.created_at, event: e })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const timelineGroups: { date: string; items: TimelineItem[] }[] = [];
  for (const item of timeline) {
    const day = format(new Date(item.at), "yyyy-MM-dd");
    const last = timelineGroups[timelineGroups.length - 1];
    if (last && format(new Date(last.date), "yyyy-MM-dd") === day) last.items.push(item);
    else timelineGroups.push({ date: item.at, items: [item] });
  }
  // Only active agents can hold a chat (the RPC enforces this too).
  const assignees = profiles.filter((p) => p.account_role !== "viewer");
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t("assigned"))
    : t("assign");

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn("flex min-w-0 flex-1 flex-col", DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("backToConversations")}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{displayName}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {contactHandle(contact)}
            </p>
          </div>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <Badge
            variant="outline"
            className={cn(
              "ml-1 hidden gap-1 border-border text-[10px] sm:inline-flex sm:ml-2",
              "awaiting" in sessionInfo
                ? "text-amber-500"
                : sessionInfo.expired
                  ? "text-red-400"
                  : "text-primary"
            )}
          >
            <Clock className="h-3 w-3" />
            {sessionInfo.remaining}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t("hideContactPanel") : t("showContactPanel")
              }
              title={contactPanelOpen ? t("hideContact") : t("showContact")}
              aria-pressed={contactPanelOpen}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground",
                contactPanelOpen ? "text-primary" : "text-muted-foreground",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t("refreshConversation")}
              title={t("refresh")}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60",
              )}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
            </button>
          )}

          {/* Resolve / reopen */}
          {conversation.status === "closed" ? (
            <button
              type="button"
              onClick={() => handleStatusChange("open")}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Reopen chat"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Reopen</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleStatusChange("closed")}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-primary"
              title="Mark as done (resolve)"
              aria-label="Mark as done"
            >
              <CheckCircle2 className="h-4 w-4" />
            </button>
          )}

          {/* Assignee picker */}
          <Popover open={assignOpen} onOpenChange={(o) => { setAssignOpen(o); if (!o) setAssignQuery(""); }}>
            <PopoverTrigger
              className={cn(
                "inline-flex h-7 max-w-40 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-muted",
                assignedAgentId ? "text-foreground" : "text-muted-foreground",
              )}
              aria-label="Assign conversation"
            >
              {assignedAgentId ? (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
                  {initialsOf(currentAssignee?.full_name || "?")}
                </span>
              ) : (
                <UserPlus className="h-3.5 w-3.5" />
              )}
              <span className="hidden truncate sm:inline">{assignLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-0">
              <div className="relative border-b border-border">
                <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus
                  value={assignQuery}
                  onChange={(e) => setAssignQuery(e.target.value)}
                  placeholder="Search members"
                  aria-label="Search members"
                  className="h-9 w-full bg-transparent pr-2 pl-8 text-xs outline-none"
                />
              </div>
              <div className="max-h-72 overflow-y-auto py-1">
                {user?.id && assignedAgentId !== user.id && (
                  <button
                    type="button"
                    onClick={() => { setAssignOpen(false); handleAssignChange(user.id); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-primary hover:bg-muted"
                  >
                    <UserPlus className="h-3.5 w-3.5" /> Assign to me
                  </button>
                )}
                {assignees
                  .filter((p) => `${p.full_name ?? ""} ${p.email ?? ""}`.toLowerCase().includes(assignQuery.trim().toLowerCase()))
                  .map((p) => {
                    const isSelected = p.user_id === assignedAgentId;
                    const presence = getPresence(p.user_id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setAssignOpen(false); if (!isSelected) handleAssignChange(p.user_id); }}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted",
                          isSelected ? "text-primary" : "text-popover-foreground",
                        )}
                      >
                        <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">
                          {initialsOf(p.full_name || p.email || "?")}
                          <PresenceDot
                            status={presence}
                            label={presenceLabel(presence, getRow(p.user_id)?.last_seen_at ?? null, now)}
                            className="absolute -right-0.5 -bottom-0.5"
                          />
                        </span>
                        <span className="flex-1 truncate">
                          {p.full_name || p.email}
                          {p.user_id === user?.id ? t("me") : ""}
                        </span>
                        {isSelected && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                {assignedAgentId && (
                  <button
                    type="button"
                    onClick={() => { setAssignOpen(false); handleAssignChange(null); }}
                    className="mt-1 flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
                  >
                    <UserMinus className="h-3.5 w-3.5" /> {t("unassign")}
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>

          {/* Message search */}
          {onOpenPanel && (
            <button
              type="button"
              onClick={() => onOpenPanel({ tab: "details", drawer: "search" })}
              title="Search messages"
              aria-label="Search messages in this chat"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          )}

          {/* Conversation menu */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Conversation actions"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60 border-border bg-popover">
              {onOpenPanel && (
                <DropdownMenuItem onClick={() => onOpenPanel({ tab: "details", drawer: "scheduled" })}>
                  <CalendarClock className="h-4 w-4" /> Schedule a message
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setGroupsOpen(true)}>
                <Megaphone className="h-4 w-4" /> Add to broadcast group
              </DropdownMenuItem>
              {conversation.status !== "pending" && (
                <DropdownMenuItem onClick={() => handleStatusChange("pending")}>
                  <Clock className="h-4 w-4" /> Mark as pending
                </DropdownMenuItem>
              )}
              {onOpenPanel && (
                <DropdownMenuItem onClick={() => onOpenPanel({ tab: "details", drawer: "bot_runs" })}>
                  <Bot className="h-4 w-4" /> View recent bot runs
                </DropdownMenuItem>
              )}
              {onRefresh && (
                <DropdownMenuItem onClick={handleRefreshClick}>
                  <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} /> {t("refresh")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="bg-border" />
              {clearedBefore ? (
                <DropdownMenuItem onClick={handleRestoreHistory}>
                  <History className="h-4 w-4" /> Show cleared history
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={handleClearChat}>
                  <Eraser className="h-4 w-4" /> Clear chat (for me)
                </DropdownMenuItem>
              )}
              {canSend && (
                <DropdownMenuItem variant={contact.blocked_at ? "default" : "destructive"} onClick={handleToggleBlock}>
                  <Ban className="h-4 w-4" /> {contact.blocked_at ? "Unblock contact" : "Block contact (CRM)"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {contact.blocked_at && (
        <div className="flex shrink-0 items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-4 py-1.5 text-xs text-red-600 dark:text-red-400" role="status">
          <Ban className="h-3.5 w-3.5" />
          Blocked in the CRM — sending is disabled. Incoming messages still arrive.
          {canSend && (
            <button type="button" onClick={handleToggleBlock} className="ml-auto font-medium underline">Unblock</button>
          )}
        </div>
      )}

      {/* Messages Area */}
      <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center" role="alert">
            <p className="text-sm text-foreground">Couldn&apos;t load messages</p>
            <p className="text-xs text-muted-foreground">{loadError}</p>
            {onRefresh && (
              <button type="button" onClick={handleRefreshClick} className="text-xs text-primary underline">Retry</button>
            )}
          </div>
        ) : timeline.length === 0 && !clearedBefore ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t("noMessagesYet")}</p>
            <p className="text-xs text-muted-foreground">
              {t("sendTemplateHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {hasOlder && !clearedBefore && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => loadOlder()}
                  disabled={loadingOlder}
                  className="rounded-full bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-sm hover:text-foreground disabled:opacity-60"
                >
                  {loadingOlder ? "Loading…" : "Load older messages"}
                </button>
              </div>
            )}
            {clearedBefore && (
              <div className="flex justify-center">
                <span className="rounded-full bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-sm">
                  Earlier messages are hidden for you ·{" "}
                  <button type="button" onClick={handleRestoreHistory} className="text-primary underline">Show</button>
                </span>
              </div>
            )}
            {timelineGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {formatDateSeparator(group.date, t)}
                  </span>
                </div>
                <div className="space-y-2">
                  {group.items.map((item) => {
                    if (item.kind === "event") {
                      return (
                        <div key={`ev-${item.event.id}`} className="flex justify-center">
                          <span className="max-w-[85%] rounded-md bg-card/90 px-3 py-1 text-center text-[11px] text-muted-foreground shadow-sm">
                            {describeEvent(item.event, nameOf, user?.id)}
                            <span className="ml-1.5 opacity-60">{format(new Date(item.at), "HH:mm")}</span>
                          </span>
                        </div>
                      );
                    }
                    const msg = item.message;
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel:
                            parent.sender_type === "agent" || parent.sender_type === "bot"
                              ? t("me")
                              : contact?.name || contact?.phone || t("unknown"),
                          preview: buildReplyPreview(parent, tQuote),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) => r.actor_type === "agent" && r.actor_id === user?.id,
                      );
                      const next = own?.emoji === emoji ? "" : emoji;
                      void postReaction(msg.id, next);
                    };
                    const senderLabel =
                      msg.sender_type === "bot"
                        ? "Bot"
                        : msg.sender_type === "agent" && msg.sender_id
                          ? nameOf(msg.sender_id)
                          : null;
                    return (
                      <div key={msg.id} id={`msg-${msg.id}`}>
                        <MessageActions
                          message={msg}
                          onReply={() => handleStartReply(msg)}
                          onReact={(emoji) => {
                            if (emoji) void postReaction(msg.id, emoji);
                          }}
                        >
                          <MessageBubble
                            message={msg}
                            reply={reply}
                            reactions={msgReactions}
                            currentUserId={user?.id}
                            onToggleReaction={handlePillToggle}
                            onOpenMedia={handleMediaChange}
                            senderLabel={senderLabel}
                            highlighted={highlightId === msg.id}
                          />
                        </MessageActions>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {newBelow && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-lg"
        >
          <ArrowDown className="h-3.5 w-3.5" /> New messages
        </button>
      )}
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        handoffSummary={conversation.ai_handoff_summary}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ("assigned_agent_id" in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={sessionInfo.expired}
        blocked={!!contact.blocked_at}
        draftKey={user?.id ? `wacrm:draft:${user.id}:${conversation.id}` : undefined}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendInteractive={handleSendInteractive}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />

      {/* "Add to broadcast group": audience membership (a tag) — not a
          sending channel and not a WhatsApp group chat. */}
      <AddToGroupsDialog
        open={groupsOpen}
        onOpenChange={setGroupsOpen}
        tags={groupTags}
        busy={groupsBusy}
        onApply={async (tagIds) => {
          setGroupsBusy(true);
          const { error } = await createClient()
            .from("contact_tags")
            .upsert(
              tagIds.map((tag_id) => ({ contact_id: contact.id, tag_id })),
              { onConflict: "contact_id,tag_id", ignoreDuplicates: true },
            );
          setGroupsBusy(false);
          if (error) {
            toast.error(`Couldn't add to group: ${error.message}`);
            return;
          }
          toast.success("Added to broadcast group");
          setGroupsOpen(false);
        }}
      />

      {/* Full-size viewer for the thread's images/videos. Renders nothing
          until a bubble opens it. */}
      <MediaLightbox
        items={mediaGallery}
        activeId={mediaMessageId}
        onActiveIdChange={handleMediaChange}
        contactLabel={contactDisplayName}
      />
    </div>
  );
}
