// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeHtml, sanitizeSvg } from '../sanitize.js';

describe('sanitizeHtml', () => {
  it('strips inline event handlers from images (stored XSS via <img onerror>)', () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(document.cookie)">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/alert/);
  });

  it('drops javascript: link hrefs', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it('removes <script> tags', () => {
    const out = sanitizeHtml('before<script>alert(1)</script>after');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('preserves data-mermaid so the Preview mermaid post-pass still works', () => {
    const out = sanitizeHtml('<div class="mermaid-source" data-mermaid="graph%20TD"></div>');
    expect(out).toContain('data-mermaid="graph%20TD"');
    expect(out).toContain('mermaid-source');
  });

  it('preserves task-list checkboxes', () => {
    const out = sanitizeHtml('<li><input type="checkbox" checked disabled> done</li>');
    expect(out).toMatch(/<input[^>]*type="checkbox"/i);
  });

  it('keeps external links and forces rel=noopener on target=_blank', () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_blank">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
  });
});

describe('sanitizeSvg', () => {
  it('returns empty string for falsy input', () => {
    expect(sanitizeSvg('')).toBe('');
    expect(sanitizeSvg(null)).toBe('');
  });

  it('strips event handlers smuggled into SVG', () => {
    const out = sanitizeSvg('<svg><rect onload="alert(1)" width="10" height="10"/></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).toContain('<svg');
  });
});
