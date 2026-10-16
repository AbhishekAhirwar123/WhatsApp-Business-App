import { describe, expect, it } from 'vitest';
import { buildMessageSearchOr, highlightParts } from './message-search';

describe('buildMessageSearchOr', () => {
  it('searches text, template name and media file name', () => {
    expect(buildMessageSearchOr('brochure')).toBe(
      'content_text.ilike."%brochure%",template_name.ilike."%brochure%",media_url.ilike."%brochure%"',
    );
  });
  it('quotes terms with filter-syntax characters and escapes wildcards', () => {
    const f = buildMessageSearchOr('2 BHK, (50%) "flat"')!;
    expect(f.startsWith('content_text.ilike."%2 BHK, (50\\\\%) \\"flat\\"%"')).toBe(true);
  });
  it('returns null for blank input', () => {
    expect(buildMessageSearchOr('   ')).toBeNull();
  });
});

describe('highlightParts', () => {
  it('splits case-insensitively and keeps original casing', () => {
    expect(highlightParts('Regal Garden visit at regal gate', 'REGAL')).toEqual([
      { text: 'Regal', match: true },
      { text: ' Garden visit at ', match: false },
      { text: 'regal', match: true },
      { text: ' gate', match: false },
    ]);
  });
});
