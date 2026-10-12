"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ArrowLeft, Loader2, Plus, Search, Settings2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { addContactTag, deleteContactTag } from "@/lib/contacts/tag-api";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Tag } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"];

interface TagsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  /** Tag ids the contact currently has. */
  current: string[];
  /** Configurable per account (inbox_settings.tag_selection_limit, default 50). */
  limit: number;
  /** Admins may create / rename / archive tags (RLS enforces it too). */
  canManage: boolean;
  onApplied: (tagIds: string[]) => void;
  onTagsChanged: () => void;
}

/**
 * "Add a tag" dialog: search or create, colored checkbox list with a
 * selection counter, Apply, and a Manage tags view (rename, recolor,
 * archive / restore). Archiving keeps the tag on existing contacts and in
 * history but hides it from pickers.
 */
export function TagsDialog({
  open,
  onOpenChange,
  contactId,
  current,
  limit,
  canManage,
  onApplied,
  onTagsChanged,
}: TagsDialogProps) {
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const [all, setAll] = useState<Tag[]>([]);
  const [selected, setSelected] = useState<string[]>(current);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);

  async function load() {
    const { data } = await supabase.from("tags").select("*").order("name");
    setAll((data as Tag[] | null) ?? []);
  }

  useEffect(() => {
    if (!open) return;
    setSelected(current);
    setQuery("");
    setManage(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const active = all.filter((t) => !t.archived_at || current.includes(t.id));
  const q = query.trim().toLowerCase();
  const shown = active.filter((t) => t.name.toLowerCase().includes(q));
  const exact = all.find((t) => t.name.trim().toLowerCase() === q);
  const changed = useMemo(() => {
    const a = new Set(current);
    const b = new Set(selected);
    return a.size !== b.size || [...a].some((x) => !b.has(x));
  }, [current, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= limit) {
        toast.error(`A contact can have at most ${limit} tags.`);
        return prev;
      }
      return [...prev, id];
    });
  }

  async function create() {
    const name = query.trim();
    if (!name || !accountId || !user) return;
    if (exact) {
      if (exact.archived_at) toast.info(`"${exact.name}" exists but is archived. Restore it under Manage tags.`);
      else toggle(exact.id);
      return;
    }
    setBusy(true);
    const color = COLORS[all.length % COLORS.length];
    const { data, error } = await supabase
      .from("tags")
      .insert({ name, color, account_id: accountId, user_id: user.id })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      // 23505 = a tag with the same name (any case) exists.
      toast.error(error?.code === "23505" ? "A tag with that name already exists." : `Could not create tag: ${error?.message}`);
      return;
    }
    setAll((prev) => [...prev, data as Tag].sort((a, b) => a.name.localeCompare(b.name)));
    setQuery("");
    toggle((data as Tag).id);
    onTagsChanged();
  }

  async function apply() {
    const add = selected.filter((id) => !current.includes(id));
    const remove = current.filter((id) => !selected.includes(id));
    setBusy(true);
    try {
      // Through the tag API so "tag added" automations still fire.
      for (const id of add) await addContactTag(contactId, id);
      for (const id of remove) await deleteContactTag(contactId, id);
      onApplied(selected);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update tags");
    } finally {
      setBusy(false);
    }
  }

  async function updateTag(id: string, patch: Partial<Tag>) {
    const { error } = await supabase.from("tags").update(patch).eq("id", id);
    if (error) {
      toast.error(error.code === "23505" ? "A tag with that name already exists." : error.message);
      return false;
    }
    await load();
    onTagsChanged();
    return true;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[min(85vh,640px)] flex-col gap-3 border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {manage && (
              <button type="button" onClick={() => setManage(false)} aria-label="Back to tag selection" className="rounded p-0.5 hover:bg-muted">
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {manage ? "Manage tags" : "Add a tag"}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {manage
              ? "Rename, recolor or archive tags. Archived tags stay on contacts and in history but can't be picked."
              : "Tags also act as groups for broadcasts and contact lists."}
          </DialogDescription>
        </DialogHeader>

        {!manage ? (
          <>
            <div className="relative">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canManage && q && !exact) {
                    e.preventDefault();
                    void create();
                  }
                }}
                placeholder={canManage ? "Search or create a tag" : "Search tags"}
                aria-label="Search tags"
                className="h-10 w-full rounded-lg border border-border bg-muted pr-3 pl-9 text-sm outline-none focus:border-primary"
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {selected.length}/{limit} selected
              </span>
              {canManage && (
                <button type="button" onClick={() => setManage(true)} className="flex items-center gap-1 text-primary hover:underline">
                  <Settings2 className="h-3.5 w-3.5" /> Manage tags
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border" role="listbox" aria-multiselectable="true">
              {canManage && q && !exact && (
                <button
                  type="button"
                  onClick={create}
                  disabled={busy}
                  className="flex w-full items-center gap-2 border-b border-border px-4 py-2.5 text-left text-sm text-primary hover:bg-primary/5"
                >
                  <Plus className="h-4 w-4" />
                  Create new tag &quot;{query.trim()}&quot;
                </button>
              )}
              {shown.length === 0 && !(canManage && q) ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">No tags found.</p>
              ) : (
                shown.map((t) => (
                  <label
                    key={t.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/60",
                      selected.includes(t.id) && "bg-primary/5",
                    )}
                  >
                    <Checkbox checked={selected.includes(t.id)} onCheckedChange={() => toggle(t.id)} />
                    <span
                      className="rounded px-2 py-0.5 text-xs font-medium"
                      style={{ backgroundColor: `${t.color}22`, color: t.color }}
                    >
                      {t.name}
                    </span>
                    {t.archived_at && <span className="text-[10px] text-muted-foreground">archived</span>}
                  </label>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {all.map((t) => (
              <ManageRow key={t.id} tag={t} onSave={(patch) => updateTag(t.id, patch)} />
            ))}
          </div>
        )}

        <DialogFooter className="border-border bg-popover">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)} className="border-border text-muted-foreground">
            {manage ? "Close" : "Cancel"}
          </Button>
          {!manage && (
            <Button disabled={busy || !changed} onClick={apply} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {busy && <Loader2 className="size-4 animate-spin" />}
              Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageRow({ tag, onSave }: { tag: Tag; onSave: (patch: Partial<Tag>) => Promise<boolean> }) {
  const [name, setName] = useState(tag.name);
  const archived = !!tag.archived_at;
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border border-border px-2 py-1.5", archived && "opacity-60")}>
      <div className="flex gap-1">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            onClick={() => c !== tag.color && onSave({ color: c })}
            className={cn("h-3.5 w-3.5 rounded-full", c === tag.color && "ring-2 ring-foreground ring-offset-1 ring-offset-popover")}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={async () => {
          const next = name.trim();
          if (!next || next === tag.name) return setName(tag.name);
          if (!(await onSave({ name: next }))) setName(tag.name);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        aria-label={`Rename ${tag.name}`}
        className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 text-sm outline-none hover:border-border focus:border-primary"
      />
      <button
        type="button"
        onClick={() => onSave({ archived_at: archived ? null : new Date().toISOString() })}
        title={archived ? "Restore" : "Archive"}
        aria-label={archived ? `Restore ${tag.name}` : `Archive ${tag.name}`}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
