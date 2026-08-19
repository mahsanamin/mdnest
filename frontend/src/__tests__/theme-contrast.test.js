// Contrast floor for both themes.
//
// A light theme is easy to ship and hard to ship *readable*. The specific trap
// here was Catppuccin Latte: it is a well-designed palette, but it tunes its
// accents to sit on white as accents — icons, fills, large type. mdnest uses
// them as body text (--warning appears as `color` 8 times, as `background`
// twice). Stock Latte yellow measures 2.31:1 on the page background and green
// 2.96:1, both far under the 4.5:1 AA floor, and neither looks obviously wrong
// in a screenshot — it just quietly hurts to read at 13px.
//
// So the palette is asserted, not eyeballed. Every value in theme.css is
// resolved through its var() chain and measured.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'theme.css'),
  'utf-8',
);

const block = (selector) => {
  const m = CSS.match(
    new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\n\\}'),
  );
  const out = {};
  if (!m) return out;
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
};

const DARK = block(':root');
const LIGHT = { ...DARK, ...block(':root[data-theme="light"]') };

function resolve(tokens, name, depth = 0) {
  const v = (tokens[name] || '').trim();
  if (depth > 12) return v;
  const m = v.match(/^var\((--[\w-]+)\)$/);
  return m ? resolve(tokens, m[1], depth + 1) : v;
}

function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(tokens, fg, bg) {
  const f = resolve(tokens, fg);
  const b = resolve(tokens, bg);
  expect(f, `${fg} did not resolve to a colour`).toMatch(/^#[0-9a-f]{3,6}$/i);
  expect(b, `${bg} did not resolve to a colour`).toMatch(/^#[0-9a-f]{3,6}$/i);
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text that a person is expected to READ. WCAG AA for normal-size text.
const AA = 4.5;
const BODY_TEXT = [
  ['--text', '--bg'], ['--text', '--surface'], ['--text', '--surface-2'],
  ['--text-2', '--bg'],
  ['--text-secondary', '--bg'], ['--text-secondary', '--surface'],
];

// --text-muted is asserted separately because dark mode does not meet AA on it
// and never has: Mocha overlay0 (#6c7086) on the base measures 3.36:1. That is
// pre-existing debt, not something light mode introduced, and raising it would
// change the look of the shipped dark theme in 71 places — a design decision to
// take deliberately, not as a side effect of adding a second theme. So light is
// held to AA (it measures 4.92:1) and dark is pinned at its current level so it
// cannot silently get worse.
const MUTED = [['--text-muted', '--bg'], ['--text-muted', '--surface']];
const MUTED_FLOOR = { dark: 3.3, light: AA };

// Status hues, which mdnest uses predominantly as text rather than as fills.
const HUE_TEXT = [
  ['--accent', '--bg'], ['--danger', '--bg'], ['--success', '--bg'],
  ['--warning', '--bg'], ['--info', '--bg'], ['--purple', '--bg'],
  ['--orange', '--bg'], ['--danger-tint-text', '--danger-tint'],
];

// A label on a filled button. --text-inverse is the token that would have gone
// white-on-pale-blue if the palette had been swapped by value instead of role.
const ON_ACCENT = [
  ['--text-inverse', '--accent'], ['--text-inverse', '--danger'],
  ['--text-inverse', '--success'],
];

describe.each([['dark', DARK], ['light', LIGHT]])('%s theme', (name, tokens) => {
  it.each(BODY_TEXT)('%s on %s clears AA', (fg, bg) => {
    expect(contrast(tokens, fg, bg)).toBeGreaterThanOrEqual(AA);
  });

  it.each(MUTED)('%s on %s meets this theme\'s floor', (fg, bg) => {
    expect(contrast(tokens, fg, bg)).toBeGreaterThanOrEqual(MUTED_FLOOR[name]);
  });

  it.each(HUE_TEXT)('%s on %s clears AA', (fg, bg) => {
    expect(contrast(tokens, fg, bg)).toBeGreaterThanOrEqual(AA);
  });

  it.each(ON_ACCENT)('%s on %s clears AA', (fg, bg) => {
    expect(contrast(tokens, fg, bg)).toBeGreaterThanOrEqual(AA);
  });
});

// The dim tokens are deliberately low-contrast decoration — the build-info
// footer, disabled affordances — and dark mode has always been under AA there
// (--text-dim measures 2.46:1 on Mocha). Rather than pretend otherwise, pin
// that light mode is never WORSE than dark for the same pair. This catches a
// light-mode regression without inventing a standard the existing design does
// not meet.
describe('light mode is not a downgrade', () => {
  const EVERY_PAIR = [
    ...BODY_TEXT, ...HUE_TEXT, ...ON_ACCENT,
    ['--text-dim', '--bg'], ['--text-faintest', '--bg'],
    ['--text-faint', '--bg'], ['--text-fainter', '--bg'],
    ['--text-muted', '--surface-2'], ['--accent', '--surface-2'],
  ];

  it.each(EVERY_PAIR)('%s on %s is at least as readable as in dark mode', (fg, bg) => {
    const light = contrast(LIGHT, fg, bg);
    const dark = contrast(DARK, fg, bg);
    // A small tolerance: matching a dark palette's ratios exactly is not
    // possible, and a hair under is not a readability regression.
    expect(light).toBeGreaterThanOrEqual(Math.min(dark, AA) - 0.3);
  });
});

describe('theme completeness', () => {
  it('light mode redefines every token whose dark value is a raw colour', () => {
    // A semantic token holding a literal (rather than var(--ctp-*)) does not
    // follow a primitive swap, so light mode must restate it or it stays dark.
    // Scrims are deliberately theme-independent: the dim behind a modal is
    // black on any ground, so restating it in light mode would be noise.
    const THEME_INDEPENDENT = new Set(['--scrim', '--scrim-strong', '--scrim-solid']);
    const missing = Object.entries(DARK)
      .filter(([k, v]) => !k.startsWith('--ctp-') && /^#[0-9a-f]{3,8}$/i.test(v.trim()))
      .filter(([k]) => !THEME_INDEPENDENT.has(k))
      .filter(([k]) => !(k in block(':root[data-theme="light"]')))
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it('declares color-scheme in both themes so native controls follow', () => {
    expect(CSS).toMatch(/color-scheme:\s*dark/);
    expect(CSS).toMatch(/color-scheme:\s*light/);
  });
});
