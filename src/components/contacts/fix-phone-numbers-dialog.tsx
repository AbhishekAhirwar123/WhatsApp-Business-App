'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { PhoneRepairCandidate } from '@/lib/contacts/phone-repair';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

interface FixPhoneNumbersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: PhoneRepairCandidate[];
  /** Called after numbers were changed, so the page can refetch. */
  onFixed: () => void;
}

/**
 * Review-then-apply repair for numbers saved with the country code twice
 * ("+91 91 98765 43210"), which WhatsApp rejects as undeliverable
 * (#131026). Nothing changes until the user confirms. Runs as the signed-in
 * user, so it needs no database access beyond the CRM itself.
 */
export function FixPhoneNumbersDialog({
  open,
  onOpenChange,
  candidates,
  onFixed,
}: FixPhoneNumbersDialogProps) {
  const supabase = createClient();
  const fixable = useMemo(
    () => candidates.filter((c) => !c.conflictWithId),
    [candidates],
  );
  const conflicts = candidates.length - fixable.length;

  // Ids the user has un-ticked; everything fixable is ticked by default.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const chosen = fixable.filter((c) => !excluded.has(c.id));

  function toggle(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    setSaving(true);
    let fixed = 0;
    const failures: string[] = [];
    // Small parallel batches — one UPDATE per contact (each has its own
    // new number), without flooding the API.
    for (let i = 0; i < chosen.length; i += 10) {
      const batch = chosen.slice(i, i + 10);
      const results = await Promise.all(
        batch.map((c) =>
          supabase
            .from('contacts')
            .update({ phone: c.fixedPhone, updated_at: new Date().toISOString() })
            .eq('id', c.id),
        ),
      );
      results.forEach(({ error }, j) => {
        if (error) failures.push(`${batch[j].name || batch[j].phone}: ${error.message}`);
        else fixed++;
      });
    }
    setSaving(false);

    if (fixed > 0) toast.success(`${fixed} phone number${fixed === 1 ? '' : 's'} fixed`);
    if (failures.length > 0) {
      toast.error(`${failures.length} could not be fixed: ${failures.slice(0, 2).join('; ')}`);
    }
    setExcluded(new Set());
    onFixed();
    if (failures.length === 0) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="flex max-h-[min(88vh,720px)] flex-col border-border bg-popover text-popover-foreground sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fix phone numbers</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            These numbers have the country code typed twice (for example
            +91 91 98765 43210). WhatsApp can&apos;t deliver to them, so
            broadcasts fail with error 131026. Review and confirm to correct
            them; nothing changes until you click Fix.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="w-8 px-3 py-2">
                  <Checkbox
                    checked={chosen.length === fixable.length && fixable.length > 0}
                    indeterminate={chosen.length > 0 && chosen.length < fixable.length}
                    onCheckedChange={() =>
                      setExcluded(
                        chosen.length === fixable.length
                          ? new Set(fixable.map((c) => c.id))
                          : new Set(),
                      )
                    }
                    aria-label="Select all"
                  />
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Contact</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  Current → corrected
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {candidates.map((c) => (
                <tr key={c.id} className={c.conflictWithId ? 'opacity-60' : undefined}>
                  <td className="px-3 py-2">
                    {!c.conflictWithId && (
                      <Checkbox
                        checked={!excluded.has(c.id)}
                        onCheckedChange={() => toggle(c.id)}
                        aria-label={`Fix ${c.name || c.phone}`}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 text-foreground">{c.name || 'Unnamed'}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex flex-wrap items-center gap-1.5 font-mono">
                      <span className="text-red-400 line-through">{c.phone}</span>
                      <ArrowRight className="size-3 text-muted-foreground" />
                      <span className="text-primary">{c.fixedPhone}</span>
                    </span>
                    {c.conflictWithId && (
                      <p className="mt-0.5 text-[11px] text-amber-500">
                        Another contact already has this number — skipped.
                        Delete whichever copy you don&apos;t need.
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {conflicts > 0 && (
          <p className="text-xs text-amber-500">
            {conflicts} contact{conflicts === 1 ? '' : 's'} can&apos;t be fixed
            automatically because the corrected number already exists.
          </p>
        )}

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="border-border text-muted-foreground"
          >
            Cancel
          </Button>
          <Button
            onClick={apply}
            disabled={saving || chosen.length === 0}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            Fix {chosen.length} number{chosen.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
