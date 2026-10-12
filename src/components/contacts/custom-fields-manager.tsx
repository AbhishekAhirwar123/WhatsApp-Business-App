'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type { CustomField } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  List,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Type,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  getFieldOptions,
  isDropdownField,
  parseOptionsInput,
  type CustomFieldType,
} from '@/lib/contacts/custom-field-options';

interface CustomFieldsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog wrapper around {@link CustomFieldsPanel}, used on the Contacts page.
 * The same panel is rendered inline under Settings → Custom Fields, so the
 * editing UI lives in one place. Radix unmounts the dialog content on close,
 * so the panel remounts (and refetches) on each open.
 */
export function CustomFieldsManager({
  open,
  onOpenChange,
}: CustomFieldsManagerProps) {
  const t = useTranslations('Contacts.customFields');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('desc')}
          </DialogDescription>
        </DialogHeader>
        <CustomFieldsPanel />
      </DialogContent>
    </Dialog>
  );
}

/** Stable machine key from a label: "Lead Status" → "lead_status". */
export function fieldKeyFor(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'field'
  );
}

/**
 * Suggested fields from the Neoteric inbox reference. Editable after
 * creation; added only if no field with the same key or name exists
 * (idempotent — never touches existing definitions). Contact Owner is a
 * built-in member field on the contact, not a custom field. Sub-Channel's
 * options were not established, so it starts as free text.
 */
const SUGGESTED_FIELDS: { key: string; name: string; type: CustomFieldType; options?: string[] }[] = [
  {
    key: 'lead_status',
    name: 'Lead Status',
    type: 'select',
    options: ['Hot - 60 Days', 'Warm - 120 Days', 'Cold - Above 6 Months', 'Available', 'Invalid - Not Interested'],
  },
  {
    key: 'lead_source',
    name: 'Lead Source',
    type: 'select',
    options: ['YouTube', 'Newspaper', 'Double tick', 'BPO', 'Interact with Social Media'],
  },
  { key: 'sub_channel', name: 'Sub-Channel', type: 'text' },
];

const OPTIONS_PLACEHOLDER = [
  'One option per line, e.g.',
  'Hot - 60 Days',
  'Warm - 120 Days',
  'Cold - Above 6 Months',
].join('\n');

/**
 * Create / rename / delete account-wide custom contact field definitions.
 * Fields are either free text or a dropdown with fixed options (e.g. "Lead
 * Status"). Per-contact values are edited elsewhere (contact detail, inbox
 * side panel); this only manages the field catalogue. Admin+ gated by the
 * caller — the `custom_fields` RLS also rejects non-admin writes.
 */
export function CustomFieldsPanel() {
  const t = useTranslations('Contacts.customFields');
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<CustomFieldType>('text');
  const [newOptions, setNewOptions] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchFields = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data } = await supabase
      .from('custom_fields')
      .select('*')
      .order('sort_order')
      .order('field_name');
    setFields((data as CustomField[] | null) ?? []);
    setLoading(false);
  }, [supabase, accountId]);

  // Load the field list on mount once the account is known. The setters
  // inside fetchFields run after the Supabase await — not synchronously in
  // the effect body — so the cascade the lint rule warns about doesn't apply.
  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchFields();
    }
  }, [accountId, fetchFields]);

  /** Case-insensitive name clash within the loaded list. */
  function isDuplicate(name: string, exceptId?: string): boolean {
    const lower = name.toLowerCase();
    return fields.some(
      (f) => f.id !== exceptId && f.field_name.toLowerCase() === lower
    );
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (!accountId || !user) {
      toast.error(t('toastNoAccount'));
      return;
    }
    if (isDuplicate(name)) {
      toast.error(t('toastDuplicate', { name }));
      return;
    }
    const options = parseOptionsInput(newOptions);
    if (newType === 'select' && options.length === 0) {
      toast.error('Add at least one option for a dropdown field.');
      return;
    }

    setCreating(true);
    const { error } = await supabase.from('custom_fields').insert({
      field_name: name,
      field_type: newType,
      field_options: newType === 'select' ? { options } : null,
      field_key: uniqueKey(fieldKeyFor(name)),
      sort_order: fields.length,
      user_id: user.id,
      account_id: accountId,
    });
    setCreating(false);

    if (error) {
      toast.error(t('toastCreateFailed'));
      return;
    }
    toast.success(t('toastCreated', { name }));
    setNewName('');
    setNewOptions('');
    setNewType('text');
    await fetchFields();
  }

  /** Returns true on success so the row can keep the new name, false so it
   *  reverts to the previous one. No-ops (blank / unchanged) count as success. */
  async function handleRename(
    field: CustomField,
    nextName: string
  ): Promise<boolean> {
    const name = nextName.trim();
    if (!name || name === field.field_name) return true;
    if (isDuplicate(name, field.id)) {
      toast.error(t('toastDuplicate', { name }));
      return false;
    }
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .update({ field_name: name })
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(t('toastRenameFailed'));
      return false;
    }
    await fetchFields();
    return true;
  }

  async function handleOptionsSave(
    field: CustomField,
    options: string[],
  ): Promise<boolean> {
    if (options.length === 0) {
      toast.error('A dropdown needs at least one option.');
      return false;
    }
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .update({ field_options: { ...(field.field_options ?? {}), options } })
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(`Could not save options: ${error.message}`);
      return false;
    }
    toast.success('Options saved');
    await fetchFields();
    return true;
  }

  /** A key not used by another field of this account. */
  function uniqueKey(base: string): string {
    const taken = new Set(fields.map((f) => f.field_key).filter(Boolean));
    let key = base;
    for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
    return key;
  }

  async function patchField(field: CustomField, patch: Partial<CustomField>, okMsg?: string) {
    setBusyId(field.id);
    const { error } = await supabase.from('custom_fields').update(patch).eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (okMsg) toast.success(okMsg);
    await fetchFields();
  }

  async function move(index: number, dir: -1 | 1) {
    const a = fields[index];
    const b = fields[index + dir];
    if (!a || !b) return;
    await Promise.all([
      supabase.from('custom_fields').update({ sort_order: index + dir }).eq('id', a.id),
      supabase.from('custom_fields').update({ sort_order: index }).eq('id', b.id),
    ]);
    await fetchFields();
  }

  async function addSuggested() {
    if (!accountId || !user) return;
    const existingKeys = new Set(fields.map((f) => f.field_key));
    const existingNames = new Set(fields.map((f) => f.field_name.toLowerCase()));
    const missing = SUGGESTED_FIELDS.filter(
      (f) => !existingKeys.has(f.key) && !existingNames.has(f.name.toLowerCase()),
    );
    if (missing.length === 0) {
      toast.info('The suggested fields already exist.');
      return;
    }
    setCreating(true);
    const { error } = await supabase.from('custom_fields').insert(
      missing.map((f, i) => ({
        field_name: f.name,
        field_key: f.key,
        field_type: f.type,
        field_options: f.options ? { options: f.options } : null,
        sort_order: fields.length + i,
        user_id: user.id,
        account_id: accountId,
      })),
    );
    setCreating(false);
    if (error) {
      toast.error(`Could not add fields: ${error.message}`);
      return;
    }
    toast.success(`Added ${missing.map((f) => f.name).join(', ')}`);
    await fetchFields();
  }

  async function handleDelete(field: CustomField) {
    if (
      !window.confirm(
        t('deleteConfirm', { name: field.field_name })
      )
    ) {
      return;
    }
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .delete()
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(t('toastDeleteFailed'));
      return;
    }
    toast.success(t('toastDeleted', { name: field.field_name }));
    await fetchFields();
  }

  return (
    <div className="space-y-4">
      {/* Create */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newType === 'text') {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder={t('fieldName')}
            className="bg-muted text-foreground"
          />
          <Button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {t('addField')}
          </Button>
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs">
          {(
            [
              ['text', 'Text', Type],
              ['select', 'Dropdown', List],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setNewType(value)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors',
                newType === value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
        {newType === 'select' && (
          <textarea
            value={newOptions}
            onChange={(e) => setNewOptions(e.target.value)}
            rows={4}
            placeholder={OPTIONS_PLACEHOLDER}
            className="w-full resize-none rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        )}
      </div>

      <button
        type="button"
        onClick={addSuggested}
        disabled={creating}
        className="flex items-center gap-1.5 text-xs text-primary hover:underline disabled:opacity-50"
      >
        <Sparkles className="size-3.5" />
        Add suggested fields (Lead Status, Lead Source, Sub-Channel)
      </button>

      {/* List */}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : fields.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {fields.map((field, index) => (
              <FieldRow
                index={index}
                count={fields.length}
                onMove={move}
                onPatch={patchField}
                key={field.id}
                field={field}
                busy={busyId === field.id}
                onRename={handleRename}
                onDelete={handleDelete}
                onOptionsSave={handleOptionsSave}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single editable row. Controlled local state lets us commit on blur /
 *  Enter and cleanly revert to the last saved name when a rename fails. */
function FieldRow({
  index,
  count,
  onMove,
  onPatch,
  field,
  busy,
  onRename,
  onDelete,
  onOptionsSave,
}: {
  field: CustomField;
  busy: boolean;
  onRename: (field: CustomField, name: string) => Promise<boolean>;
  onDelete: (field: CustomField) => void;
  onOptionsSave: (field: CustomField, options: string[]) => Promise<boolean>;
  index: number;
  count: number;
  onMove: (index: number, dir: -1 | 1) => void;
  onPatch: (field: CustomField, patch: Partial<CustomField>, okMsg?: string) => void;
}) {
  const t = useTranslations('Contacts.customFields');
  const [name, setName] = useState(field.field_name);
  const dropdown = isDropdownField(field);
  const optionCount = getFieldOptions(field).length;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsText, setOptionsText] = useState(() =>
    getFieldOptions(field).join('\n'),
  );

  async function commit() {
    if (name.trim() === field.field_name) {
      setName(field.field_name); // normalise any whitespace-only edit
      return;
    }
    const ok = await onRename(field, name);
    if (!ok) setName(field.field_name);
  }

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-label={t('renameAria', { name: field.field_name })}
          className="focus:border-primary h-8 border-transparent bg-transparent text-foreground hover:border-border"
        />
        <button
          type="button"
          aria-label="Move up"
          disabled={busy || index === 0}
          onClick={() => onMove(index, -1)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Move down"
          disabled={busy || index === count - 1}
          onClick={() => onMove(index, 1)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
        >
          <ArrowDown className="size-3.5" />
        </button>
        {dropdown ? (
          <button
            type="button"
            onClick={() => setOptionsOpen((o) => !o)}
            title="Edit dropdown options"
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <List className="size-3" />
            {optionCount} options
            {optionsOpen ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
          </button>
        ) : (
          <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            Text
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() =>
            onPatch(
              field,
              { archived_at: field.archived_at ? null : new Date().toISOString() },
              field.archived_at ? 'Field restored' : 'Field archived — values are kept, it is hidden from contacts and the inbox',
            )
          }
          title={field.archived_at ? 'Restore field' : 'Archive field (keeps values)'}
          aria-label={field.archived_at ? `Restore ${field.field_name}` : `Archive ${field.field_name}`}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {field.archived_at ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => onDelete(field)}
          title={t('deleteTitle')}
          className="shrink-0 text-muted-foreground hover:text-red-400"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-3 pl-1 text-[11px] text-muted-foreground">
        {field.field_key && <span className="font-mono">key: {field.field_key}</span>}
        {field.archived_at && <span className="rounded bg-muted px-1.5">archived</span>}
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            className="accent-primary"
            disabled={busy}
            checked={!!field.required}
            onChange={(e) => onPatch(field, { required: e.target.checked })}
          />
          Required
        </label>
      </div>

      {dropdown && optionsOpen && (
        <div className="mt-2 space-y-2">
          <textarea
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            rows={Math.min(8, Math.max(3, optionsText.split('\n').length + 1))}
            placeholder="One option per line"
            className="w-full resize-none rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                const ok = await onOptionsSave(field, parseOptionsInput(optionsText));
                if (ok) setOptionsOpen(false);
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Save options
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
