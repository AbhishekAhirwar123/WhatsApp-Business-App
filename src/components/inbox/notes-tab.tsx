"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { History, Loader2, Lock, Pencil, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import type { Profile } from "@/types";
import { Button } from "@/components/ui/button";

interface Note {
  id: string;
  user_id: string;
  note_text: string;
  created_at: string;
  updated_at?: string | null;
}

interface Revision {
  id: string;
  action: "edited" | "deleted";
  previous_text: string;
  actor_user_id: string | null;
  created_at: string;
}

/**
 * Internal notes on the contact. Notes live in `contact_notes` and are
 * never passed to any send path, so they cannot reach WhatsApp. Authors
 * edit/delete their own notes, admins can moderate (RLS, migration 044),
 * and every edit/delete keeps the previous text in contact_note_revisions.
 */
export function NotesTab({ contactId, members }: { contactId: string; members: Profile[] }) {
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const canWrite = useCan("send-messages");
  const isAdmin = useCan("edit-settings");
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [history, setHistory] = useState<{ noteId: string; rows: Revision[] } | null>(null);

  const nameOf = (id: string | null) =>
    (id && members.find((m) => m.user_id === id)?.full_name) || "Someone";

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("contact_notes")
      .select("id, user_id, note_text, created_at, updated_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false });
    setNotes((data as Note[] | null) ?? []);
    setLoading(false);
  }, [supabase, contactId]);

  // Fetch on mount / when the subject changes; setState happens after the
  // await, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function add() {
    const text = draft.trim();
    if (!text || !user || !accountId) return;
    setSaving(true);
    const { error } = await supabase
      .from("contact_notes")
      .insert({ contact_id: contactId, account_id: accountId, user_id: user.id, note_text: text });
    setSaving(false);
    if (error) {
      toast.error(`Could not add note: ${error.message}`);
      return;
    }
    setDraft("");
    load();
  }

  async function saveEdit() {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("contact_notes")
      .update({ note_text: text })
      .eq("id", editing.id)
      .select("id");
    setSaving(false);
    if (error || !data?.length) {
      toast.error(error?.message ?? "You can only edit your own notes.");
      return;
    }
    setEditing(null);
    load();
  }

  async function remove(note: Note) {
    if (!window.confirm("Delete this note? Its text is kept in the note history.")) return;
    const { data, error } = await supabase.from("contact_notes").delete().eq("id", note.id).select("id");
    if (error || !data?.length) {
      toast.error(error?.message ?? "You can only delete your own notes.");
      return;
    }
    load();
  }

  async function showHistory(noteId: string) {
    const { data } = await supabase
      .from("contact_note_revisions")
      .select("id, action, previous_text, actor_user_id, created_at")
      .eq("note_id", noteId)
      .order("created_at", { ascending: false });
    setHistory({ noteId, rows: (data as Revision[] | null) ?? [] });
  }

  return (
    <div className="space-y-3 p-4">
      {canWrite && (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Add an internal note…"
            aria-label="New internal note"
            className="w-full resize-none rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-amber-500/60"
          />
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Lock className="h-3 w-3" /> Internal — never sent to the customer
            </span>
            <Button size="sm" disabled={saving || !draft.trim()} onClick={add} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Add note
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <Loader2 className="mx-auto h-4 w-4 animate-spin text-primary" />
      ) : notes.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No notes yet.</p>
      ) : (
        notes.map((n) => {
          const mine = n.user_id === user?.id;
          const canModify = canWrite && (mine || isAdmin);
          return (
            <div key={n.id} className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              {editing?.id === n.id ? (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                    rows={3}
                    aria-label="Edit note"
                    className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(null)} className="border-border">Cancel</Button>
                    <Button size="sm" disabled={saving} onClick={saveEdit} className="bg-primary text-primary-foreground">Save</Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm whitespace-pre-wrap text-foreground">{n.note_text}</p>
              )}
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span>
                  {nameOf(n.user_id)} · {format(new Date(n.created_at), "d MMM yyyy, HH:mm")}
                  {n.updated_at ? " · edited" : ""}
                </span>
                <span className="flex items-center gap-1">
                  {n.updated_at && (
                    <button type="button" onClick={() => showHistory(n.id)} aria-label="Note history" className="rounded p-0.5 hover:bg-muted hover:text-foreground">
                      <History className="h-3 w-3" />
                    </button>
                  )}
                  {canModify && editing?.id !== n.id && (
                    <>
                      <button type="button" onClick={() => setEditing({ id: n.id, text: n.note_text })} aria-label="Edit note" className="rounded p-0.5 hover:bg-muted hover:text-foreground">
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button type="button" onClick={() => remove(n)} aria-label="Delete note" className="rounded p-0.5 hover:bg-muted hover:text-red-400">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </span>
              </div>
              {history?.noteId === n.id && (
                <div className="mt-2 space-y-1 border-t border-border pt-2">
                  {history.rows.map((r) => (
                    <p key={r.id} className="text-[11px] text-muted-foreground">
                      <span className="font-medium">{format(new Date(r.created_at), "d MMM HH:mm")}</span> — {nameOf(r.actor_user_id)} {r.action}:{" "}
                      <span className="italic">“{r.previous_text}”</span>
                    </p>
                  ))}
                  <button type="button" onClick={() => setHistory(null)} className="text-[11px] text-primary hover:underline">Hide history</button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
