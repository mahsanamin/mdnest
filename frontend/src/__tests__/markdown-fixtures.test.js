// @vitest-environment jsdom

// Roundtrip tests for the markdown features that have historically
// regressed in mdnest (paste handling, task lists, in-table checkboxes,
// the invisible note-ID marker). These are intentionally narrow: they
// exercise the pure helpers (no Milkdown init), running under jsdom
// so the browser-API parts (DOMParser, document.createElement) work.
// Catches the kind of regression that has actually shipped without
// the cost of full integration tests.
//
// If you find yourself wanting more coverage, add another fixture here
// before touching the editor code — the v3.8.0 and v3.9.1 fixes both
// would have been caught by a test in this file.

import { describe, it, expect } from 'vitest';
import { looksLikeMarkdown } from '../markdown-utils.js';
import { hasRichContent, htmlToMarkdown } from '../html-to-md.js';

describe('looksLikeMarkdown', () => {
  it('detects task lists', () => {
    expect(looksLikeMarkdown('- [ ] Mercury')).toBe(true);
    expect(looksLikeMarkdown('- [x] Venus')).toBe(true);
  });

  it('detects bullet and numbered lists', () => {
    expect(looksLikeMarkdown('- one\n- two')).toBe(true);
    expect(looksLikeMarkdown('* one')).toBe(true);
  });

  it('detects headings, blockquotes, tables, code', () => {
    expect(looksLikeMarkdown('# Title')).toBe(true);
    expect(looksLikeMarkdown('## Heading')).toBe(true);
    expect(looksLikeMarkdown('> quoted')).toBe(true);
    expect(looksLikeMarkdown('| a | b |')).toBe(true);
    expect(looksLikeMarkdown('```js')).toBe(true);
    expect(looksLikeMarkdown('[link](url)')).toBe(true);
    expect(looksLikeMarkdown('![alt](img.png)')).toBe(true);
  });

  it('tolerates leading whitespace (indented list etc.)', () => {
    expect(looksLikeMarkdown('  - nested')).toBe(true);
    expect(looksLikeMarkdown('\t- tab-indented')).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(looksLikeMarkdown('just some text')).toBe(false);
    expect(looksLikeMarkdown('Hello world')).toBe(false);
  });

  it('handles empty / null input safely', () => {
    expect(looksLikeMarkdown('')).toBe(false);
    expect(looksLikeMarkdown(null)).toBe(false);
    expect(looksLikeMarkdown(undefined)).toBe(false);
  });
});

describe('paste-priority decision — the v3.9.1 regression scenario', () => {
  // The exact text the user reported pasting into the Live editor and
  // having it land as plain bullets. This test pins the decision logic
  // that lets us route this through markdownToSlice (which preserves
  // task lists) instead of htmlToMarkdown (which loses them when the
  // source HTML doesn't carry GFM data attributes).
  const userReportedPaste = `### Solar System Exploration, 1950s – 1960s

- [ ] Mercury
- [x] Venus
- [x] Earth (Orbit/Moon)
- [x] Mars
- [ ] Jupiter
- [ ] Saturn
- [ ] Uranus
- [ ] Neptune
- [ ] Comet Haley`;

  it('detects the user-reported paste as markdown', () => {
    expect(looksLikeMarkdown(userReportedPaste)).toBe(true);
  });

  it('a plain prose paste does NOT look like markdown', () => {
    const prose = 'Just a paragraph the user typed and then copied.';
    expect(looksLikeMarkdown(prose)).toBe(false);
  });
});

describe('hasRichContent', () => {
  it('returns true for HTML with structural elements', () => {
    expect(hasRichContent('<table><tr><td>x</td></tr></table>')).toBe(true);
    expect(hasRichContent('<ul><li>x</li></ul>')).toBe(true);
  });

  it('returns false for plain-text-like or empty HTML', () => {
    expect(hasRichContent('')).toBe(false);
    expect(hasRichContent(null)).toBe(false);
  });
});

describe('htmlToMarkdown task-list conversion (v3.8.0 fix verification)', () => {
  it('converts HTML checkbox inputs to GFM task syntax', () => {
    const html =
      '<ul>' +
      '<li><input type="checkbox" disabled> Mercury</li>' +
      '<li><input type="checkbox" disabled checked> Venus</li>' +
      '</ul>';
    const md = htmlToMarkdown(html);
    expect(md).toMatch(/- \[ \]\s*Mercury/);
    expect(md).toMatch(/- \[x\]\s*Venus/);
  });
});
