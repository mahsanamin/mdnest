import { describe, it, expect } from 'vitest';
import { isMarpDoc } from '../marp.js';

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
