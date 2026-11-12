// Large files. Loading and rendering a multi-megabyte note in the Live editor
// or the preview froze the tab, so the app asks before opening one and then
// shows it as plain text (Basic editor, no preview).

// Above this the app asks before opening a file.
export const LARGE_FILE_BYTES = 1024 * 1024;

// fileSizeIn returns the size the tree reports for path, or null when the
// tree does not list it (not loaded yet, or a server that sends no sizes).
export function fileSizeIn(tree, path) {
  if (!path || !Array.isArray(tree)) return null;
  const stack = [...tree];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === 'file' && n.path === path) return typeof n.size === 'number' ? n.size : null;
    if (Array.isArray(n.children)) stack.push(...n.children);
  }
  return null;
}

export function isLargeSize(bytes) {
  return typeof bytes === 'number' && bytes > LARGE_FILE_BYTES;
}

// isLargeText is the check once the text is loaded: a note opened by a link
// or from another device was never asked about, and a note can grow while open.
export function isLargeText(text) {
  return typeof text === 'string' && text.length > LARGE_FILE_BYTES;
}

export function formatSize(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// largeFileQuestion is the text of the "open anyway?" prompt.
export function largeFileQuestion(path, bytes) {
  const name = String(path || '').split('/').pop();
  return `${name} is large (${formatSize(bytes)}). Opening it can make the page slow.\n\n`
    + 'Open it anyway? It opens as plain text, without the Live editor or the preview.';
}
