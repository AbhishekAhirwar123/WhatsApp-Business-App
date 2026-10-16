"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { CustomField, Profile, Tag } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getFieldOptions, isDropdownField } from "@/lib/contacts/custom-field-options";
import {
  QUEUE_LABELS,
  formatCount,
  type InboxFilters,
  type InboxQueue,
  type InboxView,
} from "@/lib/inbox/query";

interface ViewTabsProps {
  views: InboxView[];
  counts: Record<string, number>;
  activeViewId: string | null;
  onSelect: (view: InboxView | null) => void;
  onChanged: () => void;
  /** Filters currently applied — offered as the starting point for a new view. */
  currentFilters: InboxFilters;
  members: Profile[];
  tags: Tag[];
  customFields: CustomField[];
  accountId: string | null;
  userId: string | null;
  canShare: boolean;
}

/**
 * Horizontal strip of saved views ("All" + named views with count badges)
 * and the view-management dialog. A view is just a saved set of the same
 * predicates the filter sidebar uses — e.g. assignee + "Top Deals" tag, or
 * Lead Status = Hot. Personal views are private; shared views (admin+)
 * show for the whole team.
 */
export function ViewTabs({
  views,
  counts,
  activeViewId,
  onSelect,
  onChanged,
  currentFilters,
  members,
  tags,
  customFields,
  accountId,
  userId,
  canShare,
}: ViewTabsProps) {
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Saved views">
        <TabButton active={activeViewId === null} onClick={() => onSelect(null)} label="All" />
        {views.map((v) => (
          <TabButton
            key={v.id}
            active={activeViewId === v.id}
            onClick={() => onSelect(v)}
            label={v.name}
            count={counts[v.id]}
            shared={v.owner_user_id === null}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => setManageOpen(true)}
        title="Manage views"
        aria-label="Manage views"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Settings2 className="h-4 w-4" />
      </button>

      <ManageViewsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        views={views}
        onChanged={onChanged}
        currentFilters={currentFilters}
        members={members}
        tags={tags}
        customFields={customFields}
        accountId={accountId}
        userId={userId}
        canShare={canShare}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  shared,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  shared?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={shared ? `${label} (shared with the team)` : label}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px]",
            active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {formatCount(count)}
        </span>
      )}
    </button>
  );
}

interface Draft {
  id?: string;
  name: string;
  shared: boolean;
  queue: InboxQueue;
  scope: "all" | "mine";
  assignee: string;
  tag_ids: string[];
  field_id: string;
  field_value: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  shared: false,
  queue: "open",
  scope: "all",
  assignee: "",
  tag_ids: [],
  field_id: "",
  field_value: "",
};

function draftFrom(filters: Partial<InboxFilters>, base: Partial<Draft> = {}): Draft {
  return {
    ...EMPTY_DRAFT,
    queue: (filters.queue as InboxQueue) ?? "open",
    scope: filters.scope ?? "all",
    assignee: filters.assignee ?? "",
    tag_ids: filters.tag_ids ?? [],
    field_id: filters.field_id ?? "",
    field_value: filters.field_value ?? "",
    ...base,
  };
}

function ManageViewsDialog({
  open,
  onOpenChange,
  views,
  onChanged,
  currentFilters,
  members,
  tags,
  customFields,
  accountId,
  userId,
  canShare,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  views: InboxView[];
  onChanged: () => void;
  currentFilters: InboxFilters;
  members: Profile[];
  tags: Tag[];
  customFields: CustomField[];
  accountId: string | null;
  userId: string | null;
  canShare: boolean;
}) {
  const supabase = createClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const dropdownFields = customFields.filter((f) => isDropdownField(f));

  const canEdit = (v: InboxView) => v.owner_user_id === userId || (v.owner_user_id === null && canShare);

  async function save() {
    if (!draft || !accountId || !userId) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give the view a name.");
      return;
    }
    const filters: Partial<InboxFilters> = { queue: draft.queue, scope: draft.scope };
    if (draft.assignee) filters.assignee = draft.assignee;
    if (draft.tag_ids.length) filters.tag_ids = draft.tag_ids;
    if (draft.field_id && draft.field_value) {
      filters.field_id = draft.field_id;
      filters.field_value = draft.field_value;
    }
    setBusy(true);
    const row = {
      name,
      filters,
      owner_user_id: draft.shared ? null : userId,
      updated_at: new Date().toISOString(),
    };
    const { error } = draft.id
      ? await supabase.from("inbox_views").update(row).eq("id", draft.id)
      : await supabase.from("inbox_views").insert({
          ...row,
          account_id: accountId,
          created_by: userId,
          position: views.length,
        });
    setBusy(false);
    if (error) {
      toast.error(`Could not save view: ${error.message}`);
      return;
    }
    toast.success(draft.id ? "View updated" : "View created");
    setDraft(null);
    onChanged();
  }

  async function remove(v: InboxView) {
    if (!window.confirm(`Delete the view "${v.name}"? Conversations are not affected.`)) return;
    setBusy(true);
    const { error } = await supabase.from("inbox_views").delete().eq("id", v.id);
    setBusy(false);
    if (error) toast.error(`Could not delete: ${error.message}`);
    else onChanged();
  }

  async function move(index: number, dir: -1 | 1) {
    const a = views[index];
    const b = views[index + dir];
    if (!a || !b || !canEdit(a) || !canEdit(b)) return;
    setBusy(true);
    await Promise.all([
      supabase.from("inbox_views").update({ position: index + dir }).eq("id", a.id),
      supabase.from("inbox_views").update({ position: index }).eq("id", b.id),
    ]);
    setBusy(false);
    onChanged();
  }

  const selectClass =
    "h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) { onOpenChange(o); if (!o) setDraft(null); } }}>
      <DialogContent className="flex max-h-[min(88vh,720px)] flex-col border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{draft ? (draft.id ? "Edit view" : "New view") : "Saved views"}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            A view saves a queue plus filters as a tab, with a live count —
            for example a person&apos;s chats tagged &quot;Top Deals&quot;.
          </DialogDescription>
        </DialogHeader>

        {!draft ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {views.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No saved views yet.</p>
            )}
            {views.map((v, i) => (
              <div key={v.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{v.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {v.owner_user_id === null ? "Shared with team" : "Only you"} ·{" "}
                    {QUEUE_LABELS[(v.filters.queue as InboxQueue) ?? "all"]}
                  </p>
                </div>
                {canEdit(v) && (
                  <>
                    <button type="button" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" aria-label="Move down" disabled={busy || i === views.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Edit ${v.name}`}
                      onClick={() => setDraft(draftFrom(v.filters, { id: v.id, name: v.name, shared: v.owner_user_id === null }))}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" aria-label={`Delete ${v.name}`} onClick={() => remove(v)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-400">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <label className="block space-y-1 text-xs text-muted-foreground">
              Name
              <Input
                autoFocus
                value={draft.name}
                maxLength={60}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Neha · Top Deals"
                className="bg-muted text-foreground"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                Chats
                <select className={selectClass} value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as "all" | "mine" })}>
                  <option value="all">All chats</option>
                  <option value="mine">My chats</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Queue
                <select className={selectClass} value={draft.queue} onChange={(e) => setDraft({ ...draft, queue: e.target.value as InboxQueue })}>
                  {(Object.keys(QUEUE_LABELS) as InboxQueue[]).map((q) => (
                    <option key={q} value={q}>{QUEUE_LABELS[q]}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block space-y-1 text-xs text-muted-foreground">
              Assigned to
              <select className={selectClass} value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}>
                <option value="">Anyone</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>
                ))}
              </select>
            </label>
            {tags.length > 0 && (
              <div className="space-y-1 text-xs text-muted-foreground">
                Has any of these tags
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((t) => {
                    const on = draft.tag_ids.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            tag_ids: on ? draft.tag_ids.filter((x) => x !== t.id) : [...draft.tag_ids, t.id],
                          })
                        }
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                          on ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground",
                        )}
                      >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {dropdownFields.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  Field
                  <select className={selectClass} value={draft.field_id} onChange={(e) => setDraft({ ...draft, field_id: e.target.value, field_value: "" })}>
                    <option value="">Any</option>
                    {dropdownFields.map((f) => (
                      <option key={f.id} value={f.id}>{f.field_name}</option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  Value
                  <select
                    className={selectClass}
                    value={draft.field_value}
                    disabled={!draft.field_id}
                    onChange={(e) => setDraft({ ...draft, field_value: e.target.value })}
                  >
                    <option value="">Any</option>
                    {getFieldOptions(dropdownFields.find((f) => f.id === draft.field_id) ?? {}).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <label className={cn("flex items-center gap-2 text-sm", !canShare && "opacity-60")}>
              <input
                type="checkbox"
                className="accent-primary"
                checked={draft.shared}
                disabled={!canShare}
                onChange={(e) => setDraft({ ...draft, shared: e.target.checked })}
              />
              Share with the whole team
              {!canShare && <span className="text-xs text-muted-foreground">(admins only)</span>}
            </label>
          </div>
        )}

        <DialogFooter className="border-border bg-popover">
          {draft ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setDraft(null)} className="border-border text-muted-foreground">
                Back
              </Button>
              <Button disabled={busy || !draft.name.trim()} onClick={save} className="bg-primary text-primary-foreground hover:bg-primary/90">
                {busy && <Loader2 className="size-4 animate-spin" />}
                Save view
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setDraft(draftFrom(currentFilters))}
                className="border-border text-muted-foreground"
                title="Start from the filters you have applied now"
              >
                Save current filters
              </Button>
              <Button onClick={() => setDraft({ ...EMPTY_DRAFT })} className="bg-primary text-primary-foreground hover:bg-primary/90">
                <Plus className="size-4" />
                New view
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
