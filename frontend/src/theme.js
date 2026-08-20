// Theme resolution. Pure functions plus two thin DOM/storage helpers, kept out
// of React so the precedence rules can be tested without mounting anything.
//
// Four inputs, in strict order of authority:
//
//   1. the user's stored preference  (/api/preferences, server-side)
//   2. the operator's default        (DEFAULT_THEME via /api/config)
//   3. "auto"                        (the fallback when neither is set)
//   4. the OS setting                (prefers-color-scheme, only under "auto")
//
// The server is the source of truth for 1 and 2; localStorage appears here in
// exactly one role — remembering the last resolved theme so the very first
// paint is not the wrong colour. It is a paint cache, never the preference.

export const THEMES = ['auto', 'dark', 'light'];
export const RESOLVED = ['dark', 'light'];

// Where the first-paint cache lives. Read by the inline boot script in
// index.html before any JavaScript bundle has loaded.
export const THEME_CACHE_KEY = 'mdnest_theme_paint';

/** True when the value is a theme a user may choose. */
export function isTheme(v) {
  return THEMES.includes(v);
}

/**
 * Resolve the theme actually to be painted.
 *
 * @param {object}  o
 * @param {string=} o.userPreference  stored per-user choice ('auto'|'dark'|'light')
 * @param {string=} o.serverDefault   DEFAULT_THEME from /api/config
 * @param {boolean} o.prefersDark     the OS reports a dark colour scheme
 * @returns {'dark'|'light'}
 */
export function resolveTheme({ userPreference, serverDefault, prefersDark } = {}) {
  // A user's explicit dark/light beats everything. 'auto' is a real choice
  // too — it means "follow my OS" and must override a server default of
  // 'dark', otherwise picking Auto in the UI would appear to do nothing.
  const chosen = isTheme(userPreference)
    ? userPreference
    : isTheme(serverDefault)
      ? serverDefault
      : 'auto';

  if (chosen === 'auto') return prefersDark ? 'dark' : 'light';
  return chosen;
}

/** Read the OS colour-scheme preference. Defaults to dark where unsupported. */
export function osPrefersDark(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || typeof win.matchMedia !== 'function') return true;
  try {
    return win.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/**
 * Paint a resolved theme onto the document.
 *
 * Sets data-theme (which theme.css keys its light block on) and the native
 * color-scheme, so form controls, scrollbars and date pickers rendered by the
 * browser follow too — those are not ours to style and look wrong otherwise.
 */
export function applyTheme(resolved, doc = typeof document !== 'undefined' ? document : undefined) {
  if (!doc?.documentElement) return;
  const theme = RESOLVED.includes(resolved) ? resolved : 'dark';
  doc.documentElement.setAttribute('data-theme', theme);
  doc.documentElement.style.colorScheme = theme;
}

/**
 * Remember the resolved theme for the next first paint.
 *
 * Without this the app boots dark, then flips once /api/preferences answers —
 * a full-page flash on every load for every light-mode user. The cache is only
 * ever a guess about what the server will say; when the answer arrives it wins.
 */
export function cacheTheme(resolved, storage = safeStorage()) {
  if (!storage || !RESOLVED.includes(resolved)) return;
  try {
    storage.setItem(THEME_CACHE_KEY, resolved);
  } catch {
    /* private mode, quota, storage disabled — the cache is optional */
  }
}

/** The last resolved theme, or null when there is nothing usable cached. */
export function readCachedTheme(storage = safeStorage()) {
  if (!storage) return null;
  try {
    const v = storage.getItem(THEME_CACHE_KEY);
    return RESOLVED.includes(v) ? v : null;
  } catch {
    return null;
  }
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** The theme currently painted on the document. */
export function currentTheme(doc = typeof document !== 'undefined' ? document : undefined) {
  const v = doc?.documentElement?.getAttribute('data-theme');
  return RESOLVED.includes(v) ? v : 'dark';
}

/**
 * Subscribe to theme changes by watching the document attribute.
 *
 * Deliberately DOM-level rather than React context: the things that have to
 * re-render on a theme change are leaf renderers holding imperative output —
 * mermaid SVG, an Excalidraw canvas — that sit far from where the theme is
 * owned. Threading a prop to each one means every component in between has to
 * know about theming to pass it along, and any that forgets breaks silently.
 * Watching the attribute keeps the coupling to one thing both sides already
 * agree on.
 *
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(cb, doc = typeof document !== 'undefined' ? document : undefined) {
  const root = doc?.documentElement;
  if (!root || typeof MutationObserver === 'undefined') return () => {};
  let last = currentTheme(doc);
  const obs = new MutationObserver(() => {
    const next = currentTheme(doc);
    if (next !== last) {
      last = next;
      cb(next);
    }
  });
  obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => obs.disconnect();
}
