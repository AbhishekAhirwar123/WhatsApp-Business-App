/**
 * Server-side validation for scheduled messages. Pure + tested; used by
 * the create/edit API routes. Times are stored in UTC; the client sends
 * an ISO instant plus the IANA zone it was chosen in (kept for display).
 */

export interface ScheduleInput {
  message_type?: unknown;
  content_text?: unknown;
  template_name?: unknown;
  template_language?: unknown;
  template_params?: unknown;
  scheduled_for?: unknown;
  timezone?: unknown;
}

export interface ValidSchedule {
  message_type: 'text' | 'template';
  content_text: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: Record<string, unknown>;
  scheduled_for: string;
  timezone: string;
}

/** Earliest allowed: a minute from now (gives the worker a tick). */
export const MIN_LEAD_MS = 60_000;
/** Latest allowed: 90 days ahead. */
export const MAX_LEAD_MS = 90 * 24 * 3600_000;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateScheduleInput(
  input: ScheduleInput,
  now: number = Date.now(),
): { ok: true; value: ValidSchedule } | { ok: false; error: string } {
  const type = input.message_type;
  if (type !== 'text' && type !== 'template') {
    return { ok: false, error: 'message_type must be "text" or "template"' };
  }

  const when = typeof input.scheduled_for === 'string' ? Date.parse(input.scheduled_for) : NaN;
  if (!Number.isFinite(when)) return { ok: false, error: 'scheduled_for must be an ISO date-time' };
  if (when < now + MIN_LEAD_MS) return { ok: false, error: 'Pick a time at least a minute in the future.' };
  if (when > now + MAX_LEAD_MS) return { ok: false, error: 'Messages can be scheduled up to 90 days ahead.' };

  const tz = typeof input.timezone === 'string' && input.timezone ? input.timezone : 'Asia/Kolkata';
  if (!isValidTimeZone(tz)) return { ok: false, error: 'Unknown time zone' };

  if (type === 'text') {
    const text = typeof input.content_text === 'string' ? input.content_text.trim() : '';
    if (!text) return { ok: false, error: 'Message text is required' };
    if (text.length > 4096) return { ok: false, error: 'Message text is limited to 4096 characters' };
    return {
      ok: true,
      value: {
        message_type: 'text',
        content_text: text,
        template_name: null,
        template_language: null,
        template_params: {},
        scheduled_for: new Date(when).toISOString(),
        timezone: tz,
      },
    };
  }

  const name = typeof input.template_name === 'string' ? input.template_name.trim() : '';
  if (!name) return { ok: false, error: 'template_name is required' };
  const params =
    input.template_params && typeof input.template_params === 'object' && !Array.isArray(input.template_params)
      ? (input.template_params as Record<string, unknown>)
      : {};
  const body = params.body;
  if (body !== undefined && (!Array.isArray(body) || body.some((v) => typeof v !== 'string' || !v.trim()))) {
    return { ok: false, error: 'Every template variable needs a value' };
  }
  return {
    ok: true,
    value: {
      message_type: 'template',
      content_text: null,
      template_name: name,
      template_language: typeof input.template_language === 'string' ? input.template_language : null,
      template_params: params,
      scheduled_for: new Date(when).toISOString(),
      timezone: tz,
    },
  };
}
