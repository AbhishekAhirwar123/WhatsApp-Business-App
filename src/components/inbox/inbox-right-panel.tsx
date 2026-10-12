"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Ban,
  Check,
  Clock,
  Copy,
  Loader2,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tag as TagIcon,
  UserCircle2,
  Users,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { getFieldOptions, isDropdownField, withCurrentValue } from "@/lib/contacts/custom-field-options";
import { DEFAULT_INBOX_SETTINGS, loadInboxSettings } from "@/lib/inbox/settings";
import type { Contact, Conversation, CustomField, Profile, Tag } from "@/types";
import { format } from "date-fns";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CONTACT_FIELDS_CHANGED_EVENT } from "@/lib/inbox/events";
import { TagsDialog } from "@/components/inbox/tags-dialog";
import { NotesTab } from "@/components/inbox/notes-tab";
import {
  BotRunsDrawer,
  MessageSearchDrawer,
  ScheduledMessagesDrawer,
} from "@/components/inbox/panel-drawers";

export interface RightPanelState {
  tab: "details" | "calls" | "notes";
  /** A drawer temporarily replaces the tab body (chat + draft are kept). */
  drawer: null | "search" | "scheduled" | "bot_runs";
}

interface InboxRightPanelProps {
  conversation: Conversation | null;
  contact: Contact | null;
  members: Profile[];
  tags: Tag[];
  customFields: CustomField[];
  channelLabel: string | null;
  state: RightPanelState;
  onStateChange: (s: RightPanelState) => void;
  onJumpToMessage: (messageId: string) => void;
  onContactChange: (c: Contact) => void;
  onTagsChanged: () => void;
}

function announce(contactId: string) {
  window.dispatchEvent(new CustomEvent(CONTACT_FIELDS_CHANGED_EVENT, { detail: contactId }));
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
}

export function InboxRightPanel(props: InboxRightPanelProps) {
  const { conversation, contact, state, onStateChange } = props;

  if (!conversation || !contact) {
    return (
      <div className="flex h-full w-[340px] items-center justify-center border-l border-border bg-card px-6 text-center">
        <p className="text-sm text-muted-foreground">Select a conversation to see contact details.</p>
      </div>
    );
  }

  const closeDrawer = () => onStateChange({ ...state, drawer: null });

  return (
    <div className="flex h-full w-[340px] flex-col border-l border-border bg-card">
      {state.drawer ? (
        state.drawer === "search" ? (
          <MessageSearchDrawer conversationId={conversation.id} onClose={closeDrawer} onJump={props.onJumpToMessage} />
        ) : state.drawer === "scheduled" ? (
          <ScheduledMessagesDrawer conversation={conversation} contact={contact} members={props.members} onClose={closeDrawer} />
        ) : (
          <BotRunsDrawer conversationId={conversation.id} contactId={contact.id} onClose={closeDrawer} />
        )
      ) : (
        <>
          <div className="flex h-14 shrink-0 border-b border-border" role="tablist" aria-label="Contact panel">
            {(["details", "calls", "notes"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={state.tab === tab}
                onClick={() => onStateChange({ tab, drawer: null })}
                className={cn(
                  "flex-1 border-b-2 text-sm font-medium capitalize transition-colors",
                  state.tab === tab
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {state.tab === "details" && (
              <DetailsTab {...props} conversation={conversation} contact={contact} />
            )}
            {state.tab === "notes" && <NotesTab contactId={contact.id} members={props.members} />}
            {state.tab === "calls" && <CallsTab />}
          </div>
        </>
      )}
    </div>
  );
}

// ── Calls ──────────────────────────────────────────────────────────────
// No calling capability is integrated (no provider calling permissions,
// webhooks or records exist in WACRM). Show an honest capability state —
// never a fake call list or an endless spinner.
function CallsTab() {
  const canAdmin = useCan("edit-settings");
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Phone className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">Calling isn&apos;t set up</p>
      <p className="text-xs text-muted-foreground">
        WhatsApp Business calling is not connected for this account, so there
        is no call history to show. It requires the WhatsApp Cloud API
        Calling feature to be enabled for your business number and
        integrated in WACRM.
      </p>
      {canAdmin ? (
        <a
          href="https://developers.facebook.com/documentation/business-messaging/whatsapp/calling"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline"
        >
          Read Meta&apos;s calling documentation
        </a>
      ) : (
        <p className="text-[11px] text-muted-foreground">Ask an account admin if your team needs calling.</p>
      )}
    </div>
  );
}

// ── Details ────────────────────────────────────────────────────────────
function DetailsTab({
  conversation,
  contact,
  members,
  tags: allTags,
  customFields,
  channelLabel,
  onStateChange,
  onContactChange,
  onTagsChanged,
}: InboxRightPanelProps & { conversation: Conversation; contact: Contact }) {
  const supabase = createClient();
  const { accountId } = useAuth();
  const canEdit = useCan("send-messages");
  const canAdmin = useCan("edit-settings");
  const [copied, setCopied] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [tagLimit, setTagLimit] = useState(DEFAULT_INBOX_SETTINGS.tag_selection_limit);
  const [scheduledCount, setScheduledCount] = useState<number | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [optInOpen, setOptInOpen] = useState(false);

  const load = useCallback(async () => {
    const [ct, co, sc] = await Promise.all([
      supabase.from("contact_tags").select("tag_id").eq("contact_id", contact.id),
      supabase.from("conversation_collaborators").select("user_id").eq("conversation_id", conversation.id),
      supabase
        .from("scheduled_messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversation.id)
        .eq("status", "queued"),
    ]);
    setTagIds((ct.data ?? []).map((r) => r.tag_id as string));
    setCollaborators((co.data ?? []).map((r) => r.user_id as string));
    setScheduledCount(sc.count ?? 0);
  }, [supabase, contact.id, conversation.id]);

  // Fetch on mount / when the subject changes; setState happens after the
  // await, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (!accountId) return;
    loadInboxSettings(supabase, accountId).then((s) => setTagLimit(s.tag_selection_limit));
  }, [supabase, accountId]);

  const memberById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);
  const tagById = useMemo(() => new Map(allTags.map((t) => [t.id, t])), [allTags]);
  const displayName = contact.name || contactHandle(contact);

  async function setOwner(ownerId: string | null) {
    const { data, error } = await supabase
      .from("contacts")
      .update({ owner_user_id: ownerId })
      .eq("id", contact.id)
      .select("*")
      .single();
    if (error || !data) {
      toast.error(`Could not set owner: ${error?.message ?? "unknown error"}`);
      return;
    }
    onContactChange({ ...contact, ...(data as Contact) });
    toast.success(ownerId ? "Contact owner updated" : "Contact owner cleared");
  }

  const section = "border-b border-border px-4 py-3";
  const heading = "flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground";
  const plusBtn = "flex h-6 w-6 items-center justify-center rounded text-primary hover:bg-primary/10 disabled:opacity-40";

  return (
    <div>
      {/* Identity */}
      <div className={cn(section, "flex items-center gap-3")}>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {initials(displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(contactHandle(contact));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Copy customer phone number"
          >
            {contactHandle(contact)}
            {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Business channel — the number WE messaged from, not the customer's. */}
      <div className={section}>
        <p className={heading}>Contacted on</p>
        <p className="mt-1.5 flex items-center gap-2 text-sm text-foreground">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#25D366] text-[9px] font-bold text-white">W</span>
          {channelLabel ?? "WhatsApp business number"}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">Your connected WhatsApp business number</p>
      </div>

      {contact.blocked_at && (
        <div className={cn(section, "flex items-start gap-2 bg-red-500/5 text-xs text-red-600 dark:text-red-400")}>
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Blocked in the CRM {format(new Date(contact.blocked_at), "d MMM yyyy")}
            {contact.blocked_reason ? ` — ${contact.blocked_reason}` : ""}. No messages, schedules or automations will be sent.
          </span>
        </div>
      )}

      {/* Opt-in evidence */}
      <div className={section}>
        <div className={heading}>
          <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Opt-in</span>
          {canEdit && (
            <button type="button" onClick={() => setOptInOpen(true)} className="text-[11px] font-medium normal-case tracking-normal text-primary hover:underline">
              Record
            </button>
          )}
        </div>
        <OptInSummary contact={contact} recordedBy={contact.opt_in_recorded_by ? memberById.get(contact.opt_in_recorded_by) : undefined} />
      </div>

      {/* Scheduled messages */}
      <div className={cn(section, "flex items-center justify-between")}>
        <span className={cn(heading, "flex items-center gap-1.5")}>
          <Clock className="h-3.5 w-3.5" /> Scheduled messages
          {scheduledCount ? (
            <span className="rounded bg-primary px-1.5 text-[10px] text-primary-foreground">{scheduledCount}</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => onStateChange({ tab: "details", drawer: "scheduled" })}
          className="text-xs font-medium text-primary hover:underline"
        >
          View
        </button>
      </div>

      {/* Collaborators */}
      <div className={section}>
        <div className={heading}>
          <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Collaborators</span>
          {canEdit && (
            <button type="button" onClick={() => setCollabOpen(true)} aria-label="Edit collaborators" className={plusBtn}>
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {collaborators.length === 0 ? (
            <p className="text-xs text-muted-foreground">None</p>
          ) : (
            collaborators.map((id) => (
              <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 text-[8px] font-bold text-primary">
                  {initials(memberById.get(id)?.full_name || "?")}
                </span>
                {memberById.get(id)?.full_name || "Former member"}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Contact owner (distinct from the chat assignee) */}
      <div className={section}>
        <p className={cn(heading, "mb-1.5")}>
          <span className="flex items-center gap-1.5"><UserCircle2 className="h-3.5 w-3.5" /> Contact owner</span>
        </p>
        <select
          value={contact.owner_user_id ?? ""}
          disabled={!canEdit}
          onChange={(e) => setOwner(e.target.value || null)}
          aria-label="Contact owner"
          className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
        >
          <option value="">No owner</option>
          {members
            .filter((m) => m.account_role !== "viewer")
            .map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>
            ))}
        </select>
        <p className="mt-1 text-[10px] text-muted-foreground">Who owns this lead. Separate from who is assigned to the chat.</p>
      </div>

      {/* Tags */}
      <div className={section}>
        <div className={heading}>
          <span className="flex items-center gap-1.5"><TagIcon className="h-3.5 w-3.5" /> Tags</span>
          {canEdit && (
            <button type="button" onClick={() => setTagsOpen(true)} aria-label="Add tags" className={plusBtn}>
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {tagIds.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tags</p>
          ) : (
            tagIds.map((id) => {
              const t = tagById.get(id);
              if (!t) return null;
              return (
                <span key={id} className="rounded px-2 py-0.5 text-[11px] font-medium" style={{ backgroundColor: `${t.color}22`, color: t.color }}>
                  {t.name}
                </span>
              );
            })
          )}
        </div>
      </div>

      <CustomFieldsSection contact={contact} customFields={customFields} canEdit={canEdit} canAdmin={canAdmin} />

      <TagsDialog
        open={tagsOpen}
        onOpenChange={setTagsOpen}
        contactId={contact.id}
        current={tagIds}
        limit={tagLimit}
        canManage={canAdmin}
        onApplied={(ids) => {
          setTagIds(ids);
          announce(contact.id);
        }}
        onTagsChanged={onTagsChanged}
      />
      <CollaboratorsDialog
        open={collabOpen}
        onOpenChange={setCollabOpen}
        conversationId={conversation.id}
        accountId={accountId}
        members={members}
        current={collaborators}
        assigneeId={conversation.assigned_agent_id ?? null}
        onSaved={load}
      />
      <OptInDialog open={optInOpen} onOpenChange={setOptInOpen} contact={contact} onSaved={onContactChange} />
    </div>
  );
}

function OptInSummary({ contact, recordedBy }: { contact: Contact; recordedBy?: Profile }) {
  const status = contact.opt_in_status ?? "unknown";
  const label = status === "opted_in" ? "Opted in" : status === "opted_out" ? "Opted out" : "Not recorded";
  const when = status === "opted_out" ? contact.opt_out_at : contact.opt_in_at;
  return (
    <div className="mt-1.5 space-y-0.5">
      <span
        className={cn(
          "inline-flex rounded px-2 py-0.5 text-[11px] font-medium",
          status === "opted_in" && "bg-primary/10 text-primary",
          status === "opted_out" && "bg-red-500/10 text-red-500",
          status === "unknown" && "bg-muted text-muted-foreground",
        )}
      >
        {label}
      </span>
      {status !== "unknown" && (
        <p className="text-[11px] text-muted-foreground">
          {contact.opt_in_source ? `Source: ${contact.opt_in_source}` : "No source recorded"}
          {contact.opt_in_scope ? ` · ${contact.opt_in_scope}` : ""}
          {when ? ` · ${format(new Date(when), "d MMM yyyy")}` : ""}
          {recordedBy ? ` · by ${recordedBy.full_name}` : ""}
        </p>
      )}
      {status === "unknown" && (
        <p className="text-[11px] text-muted-foreground">A customer messaging you is not marketing consent. Record consent when you have it.</p>
      )}
    </div>
  );
}

function OptInDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contact: Contact;
  onSaved: (c: Contact) => void;
}) {
  const { user } = useAuth();
  const [status, setStatus] = useState<"opted_in" | "opted_out" | "unknown">(contact.opt_in_status ?? "unknown");
  const [source, setSource] = useState(contact.opt_in_source ?? "");
  const [scope, setScope] = useState(contact.opt_in_scope ?? "Marketing & updates on WhatsApp");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Reset the form to the stored values each time the dialog opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(contact.opt_in_status ?? "unknown");
    setSource(contact.opt_in_source ?? "");
    setScope(contact.opt_in_scope ?? "Marketing & updates on WhatsApp");
  }, [open, contact]);

  async function save() {
    if (status !== "unknown" && !source.trim()) {
      toast.error("Say where the consent came from (e.g. website form, signed booking form).");
      return;
    }
    setBusy(true);
    const now = new Date().toISOString();
    const patch =
      status === "opted_in"
        ? { opt_in_status: status, opt_in_source: source.trim(), opt_in_scope: scope.trim() || null, opt_in_at: now, opt_in_recorded_by: user?.id ?? null, opt_out_at: null }
        : status === "opted_out"
          ? { opt_in_status: status, opt_in_source: source.trim(), opt_out_at: now, opt_in_recorded_by: user?.id ?? null }
          : { opt_in_status: status, opt_in_source: null, opt_in_scope: null, opt_in_at: null, opt_out_at: null, opt_in_recorded_by: null };
    const { data, error } = await createClient().from("contacts").update(patch).eq("id", contact.id).select("*").single();
    setBusy(false);
    if (error || !data) {
      toast.error(`Could not save consent: ${error?.message ?? "unknown error"}`);
      return;
    }
    onSaved({ ...contact, ...(data as Contact) });
    onOpenChange(false);
    toast.success("Consent recorded");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record opt-in</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Store where and when this contact agreed (or refused) to receive
            business-initiated WhatsApp messages. Opted-out contacts never
            get templates, broadcasts or scheduled templates.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 text-xs">
            {([["opted_in", "Opted in"], ["opted_out", "Opted out"], ["unknown", "Unknown"]] as const).map(([v, l]) => (
              <button
                key={v}
                type="button"
                aria-pressed={status === v}
                onClick={() => setStatus(v)}
                className={cn("rounded-md py-1.5 font-medium", status === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
              >
                {l}
              </button>
            ))}
          </div>
          {status !== "unknown" && (
            <>
              <label className="block space-y-1 text-xs text-muted-foreground">
                Source (evidence)
                <input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="e.g. Website enquiry form, site visit register"
                  className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              {status === "opted_in" && (
                <label className="block space-y-1 text-xs text-muted-foreground">
                  Scope
                  <input
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                </label>
              )}
            </>
          )}
        </div>
        <DialogFooter className="border-border bg-popover">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)} className="border-border text-muted-foreground">Cancel</Button>
          <Button disabled={busy} onClick={save} className="bg-primary text-primary-foreground hover:bg-primary/90">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CollaboratorsDialog({
  open,
  onOpenChange,
  conversationId,
  accountId,
  members,
  current,
  assigneeId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conversationId: string;
  accountId: string | null;
  members: Profile[];
  current: string[];
  assigneeId: string | null;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const [picked, setPicked] = useState<string[]>(current);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPicked(current);
      setQuery("");
    }
  }, [open, current]);

  const eligible = members.filter((m) => m.account_role !== "viewer");
  const shown = eligible.filter((m) =>
    `${m.full_name ?? ""} ${m.email ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const add = picked.filter((id) => !current.includes(id));
  const remove = current.filter((id) => !picked.includes(id));
  const changed = add.length + remove.length > 0;

  async function confirm() {
    if (!accountId) return;
    setBusy(true);
    const supabase = createClient();
    try {
      if (add.length) {
        const { error } = await supabase.from("conversation_collaborators").insert(
          add.map((user_id) => ({ conversation_id: conversationId, user_id, account_id: accountId, added_by: user?.id ?? null })),
        );
        if (error) throw error;
      }
      if (remove.length) {
        const { error } = await supabase
          .from("conversation_collaborators")
          .delete()
          .eq("conversation_id", conversationId)
          .in("user_id", remove);
        if (error) throw error;
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(`Could not update collaborators: ${(err as { message?: string })?.message ?? "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[min(80vh,560px)] flex-col gap-3 border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Collaborators</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Teammates following this chat alongside the assignee. Adding a
            collaborator does not change who the chat is assigned to.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members"
            aria-label="Search members"
            className="h-10 w-full rounded-lg border border-border bg-muted pr-3 pl-9 text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          {shown.map((m) => (
            <label key={m.user_id} className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/60">
              <Checkbox
                checked={picked.includes(m.user_id)}
                onCheckedChange={() =>
                  setPicked((p) => (p.includes(m.user_id) ? p.filter((x) => x !== m.user_id) : [...p, m.user_id]))
                }
              />
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                {initials(m.full_name || m.email || "?")}
              </span>
              <span className="min-w-0 flex-1 truncate">{m.full_name || m.email}</span>
              {m.user_id === assigneeId && <span className="text-[10px] text-muted-foreground">assignee</span>}
            </label>
          ))}
        </div>
        <DialogFooter className="border-border bg-popover">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)} className="border-border text-muted-foreground">Cancel</Button>
          <Button disabled={busy || !changed} onClick={confirm} className="bg-primary text-primary-foreground hover:bg-primary/90">
            {busy && <Loader2 className="size-4 animate-spin" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Custom fields ─────────────────────────────────────────────────────
interface FieldValue {
  value: string;
  updated_at: string | null;
}

function CustomFieldsSection({
  contact,
  customFields,
  canEdit,
  canAdmin,
}: {
  contact: Contact;
  customFields: CustomField[];
  canEdit: boolean;
  canAdmin: boolean;
}) {
  const supabase = createClient();
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [attached, setAttached] = useState<string[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("contact_custom_values")
      .select("custom_field_id, value, updated_at")
      .eq("contact_id", contact.id);
    const map: Record<string, FieldValue> = {};
    for (const r of data ?? []) map[r.custom_field_id] = { value: r.value ?? "", updated_at: r.updated_at ?? null };
    setValues(map);
  }, [supabase, contact.id]);

  // Fetch on mount / when the subject changes; setState happens after the
  // await, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Fields shown: those with a value, required ones, and ones the agent
  // attached with "+" in this session.
  const shown = customFields.filter((f) => values[f.id]?.value || f.required || attached.includes(f.id));
  const available = customFields.filter((f) => !shown.includes(f));

  async function save(field: CustomField, raw: string) {
    const value = raw.trim();
    const prev = values[field.id];
    if ((prev?.value ?? "") === value) return;
    if (!value && field.required) {
      toast.error(`${field.field_name} is required.`);
      return;
    }
    if (value && isDropdownField(field) && !getFieldOptions(field).some((o) => o === value)) {
      toast.error("Pick one of the configured options.");
      return;
    }
    setSaving(field.id);
    try {
      let conflict = false;
      if (!prev) {
        if (!value) return;
        const { error } = await supabase
          .from("contact_custom_values")
          .insert({ contact_id: contact.id, custom_field_id: field.id, value });
        if (error) {
          if (error.code === "23505") conflict = true;
          else throw error;
        }
      } else if (!value) {
        const { error } = await supabase
          .from("contact_custom_values")
          .delete()
          .eq("contact_id", contact.id)
          .eq("custom_field_id", field.id);
        if (error) throw error;
      } else {
        // Compare-and-set on updated_at: never silently overwrite a
        // teammate's newer edit.
        let q = supabase
          .from("contact_custom_values")
          .update({ value })
          .eq("contact_id", contact.id)
          .eq("custom_field_id", field.id);
        if (prev.updated_at) q = q.eq("updated_at", prev.updated_at);
        const { data, error } = await q.select("custom_field_id");
        if (error) throw error;
        if (!data || data.length === 0) conflict = true;
      }
      if (conflict) {
        toast.warning(`${field.field_name} was changed by someone else — showing the latest value.`);
      }
      await load();
      announce(contact.id);
    } catch (err) {
      toast.error(`Could not save ${field.field_name}: ${(err as { message?: string })?.message ?? "unknown error"}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-1.5"><SlidersHorizontal className="h-3.5 w-3.5" /> Custom fields</span>
        {canEdit && available.length > 0 && (
          <Popover>
            <PopoverTrigger aria-label="Add a custom field" className="flex h-6 w-6 items-center justify-center rounded text-primary hover:bg-primary/10">
              <Plus className="h-4 w-4" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1">
              <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground normal-case">Add a field</p>
              {available.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setAttached((a) => [...a, f.id])}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-popover-foreground hover:bg-muted"
                >
                  {f.field_name}
                  <span className="text-[10px] text-muted-foreground">{isDropdownField(f) ? "dropdown" : "text"}</span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {customFields.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No custom fields yet.{canAdmin ? " Create them under Contacts → Custom fields (e.g. a Lead Status dropdown)." : ""}
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No values yet. Use + to fill in a field.</p>
      ) : (
        <div className="mt-2 space-y-2.5">
          {shown.map((f) => (
            <div key={f.id} className="space-y-1">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {f.field_name}
                {f.required && <span className="text-red-400">*</span>}
                {saving === f.id && <Loader2 className="h-3 w-3 animate-spin" />}
              </label>
              {isDropdownField(f) ? (
                <SearchableSelect
                  options={withCurrentValue(getFieldOptions(f), values[f.id]?.value)}
                  value={values[f.id]?.value ?? ""}
                  disabled={!canEdit || saving === f.id}
                  onChange={(v) => save(f, v)}
                  label={f.field_name}
                />
              ) : (
                <input
                  key={`${f.id}:${values[f.id]?.updated_at ?? ""}`}
                  defaultValue={values[f.id]?.value ?? ""}
                  disabled={!canEdit || saving === f.id}
                  onBlur={(e) => save(f, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  aria-label={f.field_name}
                  placeholder="—"
                  className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SearchableSelect({
  options,
  value,
  disabled,
  onChange,
  label,
}: {
  options: string[];
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={label}
        className="flex h-8 w-full items-center justify-between rounded-md border border-border bg-muted px-2 text-left text-xs text-foreground outline-none hover:border-primary/50 disabled:opacity-60"
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>{value || "Select"}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="relative border-b border-border">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search options"
            aria-label="Search options"
            className="h-9 w-full bg-transparent pr-2 pl-8 text-xs outline-none"
          />
        </div>
        <div className="max-h-60 overflow-y-auto py-1" role="listbox">
          {value && (
            <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted">
              <X className="h-3 w-3" /> Clear
            </button>
          )}
          {shown.map((o) => (
            <button
              key={o}
              type="button"
              role="option"
              aria-selected={o === value}
              onClick={() => { onChange(o); setOpen(false); }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-popover-foreground hover:bg-muted"
            >
              <span className="truncate">{o}</span>
              {o === value && <Check className="h-3 w-3 shrink-0 text-primary" />}
            </button>
          ))}
          {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No options</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
