import { describe, expect, it } from 'vitest';
import { utcIsoToZonedLocal, zonedLocalToUtcIso } from './timezone';

describe('zone conversion', () => {
  it('treats the picked wall time as Asia/Kolkata (UTC+05:30)', () => {
    expect(zonedLocalToUtcIso('2026-10-12T15:00', 'Asia/Kolkata')).toBe('2026-10-12T09:30:00.000Z');
    expect(utcIsoToZonedLocal('2026-10-12T09:30:00.000Z', 'Asia/Kolkata')).toBe('2026-10-12T15:00');
  });

  it('handles zones with DST', () => {
    // New York is UTC-4 in October.
    expect(zonedLocalToUtcIso('2026-10-12T09:00', 'America/New_York')).toBe('2026-10-12T13:00:00.000Z');
    expect(zonedLocalToUtcIso('2026-12-12T09:00', 'America/New_York')).toBe('2026-12-12T14:00:00.000Z');
  });

  it('rejects malformed input', () => {
    expect(zonedLocalToUtcIso('12/10/2026 3pm', 'Asia/Kolkata')).toBeNull();
  });
});
