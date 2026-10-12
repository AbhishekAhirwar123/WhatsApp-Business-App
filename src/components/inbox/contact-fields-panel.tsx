"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Plus, Search, SlidersHorizontal, Tag as TagIcon, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { addContactTag, deleteContactTag } from "@/lib/contacts/tag-api";
import {
  getFieldOptions,
  isDropdownField,
  withCurrentValue,
} from "@/lib/contacts/custom-field-options";
import { useCan } from "@/hooks/use-can";
import type { CustomField, Tag } from "@/types";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Fired after a contact's tags or custom values change, so the inbox list
 *  can refresh its badges. `detail` is the contact id. */
export const CONTACT_FIELDS_CHANGED_EVENT = "wacrm:contact-fields-changed";

function announce(contactId: string) {
  window.dispatchEvent(
    new CustomEvent(CONTACT_FIELDS_CHANGED_EVENT, { detail: contactId }),
  );
}

const sectionTitle =
  "flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground";

/**
 * Tags and custom fields for the contact behind the open chat, editable in
 * place — the inbox equivalent of the contact detail sheet, so agents can
 * set "Lead Status: Warm - 120 Days" or add a group without leaving the chat.
 */
export function ContactFieldsPanel({ contactId }: { contactId: string }) {
  const supabase = createClient();
  const canEdit = useCan("send-messages");

  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [fields, setFields] = useState<CustomField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingField, setSavingField] = useState<string | null>(null);
  const [tagBusy, setTagBusy] = useState(false);

  const load = useCallback(async () => {
    const [tagsRes, ctRes, fieldsRes, valuesRes] = await Promise.all([
      supabase.from("tags").select("*").order("name"),
      supabase.from("contact_tags").select("tag_id").eq("contact_id", contactId),
      supabase.from("custom_fields").select("*").order("field_name"),
      supabase
        .from("contact_custom_values")
        .select("custom_field_id, value")
        .eq("contact_id", contactId),
    ]);
    setAllTags((tagsRes.data as Tag[] | null) ?? []);
    setTagIds((ctRes.data ?? []).map((r) => r.tag_id as string));
    setFields((fieldsRes.data as CustomField[] | null) ?? []);
    const map: Record<string, string> = {};
    for (const v of valuesRes.data ?? []) map[v.custom_field_id] = v.value ?? "";
    setValues(map);
  }, [supabase, contactId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleTag(tagId: string) {
    setTagBusy(true);
    const has = tagIds.includes(tagId);
    try {
      if (has) await deleteContactTag(contactId, tagId);
      else await addContactTag(contactId, tagId);
      setTagIds((prev) => (has ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
      announce(contactId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update tags");
    } finally {
      setTagBusy(false);
    }
  }

  async function saveValue(fieldId: string, raw: string) {
    const value = raw.trim();
    if ((values[fieldId] ?? "") === value) return;
    setSavingField(fieldId);
    const { error } = value
      ? await supabase
          .from("contact_custom_values")
          .upsert(
            { contact_id: contactId, custom_field_id: fieldId, value },
            { onConflict: "contact_id,custom_field_id" },
          )
      : await supabase
          .from("contact_custom_values")
          .delete()
          .eq("contact_id", contactId)
          .eq("custom_field_id", fieldId);
    setSavingField(null);
    if (error) {
      toast.error(`Could not save: ${error.message}`);
      return;
    }
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    announce(contactId);
  }

  const tagsById = useMemo(() => new Map(allTags.map((t) => [t.id, t])), [allTags]);

  return (
    <>
      {/* Tags */}
      <div>
        <div className={cn(sectionTitle, "justify-between")}>
          <span className="flex items-center gap-2">
            <TagIcon className="h-3 w-3" />
            Tags / groups
          </span>
          {canEdit && (
            <TagPicker
              allTags={allTags}
              selected={tagIds}
              busy={tagBusy}
              onToggle={toggleTag}
            />
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {tagIds.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">No tags</p>
          ) : (
            tagIds.map((id) => {
              const tag = tagsById.get(id);
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                >
                  {tag.name}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => toggleTag(id)}
                      disabled={tagBusy}
                      aria-label={`Remove ${tag.name}`}
                      className="hover:opacity-70"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </span>
              );
            })
          )}
        </div>
      </div>

      <div className="my-4 border-t border-border" />

      {/* Custom fields */}
      <div>
        <div className={sectionTitle}>
          <SlidersHorizontal className="h-3 w-3" />
          Custom fields
        </div>
        {fields.length === 0 ? (
          <p className="mt-2 px-1 text-xs text-muted-foreground">
            No custom fields yet. Create them under Contacts → Custom fields
            (e.g. a &quot;Lead Status&quot; dropdown).
          </p>
        ) : (
          <div className="mt-2 space-y-2.5">
            {fields.map((field) => (
              <div key={field.id} className="space-y-1 px-1">
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {field.field_name}
                  {savingField === field.id && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                </label>
                {isDropdownField(field) ? (
                  <OptionSelect
                    options={withCurrentValue(getFieldOptions(field), values[field.id])}
                    value={values[field.id] ?? ""}
                    disabled={!canEdit}
                    onChange={(v) => saveValue(field.id, v)}
                  />
                ) : (
                  <input
                    key={`${field.id}:${values[field.id] ?? ""}`}
                    defaultValue={values[field.id] ?? ""}
                    disabled={!canEdit}
                    onBlur={(e) => saveValue(field.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    placeholder="—"
                    className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Searchable single-choice dropdown (like DoubleTick's "Search options"). */
function OptionSelect({
  options,
  value,
  disabled,
  onChange,
}: {
  options: string[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        className="flex h-8 w-full items-center justify-between rounded-md border border-border bg-muted px-2 text-left text-xs text-foreground outline-none hover:border-primary/50 disabled:opacity-60"
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value || "Select"}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        <div className="relative border-b border-border">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search options"
            className="h-9 w-full bg-transparent pr-2 pl-8 text-xs outline-none"
          />
        </div>
        <div className="max-h-60 overflow-y-auto py-1">
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              Clear
            </button>
          )}
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No options</p>
          ) : (
            shown.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-popover-foreground hover:bg-muted"
              >
                <span className="truncate">{o}</span>
                {o === value && <Check className="h-3 w-3 shrink-0 text-primary" />}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TagPicker({
  allTags,
  selected,
  busy,
  onToggle,
}: {
  allTags: Tag[];
  selected: string[];
  busy: boolean;
  onToggle: (tagId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = allTags.filter((t) =>
    t.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Popover onOpenChange={(o) => !o && setQuery("")}>
      <PopoverTrigger
        aria-label="Add tag"
        className="flex h-5 w-5 items-center justify-center rounded text-primary hover:bg-muted"
      >
        <Plus className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-0">
        <div className="relative border-b border-border">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tags"
            className="h-9 w-full bg-transparent pr-2 pl-8 text-xs normal-case outline-none"
          />
        </div>
        <div className="max-h-60 overflow-y-auto py-1">
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-xs normal-case text-muted-foreground">
              No tags. Create groups on the Contacts page.
            </p>
          ) : (
            shown.map((t) => {
              const on = selected.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onToggle(t.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs normal-case text-popover-foreground hover:bg-muted disabled:opacity-50"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {on && <Check className="h-3 w-3 text-primary" />}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
