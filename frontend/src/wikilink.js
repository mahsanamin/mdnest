// Obsidian-style wikilink support: [[target]], [[target|alias]],
// [[target#heading]], [[#heading]].
//
// Pure module on purpose: no React, no component imports, so everything
// here is unit-testable without mounting anything (see
// __tests__/wikilink.test.js). Preview.jsx wires the marked extension and
// the click handling; LiveEditorCrepe.jsx uses the parser/resolver for
// Ctrl/Cmd+Click and restoreWikilinks() to keep [[...]] byte-stable
// through Milkdown's serializer.

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Split the inner text of [[...]] into its parts.
//   [[page]]                -> { page, heading: '', alias: '', display: page }
//   [[page|alias]]          -> alias wins as display
//   [[page#heading]]        -> heading split off the target
//   [[#heading]]            -> empty page means "this note"
export function parseWikiLink(inner) {
  const raw = String(inner || '');
  const pipe = raw.indexOf('|');
  const target = (pipe === -1 ? raw : raw.slice(0, pipe)).trim();
  const alias = pipe === -1 ? '' : raw.slice(pipe + 1).trim();
  const hash = target.indexOf('#');
  const page = (hash === -1 ? target : target.slice(0, hash)).trim();
  const heading = hash === -1 ? '' : target.slice(hash + 1).trim();
  const display = alias || target || raw.trim();
  return { page, heading, alias, display };
}

// Flatten the namespace tree (as returned by GET /api/tree, nodes are
// { name, path, type: 'folder'|'directory'|'file', children }) into a
// lookup index for resolveWikiLink. Only .md files are indexed: wikilinks
// point at notes.
export function buildPathIndex(tree) {
  const paths = new Set();
  const byLowerPath = new Map();
  const byBasename = new Map();
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node) continue;
      if (node.type === 'folder' || node.type === 'directory') {
        walk(node.children);
        continue;
      }
      const path = node.path || node.name;
      if (!path || !/\.md$/i.test(path)) continue;
      paths.add(path);
      byLowerPath.set(path.toLowerCase(), path);
      const base = path.split('/').pop().toLowerCase();
      const bare = base.replace(/\.md$/i, '');
      for (const key of base === bare ? [base] : [base, bare]) {
        if (!byBasename.has(key)) byBasename.set(key, []);
        byBasename.get(key).push(path);
      }
    }
  };
  walk(Array.isArray(tree) ? tree : tree && tree.children);
  return { paths, byLowerPath, byBasename };
}

// Resolve a wikilink page to a note path within the current namespace.
//   - empty page ([[#heading]]) -> the current note
//   - page with '/'             -> path match, with and without .md,
//                                  exact first then case-insensitive
//   - bare name                 -> case-insensitive basename lookup,
//                                  ambiguity broken by shortest path
//                                  (Obsidian-like)
// Returns the resolved path or null when the target does not exist.
export function resolveWikiLink(page, index, currentPath) {
  const target = String(page || '').trim().replace(/^\//, '');
  if (!target) return currentPath || null;
  if (!index) return null;
  if (target.includes('/')) {
    for (const cand of [target, target + '.md']) {
      if (index.paths.has(cand)) return cand;
      const ci = index.byLowerPath.get(cand.toLowerCase());
      if (ci) return ci;
    }
    return null;
  }
  const matches = index.byBasename.get(target.toLowerCase());
  if (!matches || matches.length === 0) return null;
  let best = matches[0];
  for (const m of matches) {
    if (m.length < best.length || (m.length === best.length && m < best)) best = m;
  }
  return best;
}

// Build an href matching App.jsx's setHash() format (#ns/path/to/note.md)
// so middle-click / open-in-new-tab lands on the right note. Primary
// navigation is the in-app click handler; this is the fallback.
export function buildHashHref(ns, path) {
  if (!ns || !path) return '#';
  return '#' + encodeURIComponent(ns) + '/' + path.split('/').map(encodeURIComponent).join('/');
}

// Matches [[...]] with a non-empty inner that contains no brackets and no
// newline. Anchored: the tokenizer is only called at candidate positions.
const WIKILINK_TOKEN_RE = /^\[\[([^[\]\n]+)\]\]/;

function wikilinkAnchorHtml(path, heading, display, ns, titleAttr) {
  const headingAttr = heading ? ` data-heading="${escapeHtml(heading)}"` : '';
  return `<a class="wikilink" href="${escapeHtml(buildHashHref(ns, path))}" data-path="${escapeHtml(path)}"${headingAttr}${titleAttr || ''}>${display}</a>`;
}

// marked inline extension. `resolve(page)` maps a wikilink target to a
// note path (or null). Registered in Preview.jsx via inst.use(...), which
// MERGES with the defaults (a per-call renderer option would replace them,
// see the marked v15 notes in Preview.jsx).
export function wikiLinkExtension({ resolve, ns }) {
  return {
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start(src) {
          const idx = src.indexOf('[[');
          return idx === -1 ? undefined : idx;
        },
        tokenizer(src) {
          const m = WIKILINK_TOKEN_RE.exec(src);
          if (!m) return undefined;
          const parsed = parseWikiLink(m[1]);
          return { type: 'wikilink', raw: m[0], ...parsed };
        },
        renderer(token) {
          const path = resolve ? resolve(token.page) : null;
          const display = escapeHtml(token.display);
          if (!path) {
            const title = escapeHtml(`Note not found: ${token.page || token.display}`);
            return `<span class="wikilink wikilink-broken" title="${title}">${display}</span>`;
          }
          return wikilinkAnchorHtml(path, token.heading, display, ns);
        },
      },
    ],
  };
}

// Detect a relative markdown link to a .md file ([x](other.md),
// [y](../dir/note.md#Heading)) and resolve it against the directory of
// the current note. Returns { path, heading } or null when the href is
// external / absolute / not a .md file. '..' above the namespace root is
// clamped at the root.
export function resolveRelativeMdHref(href, currentPath) {
  if (!href) return null;
  if (/^(https?:|mailto:|data:|blob:|#|\/)/i.test(href)) return null;
  let decoded = href;
  try {
    decoded = decodeURI(href);
  } catch {
    /* keep raw href */
  }
  const hashIdx = decoded.indexOf('#');
  const pathPart = hashIdx === -1 ? decoded : decoded.slice(0, hashIdx);
  const heading = hashIdx === -1 ? '' : decoded.slice(hashIdx + 1);
  if (!/\.md$/i.test(pathPart)) return null;
  const segs = currentPath ? currentPath.split('/').slice(0, -1) : [];
  for (const seg of pathPart.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (segs.length) segs.pop();
      continue;
    }
    segs.push(seg);
  }
  const path = segs.join('/');
  return path ? { path, heading } : null;
}

// Render a relative .md link as an internal wikilink-style anchor.
// Returns the anchor HTML, or null when the href is not an internal
// note link (caller falls back to its external-link rendering). `text`
// is already-rendered inline HTML from marked, so it is not re-escaped.
export function internalMdLinkHtml({ href, title, text }, ns, currentPath) {
  const resolved = resolveRelativeMdHref(href, currentPath);
  if (!resolved) return null;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return wikilinkAnchorHtml(resolved.path, resolved.heading, text, ns, titleAttr);
}

// Milkdown's serializer (remark-stringify) escapes markdown punctuation in
// plain text, turning [[Note]] into \[\[Note]] and [[my_note]] into
// \[\[my\_note]] on every Live-editor save. Undo exactly that for wikilink
// spans so documents containing [[...]] round-trip byte-identical: restore
// the brackets and unescape backslash-escaped ASCII punctuation inside the
// matched span only. Text outside wikilinks is left untouched.
const ESCAPED_WIKILINK_RE = /\\\[\\\[([^[\]\n]+?)\]\]/g;

export function restoreWikilinks(markdown) {
  if (!markdown || markdown.indexOf('\\[\\[') === -1) return markdown;
  return markdown.replace(
    ESCAPED_WIKILINK_RE,
    (_m, inner) => '[[' + inner.replace(/\\([!-/:-@[-`{-~])/g, '$1') + ']]'
  );
}
