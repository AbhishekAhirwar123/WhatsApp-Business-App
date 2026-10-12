"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileText,
  LayoutTemplate,
  Loader2,
  Pencil,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import type { Contact, Conversation, MessageTemplate, Profile } from "@/types";
import { Button } from "@/components/ui/button";
import { TemplatePicker, type TemplateSendValues } from "@/components/inbox/template-picker";
import {
  DEFAULT_SEARCH_DAYS,
  buildMessageSearchOr,
  highlightParts,
} from "@/lib/inbox/message-search";
import { DEFAULT_INBOX_SETTINGS, loadInboxSettings } from "@/lib/inbox/settings";
import { formatInZone, utcIsoToZonedLocal, zonedLocalToUtcIso } from "@/lib/inbox/timezone";

function DrawerHeader({ title, icon, onClose }: { title: string; icon: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      {icon}
      <h3 className="flex-1 text-sm font-semibold text-foreground">{title}</h3>
      <button type="button" onClick={onClose} aria-label={`Close ${title}`} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ── Message search ──────────────────────────────────────────────────────

interface SearchHit {
  id: string;
  content_text: string | null;
  template_name: string | null;
  media_url: string | null;
  content_type: string;
  sender_type: string;
  created_at: string;
}

const SEARCH_PAGE = 20;

export function MessageSearchDrawer({
  conversationId,
  onClose,
  onJump,
}: {
  conversationId: string;
  onClose: () => void;
  onJump: (messageId: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [allTime, setAllTime] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState("");

  const run = useCallback(
    async (q: string, offset: number) => {
      const or = buildMessageSearchOr(q);
      if (!or) {
        setHits([]);
        setSearched("");
        return;
      }
      setLoading(true);
      let query = createClient()
        .from("messages")
        .select("id, content_text, template_name, media_url, content_type, sender_type, created_at")
        .eq("conversation_id", conversationId)
        .or(or)
        .order("created_at", { ascending: false })
        .range(offset, offset + SEARCH_PAGE - 1);
      if (!allTime) {
        // UTC boundary: now minus the window.
        query = query.gte("created_at", new Date(Date.now() - DEFAULT_SEARCH_DAYS * 86400_000).toISOString());
      }
      const { data, error } = await query;
      setLoading(false);
      if (error) {
        toast.error(`Search failed: ${error.message}`);
        return;
      }
      const rows = (data as SearchHit[] | null) ?? [];
      setHits((prev) => (offset === 0 ? rows : [...prev, ...rows]));
      setHasMore(rows.length === SEARCH_PAGE);
      setSearched(q);
    },
    [conversationId, allTime],
  );

  useEffect(() => {
    const h = setTimeout(() => run(term, 0), 300);
    return () => clearTimeout(h);
  }, [term, run]);

  return (
    <div className="flex h-full flex-col">
      <DrawerHeader title="Search messages" icon={<Search className="h-4 w-4 text-muted-foreground" />} onClose={onClose} />
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="Search text, templates, files"
            aria-label="Search messages in this chat"
            className="h-9 w-full rounded-lg border border-border bg-muted pr-3 pl-9 text-sm outline-none focus:border-primary"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" className="accent-primary" checked={allTime} onChange={(e) => setAllTime(e.target.checked)} />
          Search all history (default: last {DEFAULT_SEARCH_DAYS / 30} months)
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!searched && !loading ? (
          <p className="px-6 py-10 text-center text-xs text-muted-foreground">
            Search messages from the last 3 months of this chat. Tick “all history” to search older messages.
          </p>
        ) : hits.length === 0 && !loading ? (
          <p className="px-6 py-10 text-center text-xs text-muted-foreground">No messages match “{searched}”.</p>
        ) : (
          <ul className="divide-y divide-border">
            {hits.map((h) => {
              const text = h.content_text || h.template_name || h.media_url?.split("/").pop() || `[${h.content_type}]`;
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => onJump(h.id)}
                    className="w-full px-4 py-2.5 text-left hover:bg-muted/60"
                  >
                    <p className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>{h.sender_type === "customer" ? "Customer" : h.sender_type === "bot" ? "Bot" : "Team"}</span>
                      <span>{format(new Date(h.created_at), "d MMM yyyy, HH:mm")}</span>
                    </p>
                    <p className="mt-0.5 line-clamp-3 text-xs text-foreground">
                      {h.template_name && <LayoutTemplate className="mr-1 inline h-3 w-3 text-muted-foreground" />}
                      {h.media_url && <FileText className="mr-1 inline h-3 w-3 text-muted-foreground" />}
                      {highlightParts(text, searched).map((p, i) =>
                        p.match ? (
                          <mark key={i} className="rounded bg-amber-300/60 px-0.5 text-foreground dark:bg-amber-500/40">{p.text}</mark>
                        ) : (
                          <span key={i}>{p.text}</span>
                        ),
                      )}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {loading && <Loader2 className="mx-auto my-4 h-4 w-4 animate-spin text-primary" />}
        {hasMore && !loading && (
          <button type="button" onClick={() => run(searched, hits.length)} className="w-full py-3 text-xs text-primary hover:underline">
            Load more results
          </button>
        )}
      </div>
    </div>
  );
}

// ── Scheduled messages ──────────────────────────────────────────────────

interface Scheduled {
  id: string;
  created_by: string;
  message_type: "text" | "template";
  content_text: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: { body?: string[]; headerText?: string; buttonParams?: Record<number, string> } | null;
  scheduled_for: string;
  timezone: string;
  status: "queued" | "processing" | "sent" | "failed" | "canceled";
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

const STATUS_STYLE: Record<Scheduled["status"], string> = {
  queued: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  processing: "bg-amber-500/10 text-amber-600",
  sent: "bg-primary/10 text-primary",
  failed: "bg-red-500/10 text-red-500",
  canceled: "bg-muted text-muted-foreground",
};

export function ScheduledMessagesDrawer({
  conversation,
  contact,
  members,
  onClose,
}: {
  conversation: Conversation;
  contact: Contact;
  members: Profile[];
  onClose: () => void;
}) {
  const supabase = createClient();
  const { user, accountId } = useAuth();
  const canSchedule = useCan("send-messages");
  const isAdmin = useCan("edit-settings");
  const [rows, setRows] = useState<Scheduled[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<"recent" | "soonest">("recent");
  const [timeZone, setTimeZone] = useState(DEFAULT_INBOX_SETTINGS.timezone);
  const [editing, setEditing] = useState<Scheduled | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("scheduled_messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order(sortBy === "recent" ? "created_at" : "scheduled_for", { ascending: sortBy === "soonest" })
      .limit(100);
    setRows((data as Scheduled[] | null) ?? []);
    setLoading(false);
  }, [supabase, conversation.id, sortBy]);

  // Fetch on mount / when the subject changes; setState happens after the
  // await, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (accountId) loadInboxSettings(supabase, accountId).then((s) => setTimeZone(s.timezone));
  }, [supabase, accountId]);

  // Live state changes (worker picks up / sends) without a manual refresh.
  useEffect(() => {
    const channel = supabase
      .channel(`scheduled:${conversation.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "scheduled_messages", filter: `conversation_id=eq.${conversation.id}` },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, conversation.id, load]);

  async function cancel(row: Scheduled) {
    if (!window.confirm("Cancel this scheduled message?")) return;
    const res = await fetch(`/api/inbox/scheduled/${row.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(body.error ?? "Could not cancel");
    else toast.success("Scheduled message canceled");
    load();
  }

  const nameOf = (id: string) => members.find((m) => m.user_id === id)?.full_name || "Someone";

  if (editing) {
    return (
      <ScheduleForm
        conversationId={conversation.id}
        contact={contact}
        timeZone={timeZone}
        existing={editing === "new" ? null : editing}
        onDone={() => {
          setEditing(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <DrawerHeader title="Scheduled messages" icon={<CalendarClock className="h-4 w-4 text-muted-foreground" />} onClose={onClose} />
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Sort by
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "recent" | "soonest")}
            className="rounded border border-border bg-muted px-1.5 py-1 text-xs text-foreground outline-none"
            aria-label="Sort scheduled messages"
          >
            <option value="recent">Most recent</option>
            <option value="soonest">Send time</option>
          </select>
        </label>
        {canSchedule && !contact.blocked_at && (
          <Button size="sm" onClick={() => setEditing("new")} className="h-7 bg-primary text-xs text-primary-foreground hover:bg-primary/90">
            Schedule
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <Loader2 className="mx-auto my-6 h-4 w-4 animate-spin text-primary" />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <CalendarClock className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">No scheduled messages</p>
            <p className="text-xs text-muted-foreground">Schedule a follow-up to send at a set time ({timeZone}).</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const canModify = r.status === "queued" && canSchedule && (r.created_by === user?.id || isAdmin);
              return (
                <li key={r.id} className="space-y-1 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize", STATUS_STYLE[r.status])}>
                      {r.status}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{formatInZone(r.scheduled_for, r.timezone || timeZone)}</span>
                  </div>
                  <p className="line-clamp-3 text-xs text-foreground">
                    {r.message_type === "template" ? (
                      <>
                        <LayoutTemplate className="mr-1 inline h-3 w-3 text-muted-foreground" />
                        Template <span className="font-medium">{r.template_name}</span>
                        {r.template_params?.body?.length ? ` (${r.template_params.body.join(", ")})` : ""}
                      </>
                    ) : (
                      r.content_text
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    WhatsApp · by {nameOf(r.created_by)} · created {format(new Date(r.created_at), "d MMM, HH:mm")}
                    {r.sent_at ? ` · sent ${format(new Date(r.sent_at), "d MMM, HH:mm")}` : ""}
                  </p>
                  {r.error && (
                    <p className="flex items-start gap-1 text-[11px] text-red-500">
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      {r.error}
                    </p>
                  )}
                  {canModify && (
                    <div className="flex gap-3 pt-0.5">
                      <button type="button" onClick={() => setEditing(r)} className="flex items-center gap-1 text-[11px] text-primary hover:underline">
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                      <button type="button" onClick={() => cancel(r)} className="flex items-center gap-1 text-[11px] text-red-500 hover:underline">
                        <XCircle className="h-3 w-3" /> Cancel
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ScheduleForm({
  conversationId,
  contact,
  timeZone,
  existing,
  onDone,
}: {
  conversationId: string;
  contact: Contact;
  timeZone: string;
  existing: Scheduled | null;
  onDone: () => void;
}) {
  const [type, setType] = useState<"text" | "template">(existing?.message_type ?? "template");
  const [text, setText] = useState(existing?.content_text ?? "");
  const [template, setTemplate] = useState<{ name: string; language: string | null; values: TemplateSendValues } | null>(
    existing?.template_name
      ? {
          name: existing.template_name,
          language: existing.template_language,
          values: { body: existing.template_params?.body ?? [], headerText: existing.template_params?.headerText, buttonParams: existing.template_params?.buttonParams },
        }
      : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  // Time-dependent defaults are computed once (not during every render).
  const [minLocal] = useState(() => utcIsoToZonedLocal(new Date().toISOString(), timeZone));
  const [when, setWhen] = useState(() =>
    existing
      ? utcIsoToZonedLocal(existing.scheduled_for, timeZone)
      : utcIsoToZonedLocal(new Date(Date.now() + 3600_000).toISOString(), timeZone),
  );
  const [busy, setBusy] = useState(false);

  async function submit() {
    const iso = zonedLocalToUtcIso(when, timeZone);
    if (!iso) {
      toast.error("Pick a date and time.");
      return;
    }
    const body: Record<string, unknown> = {
      conversation_id: conversationId,
      message_type: type,
      scheduled_for: iso,
      timezone: timeZone,
    };
    if (type === "text") body.content_text = text;
    else {
      if (!template) {
        toast.error("Choose a template.");
        return;
      }
      body.template_name = template.name;
      body.template_language = template.language;
      body.template_params = template.values;
    }
    setBusy(true);
    const res = await fetch(existing ? `/api/inbox/scheduled/${existing.id}` : "/api/inbox/scheduled", {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(payload.error ?? "Could not schedule");
      return;
    }
    toast.success(existing ? "Scheduled message updated" : "Message scheduled");
    onDone();
  }

  return (
    <div className="flex h-full flex-col">
      <DrawerHeader
        title={existing ? "Edit scheduled message" : "Schedule a message"}
        icon={<CalendarClock className="h-4 w-4 text-muted-foreground" />}
        onClose={onDone}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p className="text-xs text-muted-foreground">To {contact.name || contact.phone} on WhatsApp</p>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-xs">
          {(["template", "text"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={type === v}
              onClick={() => setType(v)}
              className={cn("rounded-md py-1.5 font-medium", type === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
            >
              {v === "template" ? "Approved template" : "Free text"}
            </button>
          ))}
        </div>
        {type === "text" ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={4096}
              aria-label="Message text"
              placeholder="Message to send"
              className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <p className="rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-400">
              Free text only sends if the customer messaged in the 24 hours before the send time. Otherwise it fails — it is never swapped for a template. Use a template for follow-ups after that window.
            </p>
          </>
        ) : (
          <div className="space-y-2">
            <Button variant="outline" onClick={() => setPickerOpen(true)} className="w-full justify-start border-border">
              <LayoutTemplate className="size-4" />
              {template ? template.name : "Choose an approved template"}
            </Button>
            {template?.values.body?.length ? (
              <p className="text-[11px] text-muted-foreground">Variables: {template.values.body.join(", ")}</p>
            ) : null}
          </div>
        )}
        <label className="block space-y-1 text-xs text-muted-foreground">
          Send at ({timeZone})
          <input
            type="datetime-local"
            value={when}
            min={minLocal}
            onChange={(e) => setWhen(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-3">
        <Button variant="outline" disabled={busy} onClick={onDone} className="border-border">Back</Button>
        <Button disabled={busy} onClick={submit} className="bg-primary text-primary-foreground hover:bg-primary/90">
          {busy && <Loader2 className="size-4 animate-spin" />}
          {existing ? "Save" : "Schedule"}
        </Button>
      </div>
      <TemplatePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(t: MessageTemplate, values: TemplateSendValues) =>
          setTemplate({ name: t.name, language: t.language ?? null, values })
        }
      />
    </div>
  );
}

// ── Recent bot runs ─────────────────────────────────────────────────────

interface FlowRun {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  current_node_key: string | null;
  flow: { name: string } | { name: string }[] | null;
}

interface FlowEvent {
  id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface AutomationLog {
  id: string;
  trigger_event: string | null;
  status: string;
  error_message: string | null;
  steps_executed: unknown;
  created_at: string;
  automation: { name: string } | { name: string }[] | null;
}

/** Strip anything token-like and cap length before showing an error. */
function sanitizeError(s: string | null | undefined): string | null {
  if (!s) return null;
  return s
    .replace(/(access_token|token|secret|key)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .slice(0, 300);
}

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export function BotRunsDrawer({
  conversationId,
  contactId,
  onClose,
}: {
  conversationId: string;
  contactId: string;
  onClose: () => void;
}) {
  const supabase = createClient();
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [logs, setLogs] = useState<AutomationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, FlowEvent[]>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [r, l] = await Promise.all([
        supabase
          .from("flow_runs")
          .select("id, status, started_at, ended_at, end_reason, current_node_key, flow:flows(name)")
          .or(`conversation_id.eq.${conversationId},contact_id.eq.${contactId}`)
          .order("started_at", { ascending: false })
          .limit(20),
        supabase
          .from("automation_logs")
          .select("id, trigger_event, status, error_message, steps_executed, created_at, automation:automations(name)")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);
      if (cancelled) return;
      setRuns((r.data as FlowRun[] | null) ?? []);
      setLogs((l.data as AutomationLog[] | null) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, conversationId, contactId]);

  async function toggleRun(id: string) {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    if (!events[id]) {
      const { data } = await supabase
        .from("flow_run_events")
        .select("id, event_type, node_key, payload, created_at")
        .eq("flow_run_id", id)
        .order("created_at");
      setEvents((e) => ({ ...e, [id]: (data as FlowEvent[] | null) ?? [] }));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <DrawerHeader title="Recent bot runs" icon={<Bot className="h-4 w-4 text-muted-foreground" />} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <Loader2 className="mx-auto my-6 h-4 w-4 animate-spin text-primary" />
        ) : runs.length === 0 && logs.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Bot className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">No bot runs for this contact</p>
            <p className="text-xs text-muted-foreground">Flow and automation runs appear here when they involve this contact.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {runs.length > 0 && (
              <p className="bg-muted/40 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Flows</p>
            )}
            {runs.map((r) => (
              <div key={r.id}>
                <button type="button" onClick={() => toggleRun(r.id)} className="flex w-full items-start gap-2 px-4 py-2.5 text-left hover:bg-muted/50" aria-expanded={expanded === r.id}>
                  {expanded === r.id ? <ChevronDown className="mt-0.5 h-3.5 w-3.5" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{one(r.flow)?.name ?? "Flow"}</p>
                    <p className="text-[10px] text-muted-foreground">
                      <span className="capitalize">{r.status.replace(/_/g, " ")}</span> · started {format(new Date(r.started_at), "d MMM HH:mm")}
                      {r.ended_at ? ` · ended ${format(new Date(r.ended_at), "HH:mm")}` : ""}
                      {r.end_reason ? ` · ${r.end_reason.replace(/_/g, " ")}` : ""}
                    </p>
                  </div>
                </button>
                {expanded === r.id && (
                  <ol className="space-y-1 px-10 pb-3">
                    {(events[r.id] ?? []).map((e) => (
                      <li key={e.id} className="text-[11px] text-muted-foreground">
                        <span className="text-foreground">{e.event_type.replace(/_/g, " ")}</span>
                        {e.node_key ? ` · ${e.node_key}` : ""} · {format(new Date(e.created_at), "HH:mm:ss")}
                        {e.event_type === "error" && (
                          <span className="block text-red-500">{sanitizeError(String((e.payload as { error?: string } | null)?.error ?? ""))}</span>
                        )}
                      </li>
                    ))}
                    {events[r.id]?.length === 0 && <li className="text-[11px] text-muted-foreground">No steps recorded.</li>}
                  </ol>
                )}
              </div>
            ))}
            {logs.length > 0 && (
              <p className="bg-muted/40 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Automations</p>
            )}
            {logs.map((l) => {
              const steps = Array.isArray(l.steps_executed) ? l.steps_executed.length : 0;
              return (
                <div key={l.id} className="px-4 py-2.5">
                  <p className="truncate text-xs font-medium text-foreground">{one(l.automation)?.name ?? "Automation"}</p>
                  <p className="text-[10px] text-muted-foreground">
                    <span className="capitalize">{l.status}</span> · {l.trigger_event?.replace(/_/g, " ") ?? "trigger"} · {steps} step{steps === 1 ? "" : "s"} · {format(new Date(l.created_at), "d MMM HH:mm")}
                  </p>
                  {sanitizeError(l.error_message) && <p className="mt-0.5 text-[11px] text-red-500">{sanitizeError(l.error_message)}</p>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
