import { describe, it, expect } from 'vitest';
import { isMarpDoc, slideStarts, effectiveEditorMode } from '../marp.js';

describe('isMarpDoc', () => {
  it('detects a leading frontmatter with marp: true', () => {
    expect(isMarpDoc('---\nmarp: true\n---\n\n# Slide')).toBe(true);
  });

  it('tolerates extra frontmatter keys and spacing', () => {
    expect(isMarpDoc('---\ntheme: gaia\nmarp:   true \npaginate: true\n---\nhi')).toBe(true);
  });

  it('is case-insensitive on the key', () => {
    expect(isMarpDoc('---\nMarp: true\n---\nhi')).toBe(true);
  });

  it('rejects marp: false', () => {
    expect(isMarpDoc('---\nmarp: false\n---\nhi')).toBe(false);
  });

  it('rejects a note with no frontmatter', () => {
    expect(isMarpDoc('# Just a note\n\nmarp: true is only in the body')).toBe(false);
  });

  it('rejects marp: true that is not in the leading frontmatter', () => {
    expect(isMarpDoc('# Title\n\n---\nmarp: true\n---\n')).toBe(false);
  });

  it('handles non-string input', () => {
    expect(isMarpDoc(null)).toBe(false);
    expect(isMarpDoc(undefined)).toBe(false);
  });
});

describe('effectiveEditorMode', () => {
  it('forces Basic for a Marp deck regardless of preference', () => {
    expect(effectiveEditorMode('live', true)).toBe('basic');
    expect(effectiveEditorMode('basic', true)).toBe('basic');
  });

  it('keeps the chosen mode for non-Marp notes', () => {
    expect(effectiveEditorMode('live', false)).toBe('live');
    expect(effectiveEditorMode('basic', false)).toBe('basic');
  });
});

describe('slideStarts', () => {
  it('skips the leading YAML frontmatter and anchors the first slide after it', () => {
    const src = ['---', 'marp: true', '---', '', '# One', '', '---', '', '# Two'].join('\n');
    expect(slideStarts(src).starts).toEqual([3, 7]);
  });

  it('skips a large frontmatter (style block) so the first slide starts after the close', () => {
    const fm = ['---', 'marp: true', 'style: |', '  section { color: red }', '  h1 { font-size: 2em }', '---'];
    const body = ['', '# First real slide', '', '---', '', '# Second'];
    const { starts } = slideStarts([...fm, ...body].join('\n'));
    // Frontmatter is 6 lines (0..5); first slide starts at line 6, the next
    // slide after the `---` on line 9.
    expect(starts).toEqual([6, 10]);
  });

  it('does not treat a setext H2 underline as a slide break', () => {
    const src = ['---', 'marp: true', '---', '', 'My Title', '---', '', '# Real slide'].join('\n');
    // The `---` under "My Title" is a setext heading, not a page break.
    expect(slideStarts(src).starts).toEqual([3]);
  });

  it('ignores --- inside fenced code blocks', () => {
    const src = ['---', 'marp: true', '---', '', '```', '---', '```', '', 'body'].join('\n');
    expect(slideStarts(src).starts).toEqual([3]);
  });

  it('works without frontmatter', () => {
    const src = ['# A', '', '---', '', '# B'].join('\n');
    expect(slideStarts(src).starts).toEqual([0, 3]);
  });

  it('reports the total line count', () => {
    expect(slideStarts('a\nb\nc').totalLines).toBe(3);
    expect(slideStarts('').totalLines).toBe(1);
    expect(slideStarts(null).totalLines).toBe(1);
  });
});
