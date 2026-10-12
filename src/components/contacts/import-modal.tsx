'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { isUniqueViolation, normalizeKey } from '@/lib/contacts/dedupe';
import {
  applyMapping,
  guessMapping,
  parseCsvTable,
  type ColumnMapping,
  type CsvTable,
  type MappedContactRow,
  type SystemField,
} from '@/lib/contacts/csv-mapping';
import { fetchAllPages } from '@/lib/broadcast-audience';
import {
  assignImportedContactTags,
  resolveImportTagIds,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
import type { CustomField, Tag } from '@/types';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  FolderPlus,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

const PREVIEW_LIMIT = 5;

const SYSTEM_FIELD_LABELS: Record<SystemField, string> = {
  phone: 'Phone (required)',
  name: 'Name',
  email: 'Email',
  company: 'Company',
  tags: 'Tags / groups (comma-separated)',
};

const SELECT_CLASS =
  'h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary';

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  invalidPhone: number;
  failed: number;
  failedDetails: { phone: string; name?: string; reason: string }[];
  tagsAssigned: number;
  customValuesSet: number;
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
  /** Group (tag) to pre-select — set when importing from inside a group. */
  defaultGroupTagId?: string | null;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
  defaultGroupTagId,
}: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [countryCode, setCountryCode] = useState('91');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [groupTagIds, setGroupTagIds] = useState<string[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Field + tag catalogues for the mapping table and the group picker.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [fieldsRes, tagsRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase.from('tags').select('*').order('name'),
      ]);
      if (cancelled) return;
      setCustomFields((fieldsRes.data as CustomField[] | null) ?? []);
      setTags((tagsRes.data as Tag[] | null) ?? []);
    })();
    // Pre-select the group the user is currently viewing (if any).
    setGroupTagIds(defaultGroupTagId ? [defaultGroupTagId] : []);
    return () => {
      cancelled = true;
    };
  }, [open, supabase, defaultGroupTagId]);

  function reset() {
    setFile(null);
    setTable(null);
    setMapping(null);
    setNewGroupName('');
    setGroupTagIds([]);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setResult(null);
    const parsed = parseCsvTable(await selected.text());
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      toast.error('That file has no rows. Check it has a header row and data.');
      e.target.value = '';
      return;
    }
    setFile(selected);
    setTable(parsed);
    setMapping(guessMapping(parsed.headers, customFields));
  }

  const mappedRows: MappedContactRow[] = useMemo(
    () =>
      table && mapping && mapping.phone >= 0
        ? applyMapping(table, mapping, { defaultCountryCode: countryCode })
        : [],
    [table, mapping, countryCode],
  );
  const validCount = mappedRows.filter((r) => r.phoneValid).length;
  const invalidCount = mappedRows.length - validCount;

  /** Columns already used by another field, so the dropdowns can say so. */
  const usedBy = useMemo(() => {
    const m = new Map<number, string>();
    if (!mapping) return m;
    for (const f of Object.keys(SYSTEM_FIELD_LABELS) as SystemField[]) {
      if (mapping[f] >= 0) m.set(mapping[f], f);
    }
    for (const [id, idx] of Object.entries(mapping.custom)) {
      if (idx >= 0) m.set(idx, id);
    }
    return m;
  }, [mapping]);

  function setFieldColumn(key: SystemField | { custom: string }, idx: number) {
    setMapping((prev) => {
      if (!prev) return prev;
      if (typeof key === 'string') return { ...prev, [key]: idx };
      return { ...prev, custom: { ...prev.custom, [key.custom]: idx } };
    });
  }

  function toggleGroup(tagId: string) {
    setGroupTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }

  async function handleImport() {
    if (!mapping || mappedRows.length === 0) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId) throw new Error('Your profile is not linked to an account.');

      const res: ImportResult = {
        imported: 0,
        updated: 0,
        skipped: 0,
        invalidPhone: 0,
        failed: 0,
        failedDetails: [],
        tagsAssigned: 0,
        customValuesSet: 0,
      };

      // Group names applied to every imported row, on top of any per-row
      // tags column.
      const groupNames = [
        ...tags.filter((tag) => groupTagIds.includes(tag.id)).map((tag) => tag.name),
        ...(newGroupName.trim() ? [newGroupName.trim()] : []),
      ];

      // 1) Drop unusable numbers and in-file duplicates (first row wins).
      const seen = new Set<string>();
      const unique: MappedContactRow[] = [];
      for (const row of mappedRows) {
        if (!row.phoneValid) {
          res.invalidPhone++;
          continue;
        }
        const key = normalizeKey(row.phone);
        if (seen.has(key)) {
          res.skipped++;
          continue;
        }
        seen.add(key);
        unique.push(row);
      }

      // 2) Which numbers already exist in this account? Paged, because a
      //    single read stops at 1000 rows and later dupes would slip by.
      const existingRows = await fetchAllPages<{
        id: string;
        phone_normalized: string | null;
      }>((from, to) =>
        supabase
          .from('contacts')
          .select('id, phone_normalized')
          .eq('account_id', accountId)
          .order('id')
          .range(from, to),
      );
      const existingIdByKey = new Map<string, string>();
      for (const r of existingRows) {
        if (r.phone_normalized) existingIdByKey.set(r.phone_normalized, r.id);
      }

      // contact id ↔ source row, for tags and custom values afterwards.
      const touched: { contactId: string; row: MappedContactRow }[] = [];
      const toInsert: MappedContactRow[] = [];

      for (const row of unique) {
        const existingId = existingIdByKey.get(normalizeKey(row.phone));
        if (!existingId) {
          toInsert.push(row);
        } else if (!updateExisting) {
          res.skipped++;
        } else {
          // Only overwrite fields the file actually has a value for.
          const patch: Record<string, string> = {};
          if (row.name) patch.name = row.name;
          if (row.email) patch.email = row.email;
          if (row.company) patch.company = row.company;
          if (Object.keys(patch).length > 0) {
            const { error } = await supabase
              .from('contacts')
              .update({ ...patch, updated_at: new Date().toISOString() })
              .eq('id', existingId);
            if (error) {
              res.failed++;
              res.failedDetails.push({
                phone: row.phone,
                name: row.name,
                reason: error.message,
              });
              continue;
            }
          }
          res.updated++;
          touched.push({ contactId: existingId, row });
        }
      }

      // 3) Insert new contacts in chunks; retry a failed chunk row by row
      //    so one bad row doesn't sink its neighbours.
      const CHUNK = 50;
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        const chunk = toInsert.slice(i, i + CHUNK);
        const payload = chunk.map((row) => ({
          user_id: user.id,
          account_id: accountId,
          phone: row.phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        }));

        const { data, error } = await supabase
          .from('contacts')
          .insert(payload)
          .select('id');

        if (!error) {
          // A single INSERT preserves RETURNING order, so data[j] ↔ chunk[j].
          (data ?? []).forEach((d, j) =>
            touched.push({ contactId: d.id, row: chunk[j] }),
          );
          res.imported += data?.length ?? 0;
          continue;
        }

        for (let j = 0; j < payload.length; j++) {
          const { data: single, error: singleErr } = await supabase
            .from('contacts')
            .insert(payload[j])
            .select('id')
            .single();
          if (!singleErr && single) {
            res.imported++;
            touched.push({ contactId: single.id, row: chunk[j] });
          } else if (isUniqueViolation(singleErr)) {
            res.skipped++;
          } else {
            res.failed++;
            console.error('[contacts import] insert failed for', payload[j].phone, singleErr);
            res.failedDetails.push({
              phone: payload[j].phone,
              name: payload[j].name ?? undefined,
              reason:
                (singleErr as { message?: string } | null)?.message ||
                t('unknownReason'),
            });
          }
        }
      }

      // 4) Tags + groups. Failure here must not mask the contact import.
      const assignments: ContactTagAssignment[] = touched
        .map(({ contactId, row }) => ({
          contactId,
          tagNames: [...row.tagNames, ...groupNames],
        }))
        .filter((a) => a.tagNames.length > 0);
      let skippedTagNames: string[] = [];
      if (assignments.length > 0) {
        try {
          const resolved = await resolveImportTagIds(supabase, {
            accountId,
            userId: user.id,
            tagNames: assignments.flatMap((a) => a.tagNames),
            canCreateTags: canEditSettings,
          });
          skippedTagNames = resolved.skippedNames;
          res.tagsAssigned = await assignImportedContactTags(
            supabase,
            assignments,
            resolved.tagIdByKey,
          );
        } catch {
          toast.warning(t('toastTagsWarning'));
        }
      }

      // 5) Custom field values (upsert — re-imports overwrite).
      const customRows = touched.flatMap(({ contactId, row }) =>
        Object.entries(row.customValues).map(([fieldId, value]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value,
        })),
      );
      for (let i = 0; i < customRows.length; i += 200) {
        const chunk = customRows.slice(i, i + 200);
        const { error } = await supabase
          .from('contact_custom_values')
          .upsert(chunk, { onConflict: 'contact_id,custom_field_id' });
        if (error) {
          toast.warning(`Some custom field values could not be saved: ${error.message}`);
          break;
        }
        res.customValuesSet += chunk.length;
      }

      setResult(res);
      if (res.imported > 0 || res.updated > 0) {
        toast.success(
          `${res.imported} imported${res.updated ? `, ${res.updated} updated` : ''}`,
        );
        onImported();
      }
      if (skippedTagNames.length > 0) {
        const sample = skippedTagNames.slice(0, 3).join(', ');
        const more =
          skippedTagNames.length > 3 ? ` (+${skippedTagNames.length - 3} more)` : '';
        toast.info(t('toastTagsSkipped', { sample, more }));
      }
      if (res.failed > 0) toast.error(t('toastFailed', { count: res.failed }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = mappedRows.slice(0, PREVIEW_LIMIT);
  const customFieldName = (id: string) =>
    customFields.find((f) => f.id === id)?.field_name ?? 'Custom field';

  // A render helper, not a nested component: a component defined in the
  // render body would remount (and lose focus) on every keystroke.
  function renderColumnSelect(
    value: number,
    ownKey: string,
    onChange: (idx: number) => void,
  ) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={SELECT_CLASS}
      >
        <option value={-1}>— Don&apos;t import —</option>
        {table?.headers.map((h, idx) => {
          const owner = usedBy.get(idx);
          const takenElsewhere = owner !== undefined && owner !== ownKey;
          return (
            <option key={idx} value={idx}>
              {h || `Column ${idx + 1}`}
              {takenElsewhere ? ' (already mapped)' : ''}
            </option>
          );
        })}
      </select>
    );
  }

  const sample = (idx: number) =>
    idx >= 0 ? (table?.rows.find((r) => r[idx]?.trim())?.[idx] ?? '') : '';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(92vh,820px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-3xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground">
              Upload any CSV. You&apos;ll match its columns to contact fields
              (phone, name, custom fields…) in the next step, so the column
              names in your file don&apos;t need to change.
            </DialogDescription>
          </DialogHeader>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer items-center justify-center gap-3 rounded-xl border border-dashed p-4 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70',
            )}
          >
            {file ? (
              <>
                <FileText className="text-primary size-5 shrink-0" />
                <p className="truncate text-sm font-medium" title={file.name}>
                  {truncateFilename(file.name)}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
                  {table?.rows.length ?? 0} rows · {table?.headers.length ?? 0} columns
                </span>
                <span className="text-[11px] text-primary">Change file</span>
              </>
            ) : (
              <>
                <Upload className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{t('uploadDropzone')}</p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {table && mapping && !result && (
            <>
              {/* Field mapping */}
              <section className="space-y-2">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  1 · Match columns to fields
                </p>
                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-background/60">
                      <tr className="border-b border-border">
                        <th className="w-[34%] px-3 py-2 text-left font-medium text-muted-foreground">
                          Contact field
                        </th>
                        <th className="w-[36%] px-3 py-2 text-left font-medium text-muted-foreground">
                          Column in your CSV
                        </th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                          Sample value
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {(Object.keys(SYSTEM_FIELD_LABELS) as SystemField[]).map((f) => (
                        <tr key={f}>
                          <td
                            className={cn(
                              'px-3 py-1.5',
                              f === 'phone' && mapping.phone < 0
                                ? 'text-red-400'
                                : 'text-popover-foreground',
                            )}
                          >
                            {SYSTEM_FIELD_LABELS[f]}
                          </td>
                          <td className="px-3 py-1.5">
                            {renderColumnSelect(mapping[f], f, (idx) =>
                              setFieldColumn(f, idx),
                            )}
                          </td>
                          <td className="max-w-[10rem] truncate px-3 py-1.5 text-muted-foreground">
                            {sample(mapping[f]) || '—'}
                          </td>
                        </tr>
                      ))}
                      {customFields.map((cf) => {
                        const idx = mapping.custom[cf.id] ?? -1;
                        return (
                          <tr key={cf.id}>
                            <td className="px-3 py-1.5 text-popover-foreground">
                              {cf.field_name}
                              <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                                custom
                              </span>
                            </td>
                            <td className="px-3 py-1.5">
                              {renderColumnSelect(idx, cf.id, (next) =>
                                setFieldColumn({ custom: cf.id }, next),
                              )}
                            </td>
                            <td className="max-w-[10rem] truncate px-3 py-1.5 text-muted-foreground">
                              {sample(idx) || '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Need to store a column like &quot;Property&quot; or
                  &quot;Budget&quot;? Create it under Contacts → Custom fields
                  first, then re-open this dialog to map it.
                </p>
              </section>

              {/* Phone + duplicates */}
              <section className="space-y-2">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  2 · Phone numbers
                </p>
                <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  Country code for numbers written without one
                  <span className="inline-flex items-center rounded-md border border-border bg-muted pl-2 text-sm text-foreground">
                    +
                    <input
                      type="text"
                      inputMode="numeric"
                      value={countryCode}
                      onChange={(e) =>
                        setCountryCode(e.target.value.replace(/\D/g, '').slice(0, 4))
                      }
                      className="h-8 w-14 bg-transparent px-1 outline-none"
                      aria-label="Default country code"
                    />
                  </span>
                </label>
                <label className="flex items-center gap-2 text-xs text-popover-foreground">
                  <input
                    type="checkbox"
                    checked={updateExisting}
                    onChange={(e) => setUpdateExisting(e.target.checked)}
                    className="accent-primary"
                  />
                  If a number already exists, update that contact (name,
                  email, company, custom fields, groups) instead of skipping it
                </label>
              </section>

              {/* Groups */}
              <section className="space-y-2">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  3 · Add everyone in this file to a group (optional)
                </p>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => {
                      const on = groupTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleGroup(tag.id)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-all',
                            on
                              ? 'border-primary/30 bg-primary/10 text-primary'
                              : 'border-border bg-muted text-muted-foreground hover:text-foreground',
                          )}
                        >
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {canEditSettings && (
                  <div className="flex items-center gap-2">
                    <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="…or create a new group, e.g. Regal Garden clients"
                      className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                  </div>
                )}
              </section>

              {/* Preview */}
              <section className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    4 · Preview
                  </p>
                  <div className="flex gap-2 text-[11px]">
                    <span className="rounded-md bg-primary/10 px-2 py-0.5 text-primary">
                      {validCount} ready
                    </span>
                    {invalidCount > 0 && (
                      <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-500">
                        {invalidCount} with an unusable phone (will be skipped)
                      </span>
                    )}
                  </div>
                </div>
                {mapping.phone < 0 ? (
                  <p className="text-xs text-red-400">
                    Choose which column holds the phone number to continue.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full min-w-[32rem] text-xs">
                      <thead className="bg-background/60">
                        <tr className="border-b border-border">
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Phone</th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Email</th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">Groups / tags</th>
                          {Object.keys(mapping.custom)
                            .filter((id) => mapping.custom[id] >= 0)
                            .map((id) => (
                              <th key={id} className="px-3 py-2 text-left font-medium text-muted-foreground">
                                {customFieldName(id)}
                              </th>
                            ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/70">
                        {preview.map((row, i) => (
                          <tr key={i}>
                            <td
                              className={cn(
                                'px-3 py-1.5 font-mono whitespace-nowrap',
                                row.phoneValid ? 'text-muted-foreground' : 'text-amber-500',
                              )}
                              title={row.phoneValid ? undefined : 'Not a usable phone number'}
                            >
                              {row.phone || '(empty)'}
                            </td>
                            <td className="px-3 py-1.5">{row.name || '—'}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{row.email || '—'}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {[
                                ...row.tagNames,
                                ...tags
                                  .filter((tg) => groupTagIds.includes(tg.id))
                                  .map((tg) => tg.name),
                                ...(newGroupName.trim() ? [newGroupName.trim()] : []),
                              ].join(', ') || '—'}
                            </td>
                            {Object.keys(mapping.custom)
                              .filter((id) => mapping.custom[id] >= 0)
                              .map((id) => (
                                <td key={id} className="px-3 py-1.5 text-muted-foreground">
                                  {row.customValues[id] || '—'}
                                </td>
                              ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          {result && (
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <p className="text-sm font-medium text-popover-foreground">{t('importComplete')}</p>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.imported} new contacts
                  </div>
                )}
                {result.updated > 0 && (
                  <div className="flex items-center gap-1.5 text-sky-400">
                    <RefreshCw className="size-4 shrink-0" />
                    {result.updated} existing contacts updated
                  </div>
                )}
                {result.tagsAssigned > 0 && (
                  <div className="flex items-center gap-1.5 text-cyan-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.tagsAssigned} group/tag assignments
                  </div>
                )}
                {result.customValuesSet > 0 && (
                  <div className="flex items-center gap-1.5 text-cyan-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.customValuesSet} custom field values saved
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {result.skipped} duplicates skipped
                  </div>
                )}
                {result.invalidPhone > 0 && (
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {result.invalidPhone} unusable phone numbers
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-red-400">
                    <XCircle className="size-4 shrink-0" />
                    {t('resultFailed', { count: result.failed })}
                  </div>
                )}
              </div>

              {result.failedDetails.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-border/80 pt-3">
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    {t('failedRowsHeading')}
                  </p>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                    {result.failedDetails.map((row, i) => (
                      <li key={i} className="flex items-baseline gap-2 text-muted-foreground">
                        <span className="shrink-0 font-mono text-popover-foreground">
                          {row.name ? `${row.name} (${row.phone})` : row.phone}
                        </span>
                        <span className="truncate">{row.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={validCount === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Import {validCount} contacts
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
