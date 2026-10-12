"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  INBOX_CONVERSATION_SELECT,
  LATEST_MESSAGE_EMBED,
  isAwaitingReply,
  matchesContactFilters,
  matchesFolder,
  normalizeConversations,
  sortConversations,
  withLastSender,
  type InboxFolder,
  type InboxSort,
} from "@/lib/inbox/conversations";
import { getFieldOptions, isDropdownField } from "@/lib/contacts/custom-field-options";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import type { Conversation, CustomField, Profile, Tag } from "@/types";
import {
  ArrowUpDown,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Clock,
  FolderPlus,
  Inbox,
  ListChecks,
  Loader2,
  MailOpen,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  User,
  UserMinus,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AddToGroupsDialog, AssignAgentDialog } from "@/components/inbox/bulk-action-dialogs";
import { CONTACT_FIELDS_CHANGED_EVENT } from "@/components/inbox/contact-fields-panel";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /** Opens the "start a new conversation" dialog. Hidden when omitted. */
  onNewConversation?: () => void;
  /** Apply a field patch to these conversations in the parent's state. */
  onBulkUpdate?: (ids: string[], patch: Partial<Conversation>) => void;
  /** Drop these conversations from the parent's state (after delete). */
  onBulkDelete?: (ids: string[]) => void;
  /** Ask the parent to refetch (e.g. after contact tags changed). */
  onRefresh?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

const FOLDER_LABELS: Record<InboxFolder, string> = {
  open: "Open",
  pending: "Pending",
  closed: "Closed",
  awaiting: "Awaiting reply",
  unread: "Unread",
  all: "All",
  mine: "My chats",
  unassigned: "Unassigned",
};

const SORT_LABELS: Record<InboxSort, string> = {
  newest: "Newest message first",
  waiting_longest: "Waiting longest for reply",
};

const PANEL_STORAGE_KEY = "wacrm:inbox:folders-open";

/** Dropdown custom-field values per contact, shown as badges on rows. */
type BadgeIndex = Map<string, string[]>;

function formatListTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isToday(d)) return format(d, "hh:mm a").toLowerCase();
  if (isYesterday(d)) return "Yesterday";
  return format(d, "dd/MM/yy");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onNewConversation,
  onBulkUpdate,
  onBulkDelete,
  onRefresh,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const { user } = useAuth();
  const canAct = useCan("send-messages");
  const currentUserId = user?.id ?? null;

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [folder, setFolder] = useState<InboxFolder>("open");
  const [sort, setSort] = useState<InboxSort>("newest");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [members, setMembers] = useState<Profile[]>([]);

  // Folder panel visibility (desktop), remembered per device.
  const [panelOpen, setPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PANEL_STORAGE_KEY);
      if (stored !== null) setPanelOpen(stored === "true");
    } catch {
      // Storage can throw in private mode — keep the default.
    }
  }, []);
  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      try {
        localStorage.setItem(PANEL_STORAGE_KEY, String(!prev));
      } catch {
        // best-effort
      }
      return !prev;
    });
  }, []);

  // Multi-select + bulk actions.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      // The latest message is embedded (one row per conversation via the
      // referenced-table order + limit) so "Awaiting reply" and the
      // waiting-longest sort know who spoke last without a schema change.
      const { data, error } = await supabase
        .from("conversations")
        .select(INBOX_CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false })
        .order("created_at", { referencedTable: LATEST_MESSAGE_EMBED, ascending: false })
        .limit(1, { referencedTable: LATEST_MESSAGE_EMBED });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(
        normalizeConversations(data ?? []).map((c) => withLastSender(c)),
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions + team members — loaded once so labels stay stable.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const [tagsRes, membersRes] = await Promise.all([
        supabase.from("tags").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
      ]);
      if (cancelled) return;
      if (tagsRes.data) setTags(tagsRes.data as Tag[]);
      if (membersRes.data) setMembers(membersRes.data as Profile[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // ── Lead-status style badges ────────────────────────────────────────
  // Values of dropdown custom fields (e.g. "Warm - 120 Days") for the
  // contacts in the list, shown under each row like DoubleTick does.
  const [badges, setBadges] = useState<BadgeIndex>(new Map());
  const [badgeToken, setBadgeToken] = useState(0);
  const contactIdsKey = useMemo(
    () =>
      [...new Set(conversations.map((c) => c.contact_id).filter(Boolean))]
        .sort()
        .join(","),
    [conversations],
  );
  useEffect(() => {
    const onChange = () => setBadgeToken((n) => n + 1);
    window.addEventListener(CONTACT_FIELDS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CONTACT_FIELDS_CHANGED_EVENT, onChange);
  }, []);
  useEffect(() => {
    if (!contactIdsKey) return;
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data: fieldRows } = await supabase
        .from("custom_fields")
        .select("*")
        .order("field_name");
      const dropdowns = ((fieldRows as CustomField[] | null) ?? []).filter(
        (f) => isDropdownField(f) && getFieldOptions(f).length > 0,
      );
      if (dropdowns.length === 0) {
        if (!cancelled) setBadges(new Map());
        return;
      }
      const fieldOrder = new Map(dropdowns.map((f, i) => [f.id, i]));
      const ids = contactIdsKey.split(",");
      const rows: { contact_id: string; custom_field_id: string; value: string | null }[] = [];
      for (const part of chunk(ids, 200)) {
        const { data } = await supabase
          .from("contact_custom_values")
          .select("contact_id, custom_field_id, value")
          .in("contact_id", part)
          .in("custom_field_id", [...fieldOrder.keys()]);
        rows.push(...((data ?? []) as typeof rows));
      }
      if (cancelled) return;
      const next: BadgeIndex = new Map();
      rows
        .filter((r) => r.value?.trim())
        .sort(
          (a, b) =>
            (fieldOrder.get(a.custom_field_id) ?? 0) - (fieldOrder.get(b.custom_field_id) ?? 0),
        )
        .forEach((r) => {
          const list = next.get(r.contact_id) ?? [];
          list.push(r.value!.trim());
          next.set(r.contact_id, list);
        });
      setBadges(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactIdsKey, badgeToken]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const tg of tags) m.set(tg.id, tg);
    return m;
  }, [tags]);

  const membersById = useMemo(
    () => new Map(members.map((m) => [m.user_id, m])),
    [members],
  );

  const folderCounts = useMemo(() => {
    const keys = Object.keys(FOLDER_LABELS) as InboxFolder[];
    const counts = {} as Record<InboxFolder, number>;
    for (const k of keys) {
      counts[k] = conversations.filter((c) => matchesFolder(c, k, currentUserId)).length;
    }
    return counts;
  }, [conversations, currentUserId]);

  const filtered = useMemo(() => {
    let result = conversations.filter((c) => matchesFolder(c, folder, currentUserId));

    if (memberFilter) {
      result = result.filter((c) => c.assigned_agent_id === memberFilter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return sortConversations(result, sort);
  }, [conversations, folder, currentUserId, memberFilter, search, selectedTagIds, selectedCompany, sort]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
    setMemberFilter(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null || memberFilter !== null;

  // ── Selection ───────────────────────────────────────────────────────
  // Only rows still visible count as selected, so changing the folder or
  // search can't leave hidden chats in a bulk action.
  const visibleSelected = useMemo(
    () => filtered.filter((c) => selectedIds.has(c.id)),
    [filtered, selectedIds],
  );
  const allVisibleSelected = filtered.length > 0 && visibleSelected.length === filtered.length;

  function exitSelection() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(filtered.map((c) => c.id)));
  }

  const handleRowClick = useCallback(
    (conv: Conversation) => {
      if (selecting) toggleSelected(conv.id);
      else onSelect(conv);
    },
    [selecting, onSelect],
  );

  // ── Bulk actions ────────────────────────────────────────────────────
  async function bulkPatch(patch: Partial<Conversation>, done: string) {
    const ids = visibleSelected.map((c) => c.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const supabase = createClient();
      for (const part of chunk(ids, 200)) {
        const { error } = await supabase.from("conversations").update(patch).in("id", part);
        if (error) throw error;
      }
      onBulkUpdate?.(ids, patch);
      toast.success(`${ids.length} chat${ids.length === 1 ? "" : "s"} ${done}`);
      exitSelection();
      return true;
    } catch (err) {
      toast.error(
        `Action failed: ${(err as { message?: string })?.message ?? "unknown error"}`,
      );
      return false;
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkAddToGroups(tagIds: string[]) {
    const contactIds = [...new Set(visibleSelected.map((c) => c.contact_id).filter(Boolean))];
    if (contactIds.length === 0 || tagIds.length === 0) return;
    setBulkBusy(true);
    try {
      const supabase = createClient();
      const rows = contactIds.flatMap((contact_id) =>
        tagIds.map((tag_id) => ({ contact_id, tag_id })),
      );
      for (const part of chunk(rows, 200)) {
        const { error } = await supabase
          .from("contact_tags")
          .upsert(part, { onConflict: "contact_id,tag_id", ignoreDuplicates: true });
        if (error) throw error;
      }
      toast.success(
        `${contactIds.length} contact${contactIds.length === 1 ? "" : "s"} added to ${tagIds.length} group${tagIds.length === 1 ? "" : "s"}`,
      );
      setGroupsOpen(false);
      exitSelection();
      onRefresh?.();
    } catch (err) {
      toast.error(
        `Could not add to groups: ${(err as { message?: string })?.message ?? "unknown error"}`,
      );
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkDelete() {
    const ids = visibleSelected.map((c) => c.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const supabase = createClient();
      for (const part of chunk(ids, 200)) {
        const { error } = await supabase.from("conversations").delete().in("id", part);
        if (error) throw error;
      }
      onBulkDelete?.(ids);
      toast.success(`${ids.length} chat${ids.length === 1 ? "" : "s"} deleted`);
      setDeleteOpen(false);
      exitSelection();
    } catch (err) {
      toast.error(
        `Could not delete chats: ${(err as { message?: string })?.message ?? "unknown error"}`,
      );
    } finally {
      setBulkBusy(false);
    }
  }

  const n = visibleSelected.length;
  const folderTitle = FOLDER_LABELS[folder];

  // ── Folder panel (desktop) ──────────────────────────────────────────
  const folderButton = (key: InboxFolder, icon?: React.ReactNode, indent = true) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        setFolder(key);
        setSelectedIds(new Set());
      }}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md py-1.5 pr-2 text-sm transition-colors",
        indent ? "pl-8" : "pl-2",
        folder === key
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="flex items-center gap-2 truncate">
        {icon}
        {FOLDER_LABELS[key]}
      </span>
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-[10px] font-semibold",
          folder === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {folderCounts[key] > 999 ? "1K+" : folderCounts[key]}
      </span>
    </button>
  );

  const foldersPanel = (
    <aside className="hidden h-full w-56 shrink-0 flex-col border-r border-border bg-card lg:flex">
      <div className="flex h-14 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-semibold text-foreground">Inbox</span>
        <button
          type="button"
          onClick={togglePanel}
          title="Hide folders"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav className="space-y-4 p-2">
          <div className="space-y-0.5">
            <p className="flex items-center gap-2 px-2 py-1 text-sm font-medium text-foreground">
              <Inbox className="h-4 w-4" />
              All chats
            </p>
            {(["open", "pending", "closed", "awaiting", "unread", "all"] as InboxFolder[]).map((k) =>
              folderButton(k),
            )}
          </div>
          <div className="space-y-0.5 border-t border-border pt-3">
            {folderButton("mine", <User className="h-4 w-4" />, false)}
            {folderButton("unassigned", <UserX className="h-4 w-4" />, false)}
          </div>

          <div className="space-y-2 border-t border-border px-1 pt-3">
            <p className="text-xs font-medium text-muted-foreground">Team member</p>
            <select
              value={memberFilter ?? ""}
              onChange={(e) => setMemberFilter(e.target.value || null)}
              className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="">All members</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name || m.email}
                </option>
              ))}
            </select>
          </div>

          {tags.length > 0 && (
            <div className="space-y-1.5 border-t border-border px-1 pt-3">
              <p className="text-xs font-medium text-muted-foreground">{t("tags")}</p>
              <div className="flex flex-wrap gap-1">
                {tags.map((tg) => {
                  const on = selectedTagIds.includes(tg.id);
                  return (
                    <button
                      key={tg.id}
                      type="button"
                      onClick={() => toggleTag(tg.id)}
                      className={cn(
                        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                        on
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tg.color }} />
                      <span className="truncate">{tg.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {companies.length > 0 && (
            <div className="space-y-2 border-t border-border px-1 pt-3">
              <p className="text-xs font-medium text-muted-foreground">{t("company")}</p>
              <select
                value={selectedCompany ?? ""}
                onChange={(e) => setSelectedCompany(e.target.value || null)}
                className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
              >
                <option value="">{t("allCompanies")}</option>
                {companies.map((co) => (
                  <option key={co} value={co}>
                    {co}
                  </option>
                ))}
              </select>
            </div>
          )}
        </nav>
      </ScrollArea>
    </aside>
  );

  return (
    <div className="flex h-full w-full lg:w-auto">
      {panelOpen && foldersPanel}

      {/* w-full on mobile so the list occupies the whole viewport when it's
          the single pane showing; fixed width on desktop where it shares
          the row with the thread + contact sidebar. */}
      <div className="relative flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
        {/* Header: title / search / sort / menu — or the bulk-action bar */}
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3">
          {selecting ? (
            <>
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={n > 0 && !allVisibleSelected}
                onCheckedChange={toggleSelectAll}
                aria-label="Select all chats"
              />
              <span className="ml-2 min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {n}/{filtered.length} selected
              </span>
              {bulkBusy && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
              <button
                type="button"
                title="Mark as done"
                disabled={n === 0 || bulkBusy}
                onClick={() => bulkPatch({ status: "closed" }, "marked as done")}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <CheckCircle2 className="h-4 w-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={n === 0 || bulkBusy}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  aria-label="Bulk actions"
                >
                  <MoreVertical className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 border-border bg-popover">
                  <DropdownMenuItem onClick={() => bulkPatch({ unread_count: 0 }, "marked as read")}>
                    <MailOpen className="h-4 w-4" />
                    Mark as read
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => bulkPatch({ status: "open" }, "reopened")}>
                    <RotateCcw className="h-4 w-4" />
                    Reopen
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setGroupsOpen(true)}>
                    <FolderPlus className="h-4 w-4" />
                    Add to groups
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAssignOpen(true)}>
                    <UserPlus className="h-4 w-4" />
                    Assign agent
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      bulkPatch({ assigned_agent_id: null } as unknown as Partial<Conversation>, "unassigned")
                    }
                  >
                    <UserMinus className="h-4 w-4" />
                    Un-assign chats
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="h-4 w-4" />
                    Delete chats
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                type="button"
                title="Cancel selection"
                onClick={exitSelection}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              {!panelOpen && (
                <button
                  type="button"
                  onClick={togglePanel}
                  title="Show folders"
                  className="hidden rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground lg:block"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              )}
              {/* Folder picker — the only way to switch folders on mobile
                  or when the panel is hidden. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-sm font-semibold text-foreground hover:bg-muted",
                    panelOpen && "lg:pointer-events-none",
                  )}
                >
                  <span className="truncate">{folderTitle}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    ({filtered.length})
                  </span>
                  <ChevronDown className={cn("h-3.5 w-3.5 shrink-0", panelOpen && "lg:hidden")} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52 border-border bg-popover">
                  {(Object.keys(FOLDER_LABELS) as InboxFolder[]).map((k) => (
                    <DropdownMenuItem
                      key={k}
                      onClick={() => setFolder(k)}
                      className={cn("justify-between", folder === k && "text-primary")}
                    >
                      {FOLDER_LABELS[k]}
                      <span className="text-xs text-muted-foreground">{folderCounts[k]}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <button
                type="button"
                title="Search"
                onClick={() => setSearchOpen((o) => !o)}
                className={cn(
                  "rounded-md p-1.5 hover:bg-muted",
                  searchOpen || search ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Search className="h-4 w-4" />
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger
                  title="Sort"
                  className={cn(
                    "rounded-md p-1.5 hover:bg-muted",
                    sort !== "newest" ? "text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ArrowUpDown className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64 border-border bg-popover">
                  <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Sort by</p>
                  {(Object.keys(SORT_LABELS) as InboxSort[]).map((k) => (
                    <DropdownMenuItem
                      key={k}
                      onClick={() => setSort(k)}
                      className={cn("justify-between", sort === k && "font-medium text-primary")}
                    >
                      {SORT_LABELS[k]}
                      {k === "newest" ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          Default
                        </span>
                      ) : (
                        sort === k && <Check className="h-3.5 w-3.5" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="More"
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <MoreVertical className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 border-border bg-popover">
                  {canAct && (
                    <DropdownMenuItem onClick={() => setSelecting(true)}>
                      <ListChecks className="h-4 w-4" />
                      Select chats
                    </DropdownMenuItem>
                  )}
                  {/* Mobile-only filters (the folder panel has them on desktop). */}
                  {tags.length > 0 &&
                    tags.map((tg) => (
                      <DropdownMenuCheckboxItem
                        key={tg.id}
                        checked={selectedTagIds.includes(tg.id)}
                        onCheckedChange={() => toggleTag(tg.id)}
                        className="text-sm lg:hidden"
                      >
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tg.color }} />
                          <span className="truncate">{tg.name}</span>
                        </span>
                      </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        {(searchOpen || search) && !selecting && (
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchPlaceholder")}
                className="border-border bg-muted pl-9 pr-8 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
            {memberFilter && (
              <button
                onClick={() => setMemberFilter(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <User className="h-3 w-3" />
                <span className="max-w-24 truncate">
                  {membersById.get(memberFilter)?.full_name ?? "Member"}
                </span>
                <X className="h-3 w-3" />
              </button>
            )}
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}

        {/* Conversation Items.
            `min-h-0` is load-bearing: a flex child defaults to
            min-height:auto, so without it this ScrollArea grows to fit
            every conversation instead of shrinking to the remaining
            space — the list then overflows and gets clipped by the
            parent's overflow-hidden with no scrollbar (issue #229). */}
        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
            </div>
          ) : (
            <div className="flex flex-col pb-20">
              {filtered.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isActive={!selecting && conv.id === activeConversationId}
                  selecting={selecting}
                  checked={selectedIds.has(conv.id)}
                  badges={badges.get(conv.contact_id) ?? []}
                  onClick={handleRowClick}
                  t={t}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {onNewConversation && !selecting && (
          <Button
            onClick={onNewConversation}
            className="absolute right-4 bottom-4 h-10 gap-1.5 rounded-lg bg-primary px-4 text-primary-foreground shadow-lg hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New
          </Button>
        )}
      </div>

      <AssignAgentDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        members={members}
        busy={bulkBusy}
        onAssign={async (userId) => {
          const name = membersById.get(userId)?.full_name || "agent";
          const ok = await bulkPatch({ assigned_agent_id: userId }, `assigned to ${name}`);
          if (ok) setAssignOpen(false);
        }}
      />
      <AddToGroupsDialog
        open={groupsOpen}
        onOpenChange={setGroupsOpen}
        tags={tags}
        busy={bulkBusy}
        onApply={bulkAddToGroups}
      />
      <Dialog open={deleteOpen} onOpenChange={(o) => !bulkBusy && setDeleteOpen(o)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {n} chat{n === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              The conversation and all its messages are permanently removed
              from the CRM. The contacts themselves are kept. This can&apos;t
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              disabled={bulkBusy}
              onClick={() => setDeleteOpen(false)}
              className="border-border text-muted-foreground"
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={bulkBusy} onClick={bulkDelete}>
              {bulkBusy && <Loader2 className="size-4 animate-spin" />}
              Delete chats
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  selecting: boolean;
  checked: boolean;
  badges: string[];
  onClick: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  selecting,
  checked,
  badges,
  onClick,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const awaiting = isAwaitingReply(conversation);
  const outgoingLast = conversation.last_sender && conversation.last_sender !== "customer";
  const unread = conversation.unread_count > 0;

  const handleClick = useCallback(() => {
    onClick(conversation);
  }, [onClick, conversation]);

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-l-primary bg-muted/70",
        checked && "bg-primary/5",
      )}
    >
      {/* Avatar / checkbox */}
      {selecting ? (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center">
          <Checkbox checked={checked} tabIndex={-1} aria-label={`Select ${displayName}`} />
        </span>
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt={displayName}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            initials
          )}
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm text-foreground",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {displayName}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {awaiting && (
              <Clock className="h-3.5 w-3.5 text-red-400" aria-label="Awaiting reply" />
            )}
            {unread && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={cn(
              "flex min-w-0 items-center gap-1 truncate text-xs",
              unread ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {outgoingLast && <CheckCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate">
              {conversation.last_message_text || t("noMessagesYet")}
            </span>
          </p>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">
              {formatListTime(conversation.last_message_at)}
            </span>
            <span
              className={cn("h-2 w-2 rounded-full", STATUS_COLORS[conversation.status])}
              title={conversation.status}
            />
          </span>
        </div>
        {badges.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {badges.slice(0, 2).map((b) => (
              <span
                key={b}
                className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}
