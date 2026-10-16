'use client';

import { useState } from 'react';
import type { Tag } from '@/types';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  FolderOpen,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';

export const GROUP_COLORS = [
  '#22c55e',
  '#3b82f6',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#14b8a6',
  '#ec4899',
  '#64748b',
];

interface ContactGroupsProps {
  /** Groups are the account's tags. */
  groups: Tag[];
  /** tag id → number of contacts in it (missing = still loading). */
  counts: Record<string, number>;
  /** Total contacts in the account, or null while loading. */
  allCount: number | null;
  /** The open group, or null for "All contacts". */
  activeGroupId: string | null;
  onOpenGroup: (tagId: string | null) => void;
  /** Present when the user may create groups (admin+). */
  onCreateGroup?: (name: string, color: string) => Promise<boolean>;
  /** Present when the user may rename groups (admin+). */
  onRenameGroup?: (tagId: string, name: string) => Promise<boolean>;
  /**
   * Present when the user may delete groups (admin+). With
   * `deleteContacts`, the group's contacts are deleted too; otherwise they
   * stay and only lose the group.
   */
  onDeleteGroup?: (tagId: string, deleteContacts: boolean) => Promise<boolean>;
}

/**
 * Card grid of contact groups (e.g. "Regal Garden clients", "Nature Park
 * clients"). A group is a tag, so it works everywhere tags already do —
 * broadcast audiences, inbox filters, automations — while giving the
 * Contacts page a folder-like way to browse them. Opening a card filters
 * the contacts table to that group.
 */
export function ContactGroups({
  groups,
  counts,
  allCount,
  activeGroupId,
  onOpenGroup,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
}: ContactGroupsProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(GROUP_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const [renameTarget, setRenameTarget] = useState<Tag | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);
  const [deleteContacts, setDeleteContacts] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    if (!onCreateGroup || !name.trim()) return;
    setSaving(true);
    const ok = await onCreateGroup(name.trim(), color);
    setSaving(false);
    if (ok) {
      setCreateOpen(false);
      setName('');
    }
  }

  async function handleRename() {
    if (!onRenameGroup || !renameTarget || !renameValue.trim()) return;
    setBusy(true);
    const ok = await onRenameGroup(renameTarget.id, renameValue.trim());
    setBusy(false);
    if (ok) setRenameTarget(null);
  }

  async function handleDelete() {
    if (!onDeleteGroup || !deleteTarget) return;
    setBusy(true);
    const ok = await onDeleteGroup(deleteTarget.id, deleteContacts);
    setBusy(false);
    if (ok) setDeleteTarget(null);
  }

  const cardBase =
    'flex min-w-0 flex-col gap-2 rounded-xl border p-3 text-left transition-all hover:border-primary/40 hover:bg-muted/40';
  const canManage = !!(onRenameGroup || onDeleteGroup);
  const deleteCount = deleteTarget ? counts[deleteTarget.id] : undefined;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
        Groups
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <button
          type="button"
          onClick={() => onOpenGroup(null)}
          className={cn(
            cardBase,
            activeGroupId === null
              ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
              : 'border-border bg-card',
          )}
        >
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              All contacts
            </p>
            <p className="text-xs text-muted-foreground">
              {allCount === null ? '…' : `${allCount.toLocaleString()} contacts`}
            </p>
          </div>
        </button>

        {groups.map((g) => {
          const active = activeGroupId === g.id;
          const count = counts[g.id];
          return (
            // A div, not a <button>: the card holds the ⋮ menu button,
            // and buttons can't be nested.
            <div
              key={g.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenGroup(g.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenGroup(g.id);
                }
              }}
              className={cn(
                cardBase,
                'relative cursor-pointer',
                active
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-card',
              )}
            >
              <div
                className="flex size-8 items-center justify-center rounded-lg"
                style={{ backgroundColor: `${g.color}22`, color: g.color }}
              >
                <FolderOpen className="size-4" />
              </div>
              <div className="min-w-0">
                <p
                  className="truncate pr-5 text-sm font-medium text-foreground"
                  title={g.name}
                >
                  {g.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {count === undefined ? '…' : `${count.toLocaleString()} contacts`}
                </p>
              </div>

              {canManage && (
                <div
                  className="absolute top-2 right-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`Manage ${g.name}`}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <MoreVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="border-border bg-popover">
                      {onRenameGroup && (
                        <DropdownMenuItem
                          onClick={() => {
                            setRenameTarget(g);
                            setRenameValue(g.name);
                          }}
                          className="text-popover-foreground"
                        >
                          <Pencil className="size-4" />
                          Rename
                        </DropdownMenuItem>
                      )}
                      {onRenameGroup && onDeleteGroup && (
                        <DropdownMenuSeparator className="bg-border" />
                      )}
                      {onDeleteGroup && (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setDeleteTarget(g);
                            setDeleteContacts(false);
                          }}
                        >
                          <Trash2 className="size-4" />
                          Delete group
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          );
        })}

        {onCreateGroup && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className={cn(
              cardBase,
              'items-center justify-center border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Plus className="size-5" />
            <span className="text-xs font-medium">New group</span>
          </button>
        )}
      </div>

      {/* New group */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              e.g. &quot;Garden City clients&quot;. Add contacts by ticking
              them in the table and choosing &quot;Add to group&quot;, or by
              importing a CSV into the group.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="Group name"
              className="bg-muted text-foreground"
            />
            <div className="flex flex-wrap gap-2">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Colour ${c}`}
                  className={cn(
                    'size-6 rounded-full ring-offset-2 ring-offset-popover transition-all',
                    color === c && 'ring-2 ring-foreground',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              className="border-border text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={saving || !name.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Create group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename group */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && !busy && setRenameTarget(null)}
      >
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleRename();
              }
            }}
            className="bg-muted text-foreground"
          />
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={busy}
              className="border-border text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              disabled={busy || !renameValue.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete group */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && !busy && setDeleteTarget(null)}
      >
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &quot;{deleteTarget?.name}&quot;?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {deleteCount === undefined
                ? 'Choose what happens to the contacts in this group.'
                : `This group has ${deleteCount.toLocaleString()} contact${deleteCount === 1 ? '' : 's'}. Choose what happens to them.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm',
                !deleteContacts ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <input
                type="radio"
                name="delete-group-mode"
                checked={!deleteContacts}
                onChange={() => setDeleteContacts(false)}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="font-medium text-foreground">
                  Delete the group only
                </span>
                <span className="block text-xs text-muted-foreground">
                  The contacts stay in your list; they just leave this group.
                </span>
              </span>
            </label>
            <label
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm',
                deleteContacts ? 'border-red-500/60 bg-red-500/5' : 'border-border',
              )}
            >
              <input
                type="radio"
                name="delete-group-mode"
                checked={deleteContacts}
                onChange={() => setDeleteContacts(true)}
                className="mt-0.5 accent-red-500"
              />
              <span>
                <span className="font-medium text-red-400">
                  Delete the group and all its contacts
                </span>
                <span className="block text-xs text-muted-foreground">
                  Permanently deletes these contacts, including from any other
                  groups. This can&apos;t be undone.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={busy}
              className="border-border text-muted-foreground"
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {deleteContacts ? 'Delete group & contacts' : 'Delete group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
