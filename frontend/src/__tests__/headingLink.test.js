import { describe, it, expect } from 'vitest';
import { parseRoute, formatRoute } from '../hashRoute.js';
import { headingUrl, headingWikilink } from '../headingLink.js';

describe('heading links', () => {
  it('a note route can carry a heading, and round-trips', () => {
    const hash = formatRoute({ ns: 'work', path: 'Docs/Plan #2.md', heading: 'Next steps & risks' });
    // the "#" in the file name is encoded, so the first raw "#" starts the heading
    expect(hash).toBe('#work/Docs/Plan%20%232.md#Next%20steps%20%26%20risks');
    const r = parseRoute(hash);
    expect(r).toMatchObject({ ns: 'work', path: 'Docs/Plan #2.md', heading: 'Next steps & risks', board: false });
  });
  it('a note route without a heading is unchanged', () => {
    expect(formatRoute({ ns: 'work', path: 'a.md' })).toBe('#work/a.md');
    expect(parseRoute('#work/a.md').heading).toBeUndefined();
    expect(parseRoute('#work/a.md#').heading).toBeUndefined();
    expect(parseRoute('#work#Heading').heading).toBeUndefined(); // no note, no heading
  });
  it('a malformed escape does not throw', () => {
    expect(parseRoute('#work/a.md#100%').heading).toBe('100%');
  });
  it('the copied URL opens the note at the heading', () => {
    expect(headingUrl('https://notes.example.com/', 'work', 'a.md', 'Setup')).toBe('https://notes.example.com/#work/a.md#Setup');
  });
  it('the wikilink drops .md and refuses characters that would break it', () => {
    expect(headingWikilink('Docs/Plan.md', 'Next steps')).toBe('[[Docs/Plan#Next steps]]');
    expect(headingWikilink('a.md', 'x | y')).toBeNull();
    expect(headingWikilink('a.md', 'see [1]')).toBeNull();
  });
});
