import { fixDoubledCountryCode, normalizePhone } from '@/lib/whatsapp/phone-utils';

export interface PhoneRepairCandidate {
  id: string;
  name: string | null;
  phone: string;
  /** Corrected number in `+<digits>` form. */
  fixedPhone: string;
  /**
   * Id of another contact that already has the corrected number. Fixing
   * this one would collide with the unique (account_id, phone_normalized)
   * index, so it's left for the user to merge or delete instead.
   */
  conflictWithId: string | null;
}

/**
 * Contacts whose number has the country code typed twice
 * ("+91 91 98765 43210"), with the corrected number for each. Pure: the
 * caller passes every contact in the account so conflicts can be found.
 */
export function findPhoneRepairs(
  contacts: { id: string; name?: string | null; phone: string | null }[],
): PhoneRepairCandidate[] {
  const idByDigits = new Map<string, string>();
  for (const c of contacts) {
    const digits = normalizePhone(c.phone ?? '');
    if (digits) idByDigits.set(digits, c.id);
  }

  const out: PhoneRepairCandidate[] = [];
  for (const c of contacts) {
    if (!c.phone) continue;
    const fixed = fixDoubledCountryCode(c.phone);
    if (!fixed) continue;
    const other = idByDigits.get(fixed);
    out.push({
      id: c.id,
      name: c.name ?? null,
      phone: c.phone,
      fixedPhone: `+${fixed}`,
      conflictWithId: other && other !== c.id ? other : null,
    });
  }
  return out;
}
