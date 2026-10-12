"use client";

import { useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import type { Profile, Tag } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?"
  );
}

/** "Assign to" picker — one team member for every selected chat. */
export function AssignAgentDialog({
  open,
  onOpenChange,
  members,
  busy,
  onAssign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: Profile[];
  busy: boolean;
  onAssign: (userId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = members.filter(
    (m) =>
      (m.full_name ?? "").toLowerCase().includes(q) ||
      (m.email ?? "").toLowerCase().includes(q),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
        if (!o) setQuery("");
      }}
    >
      <DialogContent className="flex max-h-[min(80vh,560px)] flex-col gap-3 border-border bg-popover p-0 text-popover-foreground sm:max-w-md">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Assign to</DialogTitle>
        </DialogHeader>
        <div className="relative mx-5">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-10 w-full rounded-lg border border-border bg-muted pr-3 pl-9 text-sm outline-none focus:border-primary"
          />
        </div>
        <p className="mx-5 border-b border-border pb-2 text-xs font-medium text-primary">
          Members{" "}
          <span className="ml-1 rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
            {members.length}
          </span>
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto pb-3">
          {shown.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-muted-foreground">
              No members found.
            </p>
          ) : (
            shown.map((m) => (
              <button
                key={m.user_id}
                type="button"
                disabled={busy}
                onClick={() => onAssign(m.user_id)}
                className="flex w-full items-center gap-3 px-5 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                  {initials(m.full_name || m.email || "?")}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {m.full_name || m.email}
                  </span>
                  {m.full_name && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {m.email}
                    </span>
                  )}
                </span>
                {busy && <Loader2 className="ml-auto h-4 w-4 animate-spin" />}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Select one or more groups" — tags the selected chats' contacts. */
export function AddToGroupsDialog({
  open,
  onOpenChange,
  tags,
  busy,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: Tag[];
  busy: boolean;
  onApply: (tagIds: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const q = query.trim().toLowerCase();
  const shown = tags.filter((t) => t.name.toLowerCase().includes(q));

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        onOpenChange(o);
        if (!o) {
          setQuery("");
          setPicked([]);
        }
      }}
    >
      <DialogContent className="flex max-h-[min(80vh,560px)] flex-col gap-3 border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to groups</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search groups…"
            className="h-10 w-full rounded-lg border border-border bg-muted pr-3 pl-9 text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No groups. Create them on the Contacts page.
            </p>
          ) : (
            shown.map((t) => {
              const on = picked.includes(t.id);
              return (
                <label
                  key={t.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/60",
                    on && "bg-primary/5",
                  )}
                >
                  <Checkbox checked={on} onCheckedChange={() => toggle(t.id)} />
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
                  <span className="truncate text-foreground">{t.name}</span>
                  {on && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                </label>
              );
            })
          )}
        </div>
        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground"
          >
            Cancel
          </Button>
          <Button
            disabled={busy || picked.length === 0}
            onClick={() => onApply(picked)}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Add to {picked.length || ""} group{picked.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
