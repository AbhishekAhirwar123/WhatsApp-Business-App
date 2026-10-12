"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Clock,
  Inbox,
  Lock,
  MessagesSquare,
  PanelLeftClose,
  Radio,
  Search,
  Tag as TagIcon,
  User,
  UserX,
  Users,
  X,
} from "lucide-react";
import type { CustomField, Profile, Tag } from "@/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getFieldOptions, isDropdownField } from "@/lib/contacts/custom-field-options";
import {
  QUEUE_LABELS,
  countFor,
  formatCount,
  type InboxCounts,
  type InboxFilters,
  type InboxQueue,
  type InboxScope,
} from "@/lib/inbox/query";

// "pending" is a WACRM lifecycle state the reference has no queue for;
// it is kept so pending chats are not only reachable via All.
const SUB_QUEUES: InboxQueue[] = ["open", "pending", "closed", "awaiting", "unread", "all"];

interface InboxFiltersPanelProps {
  filters: InboxFilters;
  onChange: (next: InboxFilters) => void;
  counts: InboxCounts | null;
  members: Profile[];
  tags: Tag[];
  customFields: CustomField[];
  /** Display name of the connected business number (channel). */
  channelLabel: string | null;
  canManageSettings: boolean;
  onCollapse: () => void;
}

/**
 * Left filter column: queue groups (All chats / My chats, each with
 * Open · Resolved · Awaiting reply · Unread · All), Unassigned, SLA
 * breached, then Team member, Tags, Lead field, Channels and Date range.
 * Counts come from `inbox_counts`, i.e. the same predicate as the list.
 */
export function InboxFiltersPanel({
  filters,
  onChange,
  counts,
  members,
  tags,
  customFields,
  channelLabel,
  canManageSettings,
  onCollapse,
}: InboxFiltersPanelProps) {
  const [openGroups, setOpenGroups] = useState<Record<InboxScope, boolean>>({
    all: true,
    mine: filters.scope === "mine",
  });
  const slaEnabled = counts?.sla_enabled === true;

  const set = (patch: Partial<InboxFilters>) => onChange({ ...filters, ...patch });

  const queueRow = (scope: InboxScope, queue: InboxQueue, label = QUEUE_LABELS[queue]) => {
    const active = filters.scope === scope && filters.queue === queue;
    return (
      <button
        key={`${scope}:${queue}`}
        type="button"
        onClick={() => set({ scope, queue })}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md py-1.5 pr-2 pl-9 text-sm transition-colors",
          active
            ? "bg-primary/10 font-medium text-primary"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <span className="truncate">{label}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-semibold",
            active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {formatCount(countFor(counts, scope, queue))}
        </span>
      </button>
    );
  };

  const group = (scope: InboxScope, label: string, Icon: typeof Inbox) => (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => setOpenGroups((g) => ({ ...g, [scope]: !g[scope] }))}
        aria-expanded={openGroups[scope]}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-left">{label}</span>
        {openGroups[scope] ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {openGroups[scope] && SUB_QUEUES.map((q) => queueRow(scope, q))}
    </div>
  );

  const dropdownFields = customFields.filter((f) => isDropdownField(f) && getFieldOptions(f).length > 0);
  const hasRefinements =
    !!filters.assignee ||
    (filters.tag_ids?.length ?? 0) > 0 ||
    !!filters.field_id ||
    !!filters.date_from ||
    !!filters.date_to;

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-border bg-card">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-semibold text-foreground">Inbox</span>
        <button
          type="button"
          onClick={onCollapse}
          title="Hide filters"
          aria-label="Hide filters"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="space-y-3 p-2" aria-label="Inbox queues">
          {group("all", "All chats", MessagesSquare)}
          {group("mine", "My chats", User)}

          <div className="space-y-0.5 border-t border-border pt-2">
            <button
              type="button"
              onClick={() => set({ scope: "all", queue: "unassigned" })}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                filters.queue === "unassigned"
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-foreground hover:bg-muted",
              )}
            >
              <span className="flex items-center gap-2">
                <UserX className="h-4 w-4 text-muted-foreground" />
                Unassigned
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {formatCount(countFor(counts, "all", "unassigned"))}
              </span>
            </button>

            {slaEnabled ? (
              <button
                type="button"
                onClick={() => set({ scope: "all", queue: "sla_breached" })}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  filters.queue === "sla_breached"
                    ? "bg-red-500/10 font-medium text-red-500"
                    : "text-foreground hover:bg-muted",
                )}
              >
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-red-400" />
                  SLA breached
                </span>
                <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-500">
                  {formatCount(countFor(counts, "all", "sla_breached"))}
                </span>
              </button>
            ) : (
              // Capability-gated: no fabricated counts while SLA is off.
              <div
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                title="Set response targets in Settings → Inbox to enable SLA tracking"
              >
                <span className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  SLA breached
                </span>
                {canManageSettings ? (
                  <Link href="/settings?tab=inbox" className="text-[11px] text-primary hover:underline">
                    Set up
                  </Link>
                ) : (
                  <span className="text-[11px]">Off</span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3 border-t border-border px-1 pt-3">
            {/* View switch — groups are capability-gated (see parity doc). */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">View</p>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-0.5 text-xs">
                <span className="flex items-center justify-center gap-1.5 rounded-md bg-primary/10 py-1.5 font-medium text-primary">
                  <MessagesSquare className="h-3.5 w-3.5" />
                  All chats
                </span>
                <span
                  className="flex cursor-not-allowed items-center justify-center gap-1.5 rounded-md py-1.5 text-muted-foreground/60"
                  title="WhatsApp group chats need Meta's Groups API (Official Business Accounts only) and aren't integrated in WACRM yet."
                  aria-disabled="true"
                >
                  <Users className="h-3.5 w-3.5" />
                  Groups
                </span>
              </div>
            </div>

            <MemberPicker
              members={members}
              value={filters.assignee ?? null}
              onChange={(assignee) => set({ assignee })}
            />

            {tags.length > 0 && (
              <TagMultiPicker
                tags={tags}
                value={filters.tag_ids ?? []}
                onChange={(tag_ids) => set({ tag_ids })}
              />
            )}

            {dropdownFields.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Lead field</p>
                <select
                  value={filters.field_id ?? ""}
                  onChange={(e) => set({ field_id: e.target.value || null, field_value: null })}
                  aria-label="Custom field"
                  className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
                >
                  <option value="">Any field</option>
                  {dropdownFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.field_name}
                    </option>
                  ))}
                </select>
                {filters.field_id && (
                  <select
                    value={filters.field_value ?? ""}
                    onChange={(e) => set({ field_value: e.target.value || null })}
                    aria-label="Field value"
                    className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
                  >
                    <option value="">Any value</option>
                    {getFieldOptions(dropdownFields.find((f) => f.id === filters.field_id) ?? {}).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Radio className="h-3.5 w-3.5" />
                Channels
              </p>
              <label className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs text-foreground">
                <Checkbox checked disabled aria-label="WhatsApp channel" />
                <span className="truncate">WhatsApp{channelLabel ? ` · ${channelLabel}` : ""}</span>
              </label>
              <p className="text-[10px] text-muted-foreground">
                One business number is connected; more channels appear here when added.
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <CalendarRange className="h-3.5 w-3.5" />
                Last activity
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  type="date"
                  aria-label="Last activity from"
                  value={toDateInput(filters.date_from)}
                  onChange={(e) => set({ date_from: fromDateInput(e.target.value, false) })}
                  className="h-8 rounded-md border border-border bg-muted px-1.5 text-xs text-foreground outline-none focus:border-primary"
                />
                <input
                  type="date"
                  aria-label="Last activity to"
                  value={toDateInput(filters.date_to, true)}
                  onChange={(e) => set({ date_to: fromDateInput(e.target.value, true) })}
                  className="h-8 rounded-md border border-border bg-muted px-1.5 text-xs text-foreground outline-none focus:border-primary"
                />
              </div>
            </div>

            {hasRefinements && (
              <button
                type="button"
                onClick={() =>
                  set({ assignee: null, tag_ids: [], field_id: null, field_value: null, date_from: null, date_to: null })
                }
                className="w-full rounded-md border border-border py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Reset filters
              </button>
            )}
          </div>
        </nav>
      </ScrollArea>
    </aside>
  );
}

// Date inputs are local calendar days; the filter is a UTC instant range
// [start of from-day, start of the day after to-day) in the viewer's zone.
function toDateInput(iso?: string | null, isEnd = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isEnd) d.setDate(d.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromDateInput(value: string, isEnd: boolean): string | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d + (isEnd ? 1 : 0));
  return date.toISOString();
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}

function MemberPicker({
  members,
  value,
  onChange,
}: {
  members: Profile[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = members.find((m) => m.user_id === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members.filter((m) => `${m.full_name ?? ""} ${m.email ?? ""}`.toLowerCase().includes(q));
  }, [members, query]);

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Team member</p>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
        <PopoverTrigger
          aria-label="Filter by team member"
          className="flex h-8 w-full items-center justify-between rounded-md border border-border bg-muted px-2 text-left text-xs text-foreground outline-none hover:border-primary/50"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.full_name || selected.email : "Filter by member"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <div className="relative border-b border-border">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              aria-label="Search members"
              className="h-9 w-full bg-transparent pr-2 pl-8 text-xs outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1" role="listbox">
            {value && (
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" /> Clear member filter
              </button>
            )}
            {shown.map((m) => (
              <button
                key={m.user_id}
                type="button"
                role="option"
                aria-selected={m.user_id === value}
                onClick={() => { onChange(m.user_id); setOpen(false); }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted",
                  m.user_id === value ? "text-primary" : "text-popover-foreground",
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                  {initials(m.full_name || m.email || "?")}
                </span>
                <span className="truncate">{m.full_name || m.email}</span>
              </button>
            ))}
            {shown.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No members found.</p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TagMultiPicker({
  tags,
  value,
  onChange,
}: {
  tags: Tag[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = tags.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <TagIcon className="h-3.5 w-3.5" />
        Tags
      </p>
      <Popover onOpenChange={(o) => !o && setQuery("")}>
        <PopoverTrigger
          aria-label="Filter by tags"
          className="flex h-8 w-full items-center justify-between rounded-md border border-border bg-muted px-2 text-left text-xs text-foreground outline-none hover:border-primary/50"
        >
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0 ? "Any tag" : `${value.length} selected`}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <div className="relative border-b border-border">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tags"
              aria-label="Search tags"
              className="h-9 w-full bg-transparent pr-2 pl-8 text-xs outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {shown.map((t) => (
              <label
                key={t.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-muted"
              >
                <Checkbox checked={value.includes(t.id)} onCheckedChange={() => toggle(t.id)} />
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
                <span className="truncate">{t.name}</span>
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => {
            const t = tags.find((x) => x.id === id);
            if (!t) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground"
                aria-label={`Remove tag filter ${t.name}`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                {t.name}
                <X className="h-3 w-3" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
