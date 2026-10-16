"use client";

import { Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import {
  INBOX_CONVERSATION_SELECT,
  LATEST_MESSAGE_EMBED,
  withLastSender,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import {
  DEFAULT_FILTERS,
  QUEUE_LABELS,
  fetchInboxCounts,
  fetchInboxPage,
  fetchViewCounts,
  fetchViews,
  filtersForView,
  filtersToParams,
  paramsToFilters,
  rowMatchesQueue,
  type InboxCounts,
  type InboxCursor,
  type InboxFilters,
  type InboxSortKey,
  type InboxView,
} from "@/lib/inbox/query";
import type {
  Conversation,
  Message,
  Contact,
  ConversationStatus,
  CustomField,
  Profile,
  Tag,
} from "@/types";
import { useRealtime } from "@/hooks/use-realtime";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { InboxRightPanel, type RightPanelState } from "@/components/inbox/inbox-right-panel";
import { InboxFiltersPanel } from "@/components/inbox/inbox-filters";
import { ViewTabs } from "@/components/inbox/view-tabs";
import { NewConversationDialog } from "@/components/inbox/new-conversation-dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { MIGRATION_044_NOTICE, isMissingSchemaError } from "@/lib/db/schema-compat";
import { Info, WifiOff, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Device-scoped layout preferences (like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";
const FILTERS_PANEL_STORAGE_KEY = "wacrm:inbox:filters-open";

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Persistence is best-effort.
  }
}

// `useSearchParams` requires a Suspense boundary or the production build
// bails to CSR and errors out. The inner component holds all state.
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

async function loadConversation(id: string): Promise<Conversation | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select(INBOX_CONVERSATION_SELECT)
    .eq("id", id)
    .order("created_at", { referencedTable: LATEST_MESSAGE_EMBED, ascending: false })
    .limit(1, { referencedTable: LATEST_MESSAGE_EMBED })
    .maybeSingle();
  if (error) {
    console.error("Failed to load conversation:", { message: error.message, code: error.code });
    return null;
  }
  return data ? withLastSender(normalizeConversation(data)) : null;
}

function InboxPageInner() {
  const t = useTranslations("Inbox.page");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, accountId } = useAuth();
  const userId = user?.id ?? null;
  const canSend = useCan("send-messages");
  const canAdmin = useCan("edit-settings");

  // ── URL state: filters, saved view, sort, open chat ────────────────
  const parsed = useMemo(() => paramsToFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  const filters = parsed.filters;
  const sort = parsed.sort;
  const activeViewId = parsed.view;
  const deepLinkConvId = searchParams.get("c");

  const pushUrl = useCallback(
    (next: { filters?: InboxFilters; sort?: InboxSortKey; view?: string | null; conv?: string | null }) => {
      const f = next.filters ?? filters;
      const params = filtersToParams(f, {
        view: next.view === undefined ? activeViewId : next.view,
        sort: next.sort ?? sort,
      });
      const conv = next.conv === undefined ? deepLinkConvId : next.conv;
      if (conv) params.set("c", conv);
      const qs = params.toString();
      router.replace(qs ? `/inbox?${qs}` : "/inbox", { scroll: false });
    },
    [filters, sort, activeViewId, deepLinkConvId, router],
  );

  const setFilters = useCallback(
    // Manually changing filters leaves the saved view (it no longer applies as-is).
    (next: InboxFilters) => pushUrl({ filters: next, view: null }),
    [pushUrl],
  );

  // ── Reference data ──────────────────────────────────────────────────
  const [members, setMembers] = useState<Profile[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [channelLabel, setChannelLabel] = useState<string | null>(null);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const [m, tg, cf] = await Promise.all([
        supabase.from("profiles").select("*").order("full_name"),
        supabase.from("tags").select("*").order("name"),
        // Sorted in the browser: `sort_order` only exists after migration 044.
        supabase.from("custom_fields").select("*").order("field_name"),
      ]);
      if (cancelled) return;
      setMembers((m.data as Profile[] | null) ?? []);
      setTags(((tg.data as Tag[] | null) ?? []).filter((x) => !x.archived_at));
      setCustomFields(
        ((cf.data as CustomField[] | null) ?? [])
          .filter((x) => !x.archived_at)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    supabase
      .from("whatsapp_config")
      .select("status, phone_number_id")
      .eq("account_id", accountId)
      .maybeSingle()
      .then(({ data }) => {
        setWhatsappConnected(data?.status === "connected");
      });
    // The display number lives at Meta; the config endpoint fetches it.
    fetch("/api/whatsapp/config")
      .then((r) => r.json())
      .then((d) => {
        const info = d?.phone_info as { display_phone_number?: string; verified_name?: string } | undefined;
        if (info?.display_phone_number) {
          setChannelLabel(info.verified_name ? `${info.verified_name} (${info.display_phone_number})` : info.display_phone_number);
        }
      })
      .catch(() => {});
  }, [accountId]);

  // ── Saved views ─────────────────────────────────────────────────────
  const [views, setViews] = useState<InboxView[]>([]);
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});
  const refreshViews = useCallback(async () => {
    const supabase = createClient();
    try {
      const [v, c] = await Promise.all([fetchViews(supabase), fetchViewCounts(supabase)]);
      setViews(v);
      setViewCounts(c);
    } catch (err) {
      console.error("Failed to load saved views:", err);
    }
  }, []);
  useEffect(() => {
    refreshViews();
  }, [refreshViews]);

  const selectView = useCallback(
    (view: InboxView | null) => {
      if (!view) pushUrl({ filters: DEFAULT_FILTERS, view: null });
      else pushUrl({ filters: filtersForView(view), view: view.id });
    },
    [pushUrl],
  );

  // ── Server-paged list ───────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<InboxCursor | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  // Migration 044 not applied yet: the list runs in basic mode.
  const [basicMode, setBasicMode] = useState(false);
  const listSeq = useRef(0);
  const filtersKey = JSON.stringify([filters, sort]);

  const loadFirstPage = useCallback(async () => {
    const seq = ++listSeq.current;
    setListLoading(true);
    setListError(null);
    try {
      const page = await fetchInboxPage(createClient(), filters, sort, null);
      if (seq !== listSeq.current) return;
      setConversations(page.rows);
      setCursor(page.next);
      setBasicMode(!!page.basic);
    } catch (err) {
      if (seq !== listSeq.current) return;
      setListError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const seq = listSeq.current;
    setLoadingMore(true);
    try {
      const page = await fetchInboxPage(createClient(), filters, sort, cursor);
      if (seq !== listSeq.current) return;
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      setCursor(page.next);
    } catch (err) {
      toast.error(`Couldn't load more: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loadingMore, filtersKey]);

  // Counts use every refinement except queue/scope (each badge is a queue).
  const refreshCounts = useCallback(async () => {
    try {
      setCounts(await fetchInboxCounts(createClient(), filters));
    } catch (err) {
      console.error("Failed to load inbox counts:", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  useEffect(() => {
    loadFirstPage();
    refreshCounts();
  }, [loadFirstPage, refreshCounts]);

  // Realtime changes refresh badges (debounced) rather than per event.
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCountsRefresh = useCallback(() => {
    if (countsTimer.current) clearTimeout(countsTimer.current);
    countsTimer.current = setTimeout(() => {
      refreshCounts();
      refreshViews();
    }, 1500);
  }, [refreshCounts, refreshViews]);

  // ── Active conversation ─────────────────────────────────────────────
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [resyncToken, setResyncToken] = useState(0);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);

  // Deep link: open ?c=<id> directly (it may not be on the first page or
  // in the current queue). RLS decides whether the user may see it.
  const deepLinkLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkConvId || deepLinkLoadedRef.current === deepLinkConvId) return;
    if (activeConversation?.id === deepLinkConvId) return;
    deepLinkLoadedRef.current = deepLinkConvId;
    loadConversation(deepLinkConvId).then((conv) => {
      if (!conv) {
        toast.error("That conversation isn't available to you.");
        return;
      }
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
    });
  }, [deepLinkConvId, activeConversation?.id]);

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      if (activeConversation?.id === conv.id) return;
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      deepLinkLoadedRef.current = conv.id;
      pushUrl({ conv: conv.id });
    },
    [activeConversation?.id, pushUrl],
  );

  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    deepLinkLoadedRef.current = null;
    pushUrl({ conv: null });
  }, [pushUrl]);

  // A conversation the user may still see but that no longer matches the
  // queue stays open (and listed) with an explanation, instead of
  // vanishing mid-reply.
  const activeLeftQueue =
    !!activeConversation && !rowMatchesQueue(activeConversation, filters, userId);
  const visibleConversations = useMemo(
    () =>
      conversations.filter(
        (c) => c.id === activeConversation?.id || rowMatchesQueue(c, filters, userId),
      ),
    [conversations, activeConversation?.id, filters, userId],
  );

  // ── Patching helpers ────────────────────────────────────────────────
  const patchConversation = useCallback((id: string, patch: Partial<Conversation>) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setActiveConversation((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
  }, []);

  const handleBulkUpdate = useCallback(
    (ids: string[], patch: Partial<Conversation>) => {
      const idSet = new Set(ids);
      setConversations((prev) => prev.map((c) => (idSet.has(c.id) ? { ...c, ...patch } : c)));
      setActiveConversation((prev) => (prev && idSet.has(prev.id) ? { ...prev, ...patch } : prev));
      scheduleCountsRefresh();
    },
    [scheduleCountsRefresh],
  );

  const handleBulkDelete = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      setConversations((prev) => prev.filter((c) => !idSet.has(c.id)));
      if (activeConversation && idSet.has(activeConversation.id)) handleCloseConversation();
      scheduleCountsRefresh();
    },
    [activeConversation, handleCloseConversation, scheduleCountsRefresh],
  );

  // ── Realtime ────────────────────────────────────────────────────────
  const knownIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    knownIdsRef.current = new Set(conversations.map((c) => c.id));
  }, [conversations]);

  const hydratingRef = useRef<Set<string>>(new Set());
  const hydrateConversation = useCallback(
    async (convId: string) => {
      if (hydratingRef.current.has(convId)) return;
      hydratingRef.current.add(convId);
      try {
        const conv = await loadConversation(convId);
        if (!conv) return;
        // Only surface it if it belongs in the current queue.
        if (!rowMatchesQueue({ ...conv, my_unread_count: conv.last_sender === "customer" ? 1 : 0 }, filters, userId)) return;
        setConversations((prev) => {
          if (prev.some((c) => c.id === conv.id)) {
            return prev.map((c) => (c.id === conv.id ? { ...c, contact: c.contact ?? conv.contact } : c));
          }
          return [{ ...conv, my_unread_count: conv.last_sender === "customer" ? 1 : 0 }, ...prev];
        });
      } finally {
        hydratingRef.current.delete(convId);
      }
    },
    [filters, userId],
  );

  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const msg = event.new;
      if (event.eventType === "INSERT") {
        const isActive = activeConversation?.id === msg.conversation_id;
        if (isActive) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev.filter((m) => !m.id.startsWith("temp-")), msg];
          });
        }
        if (knownIdsRef.current.has(msg.conversation_id)) {
          const fromCustomer = msg.sender_type === "customer";
          setConversations((prev) => {
            const updated = prev.map((c) =>
              c.id === msg.conversation_id
                ? {
                    ...c,
                    last_message_text: msg.content_text ?? c.last_message_text,
                    last_message_at: msg.created_at,
                    last_sender: msg.sender_type,
                    last_sender_at: msg.created_at,
                    last_message_status: msg.status,
                    my_unread_count:
                      fromCustomer && !isActive ? (c.my_unread_count ?? 0) + 1 : c.my_unread_count,
                  }
                : c,
            );
            // Newest activity first when sorting by newest.
            if (sort !== "newest") return updated;
            const idx = updated.findIndex((c) => c.id === msg.conversation_id);
            if (idx <= 0) return updated;
            const [row] = updated.splice(idx, 1);
            return [row, ...updated];
          });
        } else {
          hydrateConversation(msg.conversation_id);
        }
        scheduleCountsRefresh();
      }
      if (event.eventType === "UPDATE") {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)));
        setConversations((prev) =>
          prev.map((c) =>
            c.id === msg.conversation_id && c.last_sender_at === msg.created_at
              ? { ...c, last_message_status: msg.status }
              : c,
          ),
        );
      }
    },
    [activeConversation?.id, hydrateConversation, scheduleCountsRefresh, sort],
  );

  const handleConversationEvent = useCallback(
    (event: { eventType: string; new: Conversation; old: Partial<Conversation> }) => {
      const conv = event.new;
      if (event.eventType === "INSERT") {
        if (!knownIdsRef.current.has(conv.id)) hydrateConversation(conv.id);
      }
      if (event.eventType === "UPDATE") {
        // Realtime rows never carry joins or per-user fields; keep ours.
        const { contact: _ignored, ...cols } = conv;
        void _ignored;
        if (knownIdsRef.current.has(conv.id)) {
          setConversations((prev) => prev.map((c) => (c.id === conv.id ? { ...c, ...cols } : c)));
        } else {
          hydrateConversation(conv.id);
        }
        setActiveConversation((prev) => (prev && prev.id === conv.id ? { ...prev, ...cols } : prev));
      }
      if (event.eventType === "DELETE") {
        const id = (event.old as Partial<Conversation>).id;
        if (id) {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (activeConversation?.id === id) handleCloseConversation();
        }
      }
      scheduleCountsRefresh();
    },
    [hydrateConversation, scheduleCountsRefresh, activeConversation?.id, handleCloseConversation],
  );

  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  // Resync after a reconnect or when the tab becomes visible again —
  // realtime is best-effort and events sent while disconnected are lost.
  const resync = useCallback(() => {
    setResyncToken((n) => n + 1);
    loadFirstPage();
    refreshCounts();
    refreshViews();
  }, [loadFirstPage, refreshCounts, refreshViews]);

  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (initialConnectDoneRef.current) resync();
      else initialConnectDoneRef.current = true;
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, resync]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") resync();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [resync]);

  // ── Per-user read cursor ────────────────────────────────────────────
  // Advance MY read cursor to the newest message actually rendered; a
  // customer message racing this stays unread (the RPC never rewinds).
  const lastMarkedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeConversation || messages.length === 0) return;
    const newest = messages[messages.length - 1];
    if (newest.id.startsWith("temp-")) return;
    const key = `${activeConversation.id}:${newest.created_at}`;
    if (lastMarkedRef.current === key) return;
    lastMarkedRef.current = key;
    const convId = activeConversation.id;
    createClient()
      .rpc("mark_conversation_read", { p_conversation_id: convId, p_read_through: newest.created_at })
      .then(({ error }) => {
        if (error) {
          // Basic mode (migration 044 missing): the thread's legacy shared
          // counter reset still runs; nothing to log.
          if (!isMissingSchemaError(error)) console.error("mark read failed:", error.message);
          return;
        }
        patchConversation(convId, { my_unread_count: 0 });
        scheduleCountsRefresh();
        window.dispatchEvent(new Event("wacrm:inbox-read"));
      });
  }, [activeConversation, messages, patchConversation, scheduleCountsRefresh]);

  // ── Thread callbacks ────────────────────────────────────────────────
  const handleMessagesLoaded = useCallback((loaded: Message[]) => setMessages(loaded), []);
  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);
  const handleUpdateMessage = useCallback((id: string, updates: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)));
  }, []);
  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      patchConversation(conversationId, { status });
      scheduleCountsRefresh();
    },
    [patchConversation, scheduleCountsRefresh],
  );
  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      patchConversation(conversationId, { assigned_agent_id: assignedAgentId ?? undefined });
      scheduleCountsRefresh();
    },
    [patchConversation, scheduleCountsRefresh],
  );

  // ── Panels ──────────────────────────────────────────────────────────
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(true);
  useEffect(() => {
    setContactPanelOpen(readPref(CONTACT_PANEL_STORAGE_KEY, true));
    setFiltersOpen(readPref(FILTERS_PANEL_STORAGE_KEY, true));
  }, []);
  // Below lg the contact panel opens as a sheet over the thread.
  const [panelSheet, setPanelSheet] = useState(false);
  const isDesktop = () => window.matchMedia("(min-width: 1024px)").matches;
  const toggleContactPanel = useCallback(() => {
    if (!isDesktop()) {
      setPanelSheet((o) => !o);
      return;
    }
    setContactPanelOpen((p) => {
      writePref(CONTACT_PANEL_STORAGE_KEY, !p);
      return !p;
    });
  }, []);
  const setFiltersPanel = useCallback((open: boolean) => {
    setFiltersOpen(open);
    writePref(FILTERS_PANEL_STORAGE_KEY, open);
  }, []);
  // Narrow screens: the filter column opens as a drawer instead.
  const [filtersDrawer, setFiltersDrawer] = useState(false);
  const showFilters = useCallback(() => {
    if (window.matchMedia("(min-width: 1280px)").matches) setFiltersPanel(true);
    else setFiltersDrawer(true);
  }, [setFiltersPanel]);

  const [panel, setPanel] = useState<RightPanelState>({ tab: "details", drawer: null });
  const openPanel = useCallback((next: RightPanelState) => {
    setPanel(next);
    if (!isDesktop()) {
      setPanelSheet(true);
      return;
    }
    setContactPanelOpen(true);
    writePref(CONTACT_PANEL_STORAGE_KEY, true);
  }, []);
  // A drawer belongs to the chat it was opened for.
  useEffect(() => {
    setPanel((p) => (p.drawer ? { ...p, drawer: null } : p));
  }, [activeConversation?.id]);

  // ── New conversation ────────────────────────────────────────────────
  const [newConvOpen, setNewConvOpen] = useState(false);
  const handleConversationStarted = useCallback(
    async (convId: string) => {
      const conv = await loadConversation(convId);
      if (!conv) {
        toast.error("Conversation created, but it could not be opened. Refresh the inbox.");
        return;
      }
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]));
      handleSelectConversation(conv);
      scheduleCountsRefresh();
    },
    [handleSelectConversation, scheduleCountsRefresh],
  );

  const activeView = views.find((v) => v.id === activeViewId) ?? null;
  const listTitle = activeView
    ? activeView.name
    : `${filters.scope === "mine" ? "My chats · " : ""}${QUEUE_LABELS[filters.queue]}`;
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2" role="status">
          <WifiOff className="h-4 w-4 text-amber-500" />
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("whatsappNotConnected")}</p>
        </div>
      )}
      {basicMode && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-sky-500/20 bg-sky-500/10 px-4 py-2" role="status">
          <Info className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <p className="text-xs text-sky-700 dark:text-sky-300">
            {canAdmin
              ? MIGRATION_044_NOTICE
              : "The inbox is running in basic mode until an admin applies a database update."}
          </p>
        </div>
      )}
      {!isConnected && initialConnectDoneRef.current && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-border bg-muted px-4 py-1.5" role="status">
          <p className="text-xs text-muted-foreground">Live updates paused — reconnecting…</p>
        </div>
      )}

      <div className="hidden lg:block">
        <ViewTabs
          views={views}
          counts={viewCounts}
          activeViewId={activeViewId}
          onSelect={selectView}
          onChanged={refreshViews}
          currentFilters={filters}
          members={members}
          tags={tags}
          customFields={customFields}
          accountId={accountId}
          userId={userId}
          canShare={canAdmin}
        />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {filtersOpen && (
          <div className="hidden xl:flex">
            <InboxFiltersPanel
              filters={filters}
              onChange={setFilters}
              counts={counts}
              members={members}
              tags={tags}
              customFields={customFields}
              channelLabel={channelLabel}
              canManageSettings={canAdmin}
              onCollapse={() => setFiltersPanel(false)}
            />
          </div>
        )}

        <Sheet open={filtersDrawer} onOpenChange={setFiltersDrawer}>
          <SheetContent side="left" showCloseButton={false} className="w-[288px] p-0 sm:max-w-[288px]">
            <SheetTitle className="sr-only">Inbox filters</SheetTitle>
            <InboxFiltersPanel
              filters={filters}
              onChange={(f) => {
                setFilters(f);
                // Picking a queue on mobile should show the list right away.
                if (f.queue !== filters.queue || f.scope !== filters.scope) setFiltersDrawer(false);
              }}
              counts={counts}
              members={members}
              tags={tags}
              customFields={customFields}
              channelLabel={channelLabel}
              canManageSettings={canAdmin}
              onCollapse={() => setFiltersDrawer(false)}
            />
          </SheetContent>
        </Sheet>

        <div className={cn("flex h-full flex-1 lg:flex-none", hasActiveConv ? "hidden lg:flex" : "flex")}>
          <ConversationList
            conversations={visibleConversations}
            loading={listLoading}
            error={listError}
            hasMore={!!cursor}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            onRetry={loadFirstPage}
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            title={listTitle}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={(s) => pushUrl({ sort: s })}
            members={members}
            tags={tags}
            customFields={customFields}
            filtersCollapsed={!filtersOpen}
            onShowFilters={showFilters}
            onNewConversation={canSend ? () => setNewConvOpen(true) : undefined}
            onRefresh={resync}
            onBulkUpdate={handleBulkUpdate}
            onBulkDelete={handleBulkDelete}
          />
          <NewConversationDialog
            open={newConvOpen}
            onOpenChange={setNewConvOpen}
            onStarted={handleConversationStarted}
          />
        </div>

        {/* `min-w-0` keeps a wide message from pushing the side panel
            off-screen (issue #165). */}
        <div className={cn("flex h-full min-w-0 flex-1 flex-col lg:flex", hasActiveConv ? "flex" : "hidden lg:flex")}>
          {activeLeftQueue && (
            <div className="flex shrink-0 items-center gap-2 border-b border-sky-500/20 bg-sky-500/10 px-4 py-1.5 text-xs text-sky-700 dark:text-sky-300" role="status">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">
                This chat no longer matches &quot;{listTitle}&quot;. It stays open until you switch chats.
              </span>
              <button type="button" onClick={handleCloseConversation} aria-label="Close chat" className="hover:opacity-70">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            members={members}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onStatusChange={handleStatusChange}
            onAssignChange={handleAssignChange}
            onContactChange={(c) => {
              setActiveContact(c);
              if (activeConversation) patchConversation(activeConversation.id, { contact: c });
            }}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={resync}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={toggleContactPanel}
            onOpenPanel={openPanel}
            focusMessageId={focusMessageId}
            onFocusHandled={() => setFocusMessageId(null)}
          />
        </div>

        <Sheet open={panelSheet} onOpenChange={setPanelSheet}>
          <SheetContent side="right" className="w-[340px] p-0 sm:max-w-[340px]">
            <SheetTitle className="sr-only">Contact details</SheetTitle>
            <InboxRightPanel
              conversation={activeConversation}
              contact={activeContact}
              members={members}
              tags={tags}
              customFields={customFields}
              channelLabel={channelLabel}
              state={panel}
              onStateChange={setPanel}
              onJumpToMessage={(id) => {
                setPanelSheet(false);
                setFocusMessageId(id);
              }}
              onContactChange={(c) => {
                setActiveContact(c);
                if (activeConversation) patchConversation(activeConversation.id, { contact: c });
              }}
              onTagsChanged={() => {}}
            />
          </SheetContent>
        </Sheet>

        {contactPanelOpen && (
          <div className="hidden lg:block">
            <InboxRightPanel
              conversation={activeConversation}
              contact={activeContact}
              members={members}
              tags={tags}
              customFields={customFields}
              channelLabel={channelLabel}
              state={panel}
              onStateChange={setPanel}
              onJumpToMessage={(id) => setFocusMessageId(id)}
              onContactChange={(c) => {
                setActiveContact(c);
                if (activeConversation) patchConversation(activeConversation.id, { contact: c });
              }}
              onTagsChanged={async () => {
                const { data } = await createClient().from("tags").select("*").order("name");
                setTags(((data as Tag[] | null) ?? []).filter((x) => !x.archived_at));
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
