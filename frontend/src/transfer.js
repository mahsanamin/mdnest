// Pure helpers for moving, copying and downloading notes (issue #114). No
// React imports, so they are unit-tested standalone.
//
// Three things live here:
//   - the destination maths for the Move/Copy picker,
//   - the plain-language text for the server's refusals (409/413/429/403),
//   - the cross-server clipboard payload: one note as
//     {"mdnest":"file/v1","name":"x.md","content":"..."}.

export const CLIPBOARD_KIND = 'file/v1';

// The clipboard carries at most 1 MB, measured in UTF-8 BYTES of the whole
// payload — not JavaScript string length, which counts UTF-16 code units: an
// Urdu or emoji note can be well under a million characters and well over a
// million bytes.
export const CLIPBOARD_MAX_BYTES = 1024 * 1024;

export function utf8Bytes(s) {
  return new TextEncoder().encode(s).length;
}

// The note-ID marker is the note's identity on its own server. The server
// drops it on create anyway (it is the integrity boundary); removing it here
// just keeps it out of the clipboard.
const MARKER_RE = /^<!-- mdnest:[a-f0-9-]+ -->[ \t]*$/gm;

export function stripNoteMarker(content) {
  const stripped = content.replace(MARKER_RE, '');
  if (stripped === content) return content;
  return stripped.replace(/\n+$/, '\n');
}

// buildClipboardPayload returns {ok:true, text, bytes} or, when the note is
// too big for the clipboard, {ok:false, reason:'too_large', bytes}.
export function buildClipboardPayload(name, content) {
  const text = JSON.stringify({ mdnest: CLIPBOARD_KIND, name, content: stripNoteMarker(content) });
  const bytes = utf8Bytes(text);
  if (bytes > CLIPBOARD_MAX_BYTES) return { ok: false, reason: 'too_large', bytes };
  return { ok: true, text, bytes };
}

// parseClipboardPayload reads pasted text. It returns
//   {ok:true, name, content}                      a note we can create,
//   {ok:false, reason:'too_large', bytes}         over the limit (refused),
//   {ok:false, reason:'not_mdnest'}               anything else.
// The name is reduced to a safe single file name: a pasted payload is
// untrusted input, and its name must not be able to pick a folder.
export function parseClipboardPayload(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return { ok: false, reason: 'not_mdnest' };
  const bytes = utf8Bytes(text);
  if (bytes > CLIPBOARD_MAX_BYTES) return { ok: false, reason: 'too_large', bytes };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, reason: 'not_mdnest' }; }
  if (!data || data.mdnest !== CLIPBOARD_KIND || typeof data.content !== 'string') {
    return { ok: false, reason: 'not_mdnest' };
  }
  return { ok: true, name: safeFileName(data.name), content: data.content };
}

// safeFileName keeps the last path segment and drops characters no file name
// should carry, falling back to "pasted.md".
export function safeFileName(name) {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (n === '' || n === '.' || n === '..') n = 'pasted.md';
  if (n.startsWith('.')) n = n.replace(/^\.+/, '') || 'pasted.md';
  return n;
}

// suggestCopyName: "plan.md" -> "plan (copy).md", "plan (copy).md" ->
// "plan (copy 2).md", "Makefile" -> "Makefile (copy)". Only ever offered,
// never applied without the user confirming it.
export function suggestCopyName(name) {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  let stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  // .excalidraw.md keeps its double extension.
  let fullExt = ext;
  if (ext.toLowerCase() === '.md' && stem.toLowerCase().endsWith('.excalidraw')) {
    stem = stem.slice(0, -'.excalidraw'.length);
    fullExt = '.excalidraw' + ext;
  }
  const m = stem.match(/^(.*) \(copy(?: (\d+))?\)$/);
  if (m) {
    const n = m[2] ? Number(m[2]) + 1 : 2;
    return `${m[1]} (copy ${n})${fullExt}`;
  }
  return `${stem} (copy)${fullExt}`;
}

// localLinks finds the note's links that point at files on its own server
// (images, attachments, other notes by relative path). They do not travel
// with a cross-server copy, so the user is told before copying.
export function localLinks(content) {
  const out = [];
  const seen = new Set();
  const add = (href) => {
    const h = href.trim().replace(/^<|>$/g, '').split(/\s+/)[0];
    if (!h || /^(https?:|mailto:|data:|#)/i.test(h) || seen.has(h)) return;
    seen.add(h);
    out.push(h);
  };
  const md = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = md.exec(content))) add(m[1]);
  const wiki = /!\[\[([^\]|#]+)/g;
  while ((m = wiki.exec(content))) add(m[1]);
  return out;
}

// --- destinations ----------------------------------------------------------

export function baseName(path) {
  return String(path || '').split('/').filter(Boolean).pop() || '';
}

// joinPath builds a namespace-relative path from a folder ("" or "/" is the
// root, "/a/b" or "a/b" a folder) and a name.
export function joinPath(folder, name) {
  const dir = String(folder || '').replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${name}` : name;
}

// isInvalidDestination mirrors the server's 400s so the picker can hide what
// would be refused anyway: the source itself and, for a folder, anything
// inside it — only within the same namespace.
export function isInvalidDestination({ sourceNs, sourcePath, destNs, destFolder }) {
  if (sourceNs !== destNs) return false;
  const dir = String(destFolder || '').replace(/^\/+|\/+$/g, '');
  return dir === sourcePath || dir.startsWith(sourcePath + '/');
}

// --- the server's answers in plain words -----------------------------------

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

export { formatBytes };

// describeRefusal turns a transfer/download status + JSON body into a
// sentence. Returns '' for success.
export function describeRefusal(status, body = {}, { action = 'transfer' } = {}) {
  if (status >= 200 && status < 300) return '';
  const b = body || {};
  switch (status) {
    case 409:
      return `Something named "${b.path || 'that'}" already exists there. Nothing was overwritten. Pick another folder or name.`;
    case 413:
      return `Too large: ${b.files} files, ${formatBytes(b.bytes || 0)}. The limit is ${b.maxFiles} files and ${formatBytes(b.maxBytes || 0)}. Choose a smaller subfolder.`;
    case 429:
      return 'Another download is running. Try again in a few seconds.';
    case 403:
      return action === 'download'
        ? 'You do not have access to download this.'
        : 'You do not have access to one of the two places.';
    case 404:
      return 'It no longer exists. Someone may have moved or deleted it.';
    case 400:
      if (b.error === 'symlink') return `This folder contains a link (${b.path}), which cannot be moved or copied.`;
      if (b.error === 'reserved') return `This folder contains a system folder (${b.path}), which cannot be moved or copied.`;
      return b.error ? capitalize(b.error) + '.' : 'That destination is not allowed.';
    default:
      return b.error ? capitalize(b.error) + '.' : `Failed (${status}).`;
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// filenameFromDisposition reads the download name the server chose,
// preferring the RFC 5987 UTF-8 form.
export function filenameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { /* fall through */ }
  }
  const plain = header.match(/filename="([^"]*)"/i);
  return plain ? plain[1] : fallback;
}
