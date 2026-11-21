import { describe, it, expect } from 'vitest';
import { splitFrontMatter, frontMatterInner, withFrontMatterInner } from '../frontMatter.js';

describe('front matter header box', () => {
  const fm = splitFrontMatter('---\ntitle: T\nmdnest-chat: true\n---\n\n# Body\n').frontMatter;

  it('shows the lines between the fences', () => {
    expect(frontMatterInner(fm)).toBe('title: T\nmdnest-chat: true');
  });

  it('gives back the same bytes when nothing changed', () => {
    expect(withFrontMatterInner(fm, frontMatterInner(fm))).toBe(fm);
    const dots = splitFrontMatter('---\na: 1\n...\nbody').frontMatter;
    expect(withFrontMatterInner(dots, frontMatterInner(dots))).toBe(dots);
  });

  it('keeps the --- fences and the blank line whatever is typed', () => {
    expect(withFrontMatterInner(fm, 'title: New')).toBe('---\ntitle: New\n---\n\n');
    expect(withFrontMatterInner(fm, '')).toBe('---\n---\n\n');
    expect(withFrontMatterInner(fm, 'a: 1\r\nb: 2')).toBe('---\na: 1\nb: 2\n---\n\n');
  });

  it('leaves text that is not front matter alone', () => {
    expect(frontMatterInner('')).toBe('');
    expect(withFrontMatterInner('', 'x')).toBe('');
  });
});
