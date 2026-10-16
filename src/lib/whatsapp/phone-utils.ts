/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate a *stored or inbound* phone number is E.164-like: 8–15 digits
 * starting with a non-zero digit, optional + prefix.
 *
 * This is the check for digit strings we already hold — a contact row,
 * Meta's `wa_id`, a broadcast recipient — so it accepts the digits-only
 * form Meta uses. It cannot tell a national number from an international
 * one ("4155551212" is a US number to the person who typed it and a Swiss
 * one to Meta), which is why numbers entered by a person or an integrator
 * must go through `parseInternationalPhone` instead (issue #586).
 *
 * The floor is 8 digits, not E.164's theoretical 7: a country code plus the
 * shortest national numbering plans in real use is 8+, and 7 admitted most
 * national formats. (Only a handful of tiny territories — Niue, Tokelau,
 * Saint Helena — have 7-digit international numbers.)
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{7,14}$/.test(phone)
}

/**
 * Parse a phone number as typed by a person or sent by an API integrator.
 *
 * Requires the international `+` prefix so the country code is explicit,
 * then returns the digits-only form Meta wants — or null. Formatting noise
 * (spaces, dots, dashes, parentheses) between the digits is tolerated:
 * "+1 (415) 555-1212" → "14155551212".
 *
 * Without the `+` requirement a national-format number passes `isValidE164`
 * and is delivered to whichever country its leading digits happen to spell:
 * "4155551212" (US, national) is sent as +41 55 555 12 12 (Switzerland),
 * Meta accepts it, and the send looks successful (issue #586). Making the
 * `+` load-bearing at every boundary where raw input enters is what the
 * error messages ("E.164 format, e.g. +14155550123") already promised.
 */
export function parseInternationalPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const compact = raw.trim().replace(/[\s().-]/g, '')
  if (!compact.startsWith('+')) return null
  const digits = compact.slice(1)
  if (!/^\d+$/.test(digits)) return null
  return isValidE164(digits) ? digits : null
}

/**
 * National significant-number length for country codes where a doubled
 * prefix is common in hand-typed data ("+91" picked, then "919174824860"
 * pasted → "+91 91 9174824860"). Only fixed-length plans are listed, so
 * `cc + cc + national` can never be a real number for these codes.
 */
const NATIONAL_LENGTH_BY_CC: Record<string, number> = {
  '1': 10, // US / Canada (area codes never start with 1)
  '91': 10, // India
  '92': 10, // Pakistan
  '880': 10, // Bangladesh
  '971': 9, // UAE
  '966': 9, // Saudi Arabia
  '65': 8, // Singapore
  '61': 9, // Australia
}

/**
 * Detect a country code that was typed twice and return the corrected
 * digits-only number, or null when the number looks fine.
 * e.g. "91919174824860" → "919174824860".
 */
export function fixDoubledCountryCode(digits: string): string | null {
  const d = normalizePhone(digits)
  for (const [cc, nationalLen] of Object.entries(NATIONAL_LENGTH_BY_CC)) {
    if (d.length === cc.length * 2 + nationalLen && d.startsWith(cc + cc)) {
      return d.slice(cc.length)
    }
  }
  return null
}

/**
 * Turn a phone cell from a spreadsheet into E.164 (`+<digits>`), using
 * `defaultCountryCode` (e.g. "91" or "+91") for numbers written without
 * one. Returns null when nothing usable can be produced.
 *
 *   "+91 98765 43210"  → "+919876543210"   (already international)
 *   "0091 9876543210"  → "+919876543210"   (00 international prefix)
 *   "09876543210"      → "+919876543210"   (trunk 0 dropped, cc added)
 *   "9876543210"       → "+919876543210"   (cc added)
 *   "919876543210"     → "+919876543210"   (cc already present)
 *   "+91919876543210"  → "+919876543210"   (doubled cc repaired)
 *
 * Spreadsheets often turn numbers into "9.19876E+11" or "919876543210.0";
 * the latter is handled, the former has lost digits and is rejected.
 */
export function toInternationalPhone(
  raw: string | null | undefined,
  defaultCountryCode?: string | null,
): string | null {
  if (!raw) return null
  // Drop an Excel float suffix ("919876543210.0") before stripping dots,
  // or the trailing 0 would become part of the number.
  const compact = raw
    .trim()
    .replace(/\.0+$/, '')
    .replace(/[\s().\-/]/g, '')
  if (/e\+?\d+$/i.test(compact)) return null

  let digits: string
  if (compact.startsWith('+')) {
    digits = compact.slice(1)
  } else if (compact.startsWith('00')) {
    digits = compact.slice(2)
  } else {
    const cc = (defaultCountryCode ?? '').replace(/\D/g, '')
    const national = compact.replace(/^0+/, '')
    if (!/^\d+$/.test(national)) return null
    if (!cc) return null
    const expected = NATIONAL_LENGTH_BY_CC[cc]
    const alreadyHasCc = expected
      ? national.length === cc.length + expected && national.startsWith(cc)
      : national.startsWith(cc) && national.length >= cc.length + 8
    digits = alreadyHasCc ? national : cc + national
  }

  if (!/^\d+$/.test(digits)) return null
  digits = fixDoubledCountryCode(digits) ?? digits
  return isValidE164(digits) ? `+${digits}` : null
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}
