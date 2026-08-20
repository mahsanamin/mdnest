// Theme resolution precedence.
//
// Four inputs decide one colour, and the ordering is the whole feature. The
// cases worth pinning are the ones where a plausible implementation gets it
// backwards: 'auto' is a real user choice that must beat a server default of
// 'dark', and the localStorage entry is a paint cache that must never outrank
// the server's answer.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  resolveTheme, applyTheme, osPrefersDark, isTheme,
  cacheTheme, readCachedTheme, THEME_CACHE_KEY,
} from '../theme.js';

describe('resolveTheme', () => {
  it('a user choice beats the server default', () => {
    expect(resolveTheme({ userPreference: 'light', serverDefault: 'dark', prefersDark: true }))
      .toBe('light');
    expect(resolveTheme({ userPreference: 'dark', serverDefault: 'light', prefersDark: false }))
      .toBe('dark');
  });

  // The case a naive implementation gets wrong: treating 'auto' as "no
  // preference" and falling through to the server default. Choosing Auto in
  // the UI would then appear to do nothing on a server configured dark.
  it('a user choice of auto beats the server default and follows the OS', () => {
    expect(resolveTheme({ userPreference: 'auto', serverDefault: 'dark', prefersDark: false }))
      .toBe('light');
    expect(resolveTheme({ userPreference: 'auto', serverDefault: 'light', prefersDark: true }))
      .toBe('dark');
  });

  it('falls back to the server default when the user has no preference', () => {
    expect(resolveTheme({ serverDefault: 'light', prefersDark: true })).toBe('light');
    expect(resolveTheme({ serverDefault: 'dark', prefersDark: false })).toBe('dark');
  });

  it('follows the OS when neither is set', () => {
    expect(resolveTheme({ prefersDark: true })).toBe('dark');
    expect(resolveTheme({ prefersDark: false })).toBe('light');
  });

  it('ignores values that are not themes', () => {
    // A stale preference, a typo in DEFAULT_THEME, or a hand-edited store
    // must degrade to the next input rather than paint something undefined.
    expect(resolveTheme({ userPreference: 'purple', serverDefault: 'light', prefersDark: true }))
      .toBe('light');
    expect(resolveTheme({ userPreference: null, serverDefault: 'nonsense', prefersDark: false }))
      .toBe('light');
  });

  it('always resolves to a paintable theme', () => {
    expect(['dark', 'light']).toContain(resolveTheme());
  });
});

describe('isTheme', () => {
  it('accepts the three choices and nothing else', () => {
    for (const t of ['auto', 'dark', 'light']) expect(isTheme(t)).toBe(true);
    for (const t of ['Dark', '', null, undefined, 'system']) expect(isTheme(t)).toBe(false);
  });
});

describe('osPrefersDark', () => {
  it('reads the media query', () => {
    const win = (matches) => ({ matchMedia: (q) => ({ matches: q.includes('dark') && matches }) });
    expect(osPrefersDark(win(true))).toBe(true);
    expect(osPrefersDark(win(false))).toBe(false);
  });

  it('defaults to dark where matchMedia is unavailable or throws', () => {
    expect(osPrefersDark({})).toBe(true);
    expect(osPrefersDark(undefined)).toBe(true);
    expect(osPrefersDark({ matchMedia() { throw new Error('nope'); } })).toBe(true);
  });
});

describe('applyTheme', () => {
  const fakeDoc = () => ({ documentElement: { style: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; } } });

  it('sets data-theme and the native color-scheme', () => {
    const doc = fakeDoc();
    applyTheme('light', doc);
    expect(doc.documentElement.attrs['data-theme']).toBe('light');
    // Without color-scheme the browser keeps painting scrollbars, date
    // pickers and form controls for the other theme.
    expect(doc.documentElement.style.colorScheme).toBe('light');
  });

  it('falls back to dark for an unpaintable value', () => {
    const doc = fakeDoc();
    applyTheme('auto', doc);
    expect(doc.documentElement.attrs['data-theme']).toBe('dark');
  });

  it('is a no-op without a document', () => {
    expect(() => applyTheme('light', undefined)).not.toThrow();
  });
});

describe('the paint cache', () => {
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  };

  it('round-trips a resolved theme', () => {
    const s = store();
    cacheTheme('light', s);
    expect(s.getItem(THEME_CACHE_KEY)).toBe('light');
    expect(readCachedTheme(s)).toBe('light');
  });

  it('stores only resolved themes, never auto', () => {
    // The cache answers "what colour was the screen last time", which 'auto'
    // is not an answer to.
    const s = store();
    cacheTheme('auto', s);
    expect(readCachedTheme(s)).toBeNull();
  });

  it('ignores junk already in storage', () => {
    const s = store();
    s.setItem(THEME_CACHE_KEY, 'chartreuse');
    expect(readCachedTheme(s)).toBeNull();
  });

  it('survives storage being unavailable', () => {
    // Private mode and disabled storage throw on access rather than
    // returning null, which would otherwise take the whole app down on boot.
    const hostile = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(() => cacheTheme('dark', hostile)).not.toThrow();
    expect(readCachedTheme(hostile)).toBeNull();
    expect(readCachedTheme(null)).toBeNull();
  });
});

// The inline boot script in index.html duplicates the cache key, because it
// runs before any bundle and cannot import from theme.js. That duplication is
// the point of failure: rename THEME_CACHE_KEY and the boot script keeps
// reading the old entry, so every load flashes the wrong theme — and nothing
// errors, so nobody notices until someone complains about a flicker.
describe('the boot script in index.html', () => {
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'),
    'utf-8',
  );

  it('reads the same storage key theme.js writes', () => {
    expect(html).toContain(`localStorage.getItem('${THEME_CACHE_KEY}')`);
  });

  it('sets both data-theme and color-scheme, like applyTheme', () => {
    expect(html).toMatch(/setAttribute\('data-theme'/);
    expect(html).toMatch(/colorScheme\s*=/);
  });

  it('runs before the module bundle', () => {
    // If it loaded after the app script the flash it exists to prevent would
    // still happen.
    expect(html.indexOf('mdnest_theme_paint')).toBeLessThan(html.indexOf('src="/src/main.jsx"'));
  });

  it('cannot leave the page unthemed if storage throws', () => {
    expect(html).toMatch(/catch[\s\S]{0,120}setAttribute\('data-theme'/);
  });
});
