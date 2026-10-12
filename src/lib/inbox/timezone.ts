/**
 * Wall-clock ↔ UTC conversion for a named IANA zone without a date
 * library. Scheduling UI shows/enters times in the account zone (default
 * Asia/Kolkata); storage is always UTC.
 */

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-10-12T15:00" in `timeZone` → ISO UTC instant. */
export function zonedLocalToUtcIso(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Two passes handle DST edges in zones that have them.
  let utc = guess - zoneOffsetMs(guess, timeZone);
  utc = guess - zoneOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

/** ISO UTC instant → "YYYY-MM-DDTHH:mm" wall time in `timeZone`. */
export function utcIsoToZonedLocal(iso: string, timeZone: string): string {
  const ms = Date.parse(iso);
  const local = new Date(ms + zoneOffsetMs(ms, timeZone));
  return local.toISOString().slice(0, 16);
}

export function formatInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
