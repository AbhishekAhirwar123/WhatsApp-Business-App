/**
 * In-conversation message search helpers (pure, tested).
 *
 * The query runs as the user under RLS and is pinned to one conversation
 * id, so a search can never reach another team's or tenant's messages.
 */

/** Escape LIKE wildcards so "50%" matches literally. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * PostgREST `or=(...)` filter matching message text, template name and
 * media file name. Values are double-quoted (escaping `"` and `\`) so
 * commas / parentheses in the search term can't break the filter syntax.
 */
export function buildMessageSearchOr(term: string): string | null {
  const t = term.trim();
  if (!t) return null;
  const pattern = `%${escapeLikeTerm(t)}%`.replace(/["\\]/g, (m) => `\\${m}`);
  const q = `"${pattern}"`;
  return [`content_text.ilike.${q}`, `template_name.ilike.${q}`, `media_url.ilike.${q}`].join(',');
}

/**
 * Split text into plain / matched segments for highlighting. Rendered as
 * React text nodes (never innerHTML), so message content can't inject markup.
 */
export function highlightParts(text: string, term: string): { text: string; match: boolean }[] {
  const t = term.trim();
  if (!t || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = t.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const j = lower.indexOf(needle, i);
    if (j === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (j > i) out.push({ text: text.slice(i, j), match: false });
    out.push({ text: text.slice(j, j + needle.length), match: true });
    i = j + needle.length;
  }
  return out;
}

/** Default search window shown in the drawer (not a retention limit). */
export const DEFAULT_SEARCH_DAYS = 90;
