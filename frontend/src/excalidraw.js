// Obsidian-compatible `.excalidraw.md` read/write. The markdown file stays the
// source of truth: the whole scene lives in a fenced ```json block under a
// "## Drawing" heading, and every text element's text is mirrored into a
// "## Text Elements" section so the drawing's words stay searchable and
// readable by tools/agents. This module is dependency-free on purpose — it is
// imported eagerly by the app, while the heavy editor loads lazily.

// isExcalidrawDoc reports whether a note path is an Excalidraw drawing.
export function isExcalidrawDoc(path) {
  if (!path) return false;
  const p = String(path).toLowerCase();
  return p.endsWith('.excalidraw.md') || p.endsWith('.excalidraw');
}

// noteRelativePath resolves a note-relative href (e.g. a drawing embed target)
// to a namespace-relative path usable with getNote — independent of the
// file-serving baseDir the <img> renderer uses. A leading slash is treated as
// the namespace root.
export function noteRelativePath(notePath, href) {
  if (!href) return '';
  if (href.startsWith('/')) return href.replace(/^\/+/, '');
  const dir = notePath && notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/') + 1) : '';
  const out = [];
  for (const seg of (dir + href).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

// Keep only the appState fields that are safe and stable to persist; the rest
// (selection, collaborators, transient UI) would churn the file on every edit.
function stableAppState(appState) {
  const a = appState || {};
  const out = {};
  if (a.viewBackgroundColor) out.viewBackgroundColor = a.viewBackgroundColor;
  if (a.gridSize != null) out.gridSize = a.gridSize;
  return out;
}

// parseExcalidraw extracts the scene ({ elements, appState, files }) from a
// note's content, or null when there is no drawing yet (a fresh file).
export function parseExcalidraw(content) {
  const text = content || '';
  let raw = null;
  const fence = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fence) raw = fence[1];
  else if (text.trim().startsWith('{')) raw = text; // a bare `.excalidraw` JSON file
  if (!raw) return null;
  try {
    const scene = JSON.parse(raw);
    if (!scene || typeof scene !== 'object') return null;
    return {
      elements: Array.isArray(scene.elements) ? scene.elements : [],
      appState: stableAppState(scene.appState),
      files: scene.files && typeof scene.files === 'object' ? scene.files : {},
    };
  } catch {
    return null;
  }
}

// serializeExcalidraw renders a scene back to the Obsidian-compatible markdown.
export function serializeExcalidraw({ elements, appState, files } = {}) {
  const els = Array.isArray(elements) ? elements : [];
  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'mdnest',
    elements: els,
    appState: stableAppState(appState),
    files: files && typeof files === 'object' ? files : {},
  };
  const textElements = els
    .filter((el) => el && el.type === 'text' && !el.isDeleted && el.text)
    .map((el) => `${el.text} ^${el.id}`)
    .join('\n\n');
  return [
    '---',
    'excalidraw-plugin: parsed',
    'tags: [excalidraw]',
    '---',
    '',
    '# Excalidraw Data',
    '',
    '## Text Elements',
    textElements,
    '',
    '## Drawing',
    '```json',
    JSON.stringify(scene, null, 2),
    '```',
    '%%',
    '',
  ].join('\n');
}
