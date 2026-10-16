"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getFieldOptions, isDropdownField } from "@/lib/contacts/custom-field-options";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import type { Conversation, CustomField, Profile, Tag } from "@/types";
import {
  AlertCircle,
  ArrowUpDown,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  FolderPlus,
  Info,
  ListChecks,
  Loader2,
  MailOpen,
  MessageCircle,
  MoreVertical,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Timer,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { isMissingSchemaError } from "@/lib/db/schema-compat";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
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
import { AddToGroupsDialog, AssignAgentDialog } from "@/components/inbox/bulk-action-dialogs";
import { CONTACT_FIELDS_CHANGED_EVENT } from "@/lib/inbox/events";
import type { InboxFilters, InboxSortKey } from "@/lib/inbox/query";

const SORT_LABELS: Record<InboxSortKey, string> = {
  newest: "Newest message first",
  waiting_longest: "Waiting longest for reply",
};

/** Dropdown custom-field values per contact, shown as row chips. */
type BadgeIndex = Map<string, string[]>;

export interface ConversationListProps {
  /** Rows already filtered + ordered by the server (plus realtime patches). */
  conversations: Conversation[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  title: string;
  filters: InboxFilters;
  onFiltersChange: (next: InboxFilters) => void;
  sort: InboxSortKey;
  onSortChange: (sort: InboxSortKey) => void;
  members: Profile[];
  tags: Tag[];
  customFields: CustomField[];
  filtersCollapsed: boolean;
  onShowFilters: () => void;
  onNewConversation?: () => void;
  onRefresh: () => void;
  /** Apply a field patch to these conversations in the parent's state. */
  onBulkUpdate: (ids: string[], patch: Partial<Conversation>) => void;
  /** Drop these conversations from the parent's state (after delete). */
  onBulkDelete: (ids: string[]) => void;
}

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

function errMsg(err: unknown): string {
  return (err as { message?: string })?.message ?? "unknown error";
}

export function ConversationList({
  conversations,
  loading,
  error,
  hasMore,
  loadingMore,
  onLoadMore,
  onRetry,
  activeConversationId,
  onSelect,
  title,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  members,
  tags,
  customFields,
  filtersCollapsed,
  onShowFilters,
  onNewConversation,
  onRefresh,
  onBulkUpdate,
  onBulkDelete,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const canAct = useCan("send-messages");
  // Clock for SLA markers, ticking so a chat turns "breached" on time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const canAdmin = useCan("edit-settings");

  const [searchOpen, setSearchOpen] = useState(!!filters.search);
  const [searchDraft, setSearchDraft] = useState(filters.search ?? "");

  // Debounce typing into the server-side search filter.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  });
  useEffect(() => {
    const current = filtersRef.current.search ?? "";
    if (searchDraft.trim() === current.trim()) return;
    const h = setTimeout(
      () => onFiltersChange({ ...filtersRef.current, search: searchDraft.trim() || null }),
      300,
    );
    return () => clearTimeout(h);
  }, [searchDraft, onFiltersChange]);

  // ── Selection + bulk actions ────────────────────────────────────────
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const visibleSelected = useMemo(
    () => conversations.filter((c) => selectedIds.has(c.id)),
    [conversations, selectedIds],
  );
  const n = visibleSelected.length;
  const allSelected = conversations.length > 0 && n === conversations.length;

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

  const handleRowClick = useCallback(
    (conv: Conversation) => {
      if (selecting) toggleSelected(conv.id);
      else onSelect(conv);
    },
    [selecting, onSelect],
  );

  async function runBulk(label: string, fn: (ids: string[]) => Promise<void>) {
    const ids = visibleSelected.map((c) => c.id);
    if (ids.length === 0) return false;
    setBulkBusy(true);
    try {
      await fn(ids);
      toast.success(`${ids.length} chat${ids.length === 1 ? "" : "s"} ${label}`);
      exitSelection();
      return true;
    } catch (err) {
      toast.error(`Action failed: ${errMsg(err)}`);
      return false;
    } finally {
      setBulkBusy(false);
    }
  }

  const setStatus = (status: "open" | "closed") =>
    runBulk(status === "closed" ? "resolved" : "reopened", async (ids) => {
      const supabase = createClient();
      for (const part of chunk(ids, 200)) {
        const { error } = await supabase.from("conversations").update({ status }).in("id", part);
        if (error) throw error;
      }
      onBulkUpdate(ids, { status });
    });

  // Per-user read cursor: marks them read for ME, not for teammates.
  const markRead = () =>
    runBulk("marked as read", async (ids) => {
      const supabase = createClient();
      const now = new Date().toISOString();
      for (const id of ids) {
        const { error } = await supabase.rpc("mark_conversation_read", {
          p_conversation_id: id,
          p_read_through: now,
        });
        if (error && isMissingSchemaError(error)) {
          // Migration 044 not applied: clear the shared counter instead.
          const { error: updErr } = await supabase
            .from("conversations")
            .update({ unread_count: 0 })
            .in("id", ids);
          if (updErr) throw updErr;
          break;
        }
        if (error) throw error;
      }
      onBulkUpdate(ids, { my_unread_count: 0 });
    });

  // Assignment goes through the audited RPC (one event per chat).
  const assignTo = (userId: string | null, label: string) =>
    runBulk(label, async (ids) => {
      const supabase = createClient();
      for (const id of ids) {
        const { error } = await supabase.rpc("assign_conversation", {
          p_conversation_id: id,
          p_assignee: userId,
        });
        if (error && isMissingSchemaError(error)) {
          // Migration 044 not applied: plain update (no audit trail).
          const { error: updErr } = await supabase
            .from("conversations")
            .update({ assigned_agent_id: userId })
            .in("id", ids);
          if (updErr) throw updErr;
          break;
        }
        if (error) throw error;
      }
      onBulkUpdate(ids, { assigned_agent_id: userId ?? undefined });
    });

  async function addToGroups(tagIds: string[]) {
    const contactIds = [...new Set(visibleSelected.map((c) => c.contact_id).filter(Boolean))];
    if (contactIds.length === 0 || tagIds.length === 0) return;
    setBulkBusy(true);
    try {
      const supabase = createClient();
      const rows = contactIds.flatMap((contact_id) => tagIds.map((tag_id) => ({ contact_id, tag_id })));
      for (const part of chunk(rows, 200)) {
        const { error } = await supabase
          .from("contact_tags")
          .upsert(part, { onConflict: "contact_id,tag_id", ignoreDuplicates: true });
        if (error) throw error;
      }
      toast.success(`${contactIds.length} contact${contactIds.length === 1 ? "" : "s"} added`);
      setGroupsOpen(false);
      exitSelection();
      onRefresh();
    } catch (err) {
      toast.error(`Could not add to groups: ${errMsg(err)}`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkDelete() {
    const ok = await runBulk("deleted", async (ids) => {
      const supabase = createClient();
      for (const part of chunk(ids, 200)) {
        const { error } = await supabase.from("conversations").delete().in("id", part);
        if (error) {
          throw new Error(
            /foreign key/i.test(error.message)
              ? "A deal is linked to one of these chats. Unlink or delete the deal first."
              : error.message,
          );
        }
      }
      onBulkDelete(ids);
    });
    if (ok) setDeleteOpen(false);
  }

  // ── Lead-field chips ────────────────────────────────────────────────
  const [badges, setBadges] = useState<BadgeIndex>(new Map());
  const [badgeToken, setBadgeToken] = useState(0);
  const contactIdsKey = useMemo(
    () => [...new Set(conversations.map((c) => c.contact_id).filter(Boolean))].sort().join(","),
    [conversations],
  );
  useEffect(() => {
    const onChange = () => setBadgeToken((x) => x + 1);
    window.addEventListener(CONTACT_FIELDS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CONTACT_FIELDS_CHANGED_EVENT, onChange);
  }, []);
  const dropdownFields = useMemo(
    () => customFields.filter((f) => isDropdownField(f) && getFieldOptions(f).length > 0 && !f.archived_at),
    [customFields],
  );
  useEffect(() => {
    if (!contactIdsKey || dropdownFields.length === 0) return;
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const order = new Map(dropdownFields.map((f, i) => [f.id, i]));
      const rows: { contact_id: string; custom_field_id: string; value: string | null }[] = [];
      for (const part of chunk(contactIdsKey.split(","), 200)) {
        const { data } = await supabase
          .from("contact_custom_values")
          .select("contact_id, custom_field_id, value")
          .in("contact_id", part)
          .in("custom_field_id", [...order.keys()]);
        rows.push(...((data ?? []) as typeof rows));
      }
      if (cancelled) return;
      const next: BadgeIndex = new Map();
      rows
        .filter((r) => r.value?.trim())
        .sort((a, b) => (order.get(a.custom_field_id) ?? 0) - (order.get(b.custom_field_id) ?? 0))
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
  }, [contactIdsKey, badgeToken, dropdownFields]);

  // ── Infinite scroll ─────────────────────────────────────────────────
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingMore) onLoadMore();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  // ── Filter chips (visible, removable) ───────────────────────────────
  const memberName = (id: string) => {
    const m = members.find((x) => x.user_id === id);
    return m?.full_name || m?.email || "Member";
  };
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filters.assignee) {
    chips.push({ key: "member", label: memberName(filters.assignee), clear: () => onFiltersChange({ ...filters, assignee: null }) });
  }
  for (const id of filters.tag_ids ?? []) {
    const tag = tags.find((x) => x.id === id);
    chips.push({
      key: `tag:${id}`,
      label: tag?.name ?? "Tag",
      clear: () => onFiltersChange({ ...filters, tag_ids: (filters.tag_ids ?? []).filter((x) => x !== id) }),
    });
  }
  if (filters.field_id && filters.field_value) {
    chips.push({ key: "field", label: filters.field_value, clear: () => onFiltersChange({ ...filters, field_id: null, field_value: null }) });
  }
  if (filters.date_from || filters.date_to) {
    const f = filters.date_from ? format(new Date(filters.date_from), "d MMM") : "…";
    const tt = filters.date_to ? format(new Date(Date.parse(filters.date_to) - 1), "d MMM") : "…";
    chips.push({ key: "date", label: `Active ${f} – ${tt}`, clear: () => onFiltersChange({ ...filters, date_from: null, date_to: null }) });
  }

  const iconBtn = "rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";

  return (
    <div className="relative flex h-full w-full flex-col border-r border-border bg-card lg:w-[360px]">
      {/* Header — or the bulk-action bar while selecting */}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3">
        {selecting ? (
          <>
            <Checkbox
              checked={allSelected}
              indeterminate={n > 0 && !allSelected}
              onCheckedChange={() =>
                setSelectedIds(allSelected ? new Set() : new Set(conversations.map((c) => c.id)))
              }
              aria-label="Select all loaded chats"
            />
            <span className="ml-2 min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {n}/{conversations.length}
              {hasMore ? "+" : ""} selected
            </span>
            {bulkBusy && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            <button
              type="button"
              title="Mark as done (resolve)"
              aria-label="Mark selected as done"
              disabled={n === 0 || bulkBusy}
              onClick={() => setStatus("closed")}
              className={iconBtn}
            >
              <CheckCircle2 className="h-4 w-4" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger disabled={n === 0 || bulkBusy} className={iconBtn} aria-label="Bulk actions">
                <MoreVertical className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 border-border bg-popover">
                <DropdownMenuItem onClick={markRead}>
                  <MailOpen className="h-4 w-4" /> Mark as read
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setStatus("open")}>
                  <RotateCcw className="h-4 w-4" /> Reopen
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setGroupsOpen(true)}>
                  <FolderPlus className="h-4 w-4" /> Add tags / groups
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAssignOpen(true)}>
                  <UserPlus className="h-4 w-4" /> Assign agent
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => assignTo(null, "unassigned")}>
                  <UserMinus className="h-4 w-4" /> Un-assign chats
                </DropdownMenuItem>
                {canAdmin && (
                  <>
                    <DropdownMenuSeparator className="bg-border" />
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                      <Trash2 className="h-4 w-4" /> Delete chats
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <button type="button" title="Cancel selection" aria-label="Cancel selection" onClick={exitSelection} className={iconBtn}>
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            {/* Below xl the filter column lives in a drawer, so the button is
                always there; on xl it only shows when the column is hidden. */}
            <button
              type="button"
              onClick={onShowFilters}
              title="Show filters"
              aria-label="Show filters"
              className={cn(iconBtn, !filtersCollapsed && "xl:hidden")}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</h2>
            <button
              type="button"
              title="Search"
              aria-label="Search conversations"
              aria-pressed={searchOpen}
              onClick={() => setSearchOpen((o) => !o)}
              className={cn(iconBtn, (searchOpen || filters.search) && "text-primary")}
            >
              <Search className="h-4 w-4" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger title="Sort" aria-label="Sort conversations" className={cn(iconBtn, sort !== "newest" && "text-primary")}>
                <ArrowUpDown className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 border-border bg-popover">
                <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Sort by</p>
                {(Object.keys(SORT_LABELS) as InboxSortKey[]).map((k) => (
                  <DropdownMenuItem
                    key={k}
                    onClick={() => onSortChange(k)}
                    className={cn("justify-between", sort === k && "font-medium text-primary")}
                  >
                    {SORT_LABELS[k]}
                    {k === "newest" ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Default</span>
                    ) : (
                      <span title="Chats whose customer has waited longest for a human reply come first">
                        {sort === k ? <Check className="h-3.5 w-3.5" /> : <Info className="h-3.5 w-3.5 text-muted-foreground" />}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="More list actions" className={iconBtn}>
                <MoreVertical className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 border-border bg-popover">
                {canAct && (
                  <DropdownMenuItem onClick={() => setSelecting(true)}>
                    <ListChecks className="h-4 w-4" /> Select chats
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onRefresh}>
                  <RefreshCw className="h-4 w-4" /> Refresh list
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {(searchOpen || filters.search) && !selecting && (
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchDraft("");
                  setSearchOpen(false);
                }
              }}
              placeholder={t("searchPlaceholder")}
              aria-label="Search by name, phone or last message"
              className="border-border bg-muted pr-8 pl-9 text-sm text-foreground"
            />
            {searchDraft && (
              <button
                type="button"
                onClick={() => setSearchDraft("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.clear}
              aria-label={`Remove filter ${c.label}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10"
            >
              <span className="truncate">{c.label}</span>
              <X className="h-3 w-3 shrink-0" />
            </button>
          ))}
          <button
            type="button"
            onClick={() =>
              onFiltersChange({ ...filters, assignee: null, tag_ids: [], field_id: null, field_value: null, date_from: null, date_to: null })
            }
            className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("clearAll")}
          </button>
        </div>
      )}

      {/* `min-h-0` lets the list shrink and scroll inside the flex column. */}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {loading ? (
          <div className="space-y-1 p-2" aria-label="Loading conversations">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex animate-pulse items-center gap-3 rounded-md px-2 py-3">
                <div className="h-10 w-10 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/2 rounded bg-muted" />
                  <div className="h-3 w-3/4 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center" role="alert">
            <AlertCircle className="h-6 w-6 text-red-400" />
            <p className="text-sm text-foreground">Couldn&apos;t load conversations</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={onRetry} className="mt-1 border-border">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : conversations.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <MessageCircle className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
            {chips.length > 0 || filters.search ? (
              <p className="mt-1 text-xs text-muted-foreground">Try clearing some filters.</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col pb-20" role="list">
            {conversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={!selecting && conv.id === activeConversationId}
                selecting={selecting}
                checked={selectedIds.has(conv.id)}
                badges={badges.get(conv.contact_id) ?? []}
                now={now}
                onClick={handleRowClick}
                t={t}
              />
            ))}
            {hasMore && (
              <div ref={sentinelRef} className="flex justify-center py-3">
                {loadingMore ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <button type="button" onClick={onLoadMore} className="text-xs text-primary hover:underline">
                    Load more
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {onNewConversation && !selecting && (
        <Button
          onClick={onNewConversation}
          className="absolute right-4 bottom-4 h-10 gap-1.5 rounded-lg bg-primary px-4 text-primary-foreground shadow-lg hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New
        </Button>
      )}

      <AssignAgentDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        members={members}
        busy={bulkBusy}
        onAssign={async (userId) => {
          const ok = await assignTo(userId, `assigned to ${memberName(userId)}`);
          if (ok) setAssignOpen(false);
        }}
      />
      <AddToGroupsDialog
        open={groupsOpen}
        onOpenChange={setGroupsOpen}
        tags={tags}
        busy={bulkBusy}
        onApply={addToGroups}
      />
      <Dialog open={deleteOpen} onOpenChange={(o) => !bulkBusy && setDeleteOpen(o)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {n} chat{n === 1 ? "" : "s"} for everyone?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This permanently removes the conversations and their message
              history from the CRM for the whole team. Contacts are kept. To
              hide a chat only for yourself, use &quot;Clear chat&quot; inside
              the conversation instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button variant="outline" disabled={bulkBusy} onClick={() => setDeleteOpen(false)} className="border-border text-muted-foreground">
              Cancel
            </Button>
            <Button variant="destructive" disabled={bulkBusy} onClick={bulkDelete}>
              {bulkBusy && <Loader2 className="size-4 animate-spin" />}
              Delete for everyone
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
  now: number;
  onClick: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({ conversation, isActive, selecting, checked, badges, now, onClick, t }: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const unreadCount = conversation.my_unread_count ?? 0;
  const unread = unreadCount > 0;
  const awaiting = !!conversation.awaiting_reply_since && conversation.status !== "closed";
  const breached = !!conversation.sla_due_at && Date.parse(conversation.sla_due_at) < now;
  const outgoing = conversation.last_sender && conversation.last_sender !== "customer";
  const status = conversation.last_message_status;
  const contactTags = contact?.tags ?? [];

  return (
    <button
      type="button"
      role="listitem"
      onClick={() => onClick(conversation)}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full items-start gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-l-primary bg-primary/5",
        checked && "bg-primary/5",
      )}
    >
      {selecting ? (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center">
          <Checkbox checked={checked} tabIndex={-1} aria-label={`Select ${displayName}`} />
        </span>
      ) : (
        <div className="relative shrink-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
            {contact?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={contact.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              initials
            )}
          </div>
          {/* Channel badge: every conversation today is WhatsApp. */}
          <span
            className="absolute -right-0.5 -bottom-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#25D366] ring-2 ring-card"
            title="WhatsApp"
            aria-label="WhatsApp"
          >
            <MessageCircle className="h-2.5 w-2.5 text-white" />
          </span>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-sm text-foreground", unread ? "font-semibold" : "font-medium")}>
            {displayName}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {breached ? (
              <Timer className="h-3.5 w-3.5 text-red-500" aria-label="SLA breached" />
            ) : awaiting ? (
              <Clock className="h-3.5 w-3.5 text-amber-500" aria-label="Awaiting reply" />
            ) : null}
            {unread && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className={cn("flex min-w-0 items-center gap-1 truncate text-xs", unread ? "text-foreground" : "text-muted-foreground")}>
            {outgoing &&
              (status === "failed" ? (
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" aria-label="Failed" />
              ) : status === "sending" ? (
                <Clock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Sending" />
              ) : status === "sent" ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Sent" />
              ) : (
                <CheckCheck
                  className={cn("h-3.5 w-3.5 shrink-0", status === "read" ? "text-sky-500" : "text-muted-foreground")}
                  aria-label={status === "read" ? "Read" : "Delivered"}
                />
              ))}
            <span className="truncate">{conversation.last_message_text || t("noMessagesYet")}</span>
          </p>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {formatListTime(conversation.last_message_at)}
          </span>
        </div>
        {(badges.length > 0 || contactTags.length > 0) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {badges.slice(0, 2).map((b) => (
              <span key={b} className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                {b}
              </span>
            ))}
            {contactTags.slice(0, 2).map((tg) => (
              <span
                key={tg.id}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${tg.color}20`, color: tg.color }}
              >
                {tg.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}
