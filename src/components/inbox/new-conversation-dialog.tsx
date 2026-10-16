"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search, UserPlus, MessageSquarePlus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { isUniqueViolation } from "@/lib/contacts/dedupe";
import { toInternationalPhone } from "@/lib/whatsapp/phone-utils";
import type { Contact, MessageTemplate } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  TemplatePicker,
  type TemplateSendValues,
} from "@/components/inbox/template-picker";
import { cn } from "@/lib/utils";

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the conversation to open once it exists. */
  onStarted: (conversationId: string) => void;
}

/**
 * Start a chat with any contact (or a brand-new number) from the inbox.
 *
 * WhatsApp only lets a business open a conversation with an approved
 * template — free text is allowed only within 24h of the customer's last
 * message. So: if the contact already has a thread we simply open it (the
 * thread itself offers templates when the window is closed); otherwise we
 * ask for a template, send it — which creates the conversation — and open
 * the new thread.
 */
export function NewConversationDialog({
  open,
  onOpenChange,
  onStarted,
}: NewConversationDialogProps) {
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [mode, setMode] = useState<"search" | "new">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [newName, setNewName] = useState("");
  const [countryCode, setCountryCode] = useState("91");
  const [busy, setBusy] = useState(false);
  // Contact waiting for a template choice before the first send. Kept
  // separate from the picker's visibility: the picker closes itself the
  // moment a template is chosen, before the send has finished.
  const [pending, setPending] = useState<Contact | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);

  function askForTemplate(contact: Contact) {
    setPending(contact);
    setTemplateOpen(true);
  }

  // Debounced contact search by name or phone.
  useEffect(() => {
    if (!open || mode !== "search") return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      const term = query.trim();
      let q = supabase
        .from("contacts")
        .select("*")
        .order("name", { ascending: true, nullsFirst: false })
        .limit(30);
      if (term) {
        const like = `%${term.replace(/[%_,()]/g, "")}%`;
        q = q.or(`name.ilike.${like},phone.ilike.${like}`);
      }
      const { data } = await q;
      if (!cancelled) {
        setResults((data as Contact[] | null) ?? []);
        setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, mode, query, supabase]);

  function close() {
    onOpenChange(false);
    setPending(null);
    setQuery("");
    setNewPhone("");
    setNewName("");
    setMode("search");
  }

  async function startWith(contact: Contact) {
    setBusy(true);
    try {
      const { data: existing } = await supabase
        .from("conversations")
        .select("id")
        .eq("contact_id", contact.id)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        close();
        onStarted(existing.id);
        return;
      }
      // No thread yet — the first message has to be a template.
      askForTemplate(contact);
    } finally {
      setBusy(false);
    }
  }

  async function createAndStart() {
    const phone = toInternationalPhone(newPhone, countryCode);
    if (!phone) {
      toast.error("Enter a valid phone number, e.g. 98765 43210 or +919876543210");
      return;
    }
    if (!user || !accountId) {
      toast.error("You are not signed in.");
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("contacts")
        .insert({
          user_id: user.id,
          account_id: accountId,
          phone,
          name: newName.trim() || null,
        })
        .select("*")
        .single();
      if (error && isUniqueViolation(error)) {
        // Already a contact — use that one.
        const { data: found } = await supabase
          .from("contacts")
          .select("*")
          .eq("account_id", accountId)
          .eq("phone_normalized", phone.slice(1))
          .maybeSingle();
        if (found) {
          setBusy(false);
          await startWith(found as Contact);
          return;
        }
      }
      if (error || !data) {
        toast.error(`Could not save contact: ${error?.message ?? "unknown error"}`);
        return;
      }
      askForTemplate(data as Contact);
    } finally {
      setBusy(false);
    }
  }

  async function sendTemplate(template: MessageTemplate, values: TemplateSendValues) {
    if (!pending) return;
    const contact = pending;
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one.
          contact_id: contact.id,
          message_type: "template",
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(`Failed to send template: ${payload?.error || `HTTP ${res.status}`}`);
        return;
      }
      const { data: conv } = await supabase
        .from("conversations")
        .select("id")
        .eq("contact_id", contact.id)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      toast.success(`Conversation started with ${contact.name || contact.phone}`);
      close();
      if (conv?.id) onStarted(conv.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={open && !templateOpen}
        onOpenChange={(o) => (o ? onOpenChange(true) : !busy && close())}
      >
        <DialogContent className="flex max-h-[min(85vh,640px)] flex-col border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New conversation</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Pick a contact or enter a number. New chats start with an
              approved template, as WhatsApp requires.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs">
            {(
              [
                ["search", "Existing contact"],
                ["new", "New number"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 font-medium transition-colors",
                  mode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "search" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or phone…"
                  className="border-border bg-muted pl-9 text-sm"
                />
              </div>
              <ScrollArea className="h-72 rounded-md border border-border">
                {searching ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                ) : results.length === 0 ? (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No contacts found.{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setMode("new");
                        if (/\d/.test(query)) setNewPhone(query);
                        else setNewName(query);
                      }}
                      className="text-primary hover:underline"
                    >
                      Add a new number
                    </button>
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {results.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={busy}
                        onClick={() => startWith(c)}
                        className="flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-50"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                          {(c.name || c.phone || "?").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">
                            {c.name || "Unnamed"}
                          </p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {c.phone}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted pl-2 text-sm">
                  +
                  <input
                    type="text"
                    inputMode="numeric"
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    className="h-9 w-12 bg-transparent px-1 outline-none"
                    aria-label="Country code"
                  />
                </span>
                <Input
                  autoFocus
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="Phone number"
                  inputMode="tel"
                  className="border-border bg-muted"
                />
              </div>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name (optional)"
                className="border-border bg-muted"
              />
              <Button
                onClick={createAndStart}
                disabled={busy || !newPhone.trim()}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                Save contact &amp; choose template
              </Button>
            </div>
          )}

          {pending && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
              <span className="flex min-w-0 items-center gap-2 text-foreground">
                {busy ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <MessageSquarePlus className="size-3.5 shrink-0 text-primary" />
                )}
                <span className="truncate">
                  {busy ? "Sending template to " : "Start chat with "}
                  {pending.name || pending.phone}
                </span>
              </span>
              {!busy && (
                <button
                  type="button"
                  onClick={() => setTemplateOpen(true)}
                  className="shrink-0 font-medium text-primary hover:underline"
                >
                  Choose template
                </button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <TemplatePicker
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        onSelect={sendTemplate}
      />
    </>
  );
}
