import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import { listChats, getChat, postChatMessage, convertToChat, listChatGifs, getToken, fetchPreferencesStrict, savePreferences, getChatMembers, addChatMember, removeChatMember, getNamespaceUsers, saveChatAgentRole } from '../api.js';
import { resolveImgSrc } from '../img-src.js';
import { sanitizeHtml } from '../sanitize.js';
import {
  CHAT_POLL_MS, CHAT_LIST_POLL_MS, DEFAULT_CHAT_FOLDER, chatPathFor, colorForAuthor,
  isOwnMessage, groupMessages, mergeMessages, workingLine, contextLabel, contextTitle, CONTEXT_HIGH, formatChatTime, agentInstructions, plainPreview,
  highlightMentions, mentionsName, participants, mentionQuery, completeMention,
  avatarFor, reactions, gifMarkdown, expandGifRefs, initialOf,
  pinKey, parsePins, togglePin, chatsForTab, MAX_CHAT_PINS_LENGTH,
  roleFor,
} from '../chat.js';
import { copyPlainText } from '../mermaid-text.js';
import { mdnestUri } from '../mdnestUri.js';
import { CHAT_ROLES, applyRole } from '../chatRoles.js';
import { chatMenuGroups } from '../contextMenuItems.js';
import ContextMenu from './ContextMenu.jsx';
import './ChatView.css';
import { NO_GRAMMAR_ASSIST } from '../noGrammarAssist.js';

// The chats view: every chat channel on the left, the open conversation on
// the right. A chat is just a note (`mdnest-chat: true`), so everything shown
// here is also readable — and appendable — as that note, by people and agents.
//
// Updates are polled rather than pushed: live-collab is off by default and
// multi-mode only, and a chat has to work on every install.

const md = new Marked({ gfm: true, breaks: true });
// @mentions are wrapped in a span before rendering (highlightMentions skips
// code); sanitizeHtml keeps the span's class and data-mention by design.
// Images are namespace-relative (![nod](ChatGifs/nod.svg)), resolved with the
// same rule as Preview (img-src.js): relative paths go through /api/files
// with the session token, and absolute URLs pass through so the token never
// reaches a foreign host.
const fileBase = (ns) => `/api/files/${encodeURIComponent(ns)}/`;
const fileUrl = (ns, p) => resolveImgSrc(p, fileBase(ns), getToken());
// A listed image's URL: built-ins come from their own public route (an
// absolute path, which resolveImgSrc leaves alone, so no token is attached).
const gifUrl = (ns, g) => (g.scope === 'builtin' ? g.path : fileUrl(ns, g.path));
function renderMessage(text, ns, gifs) {
  const withGifs = expandGifRefs(text || '', gifs, (g) => gifUrl(ns, g));
  const html = sanitizeHtml(md.parse(highlightMentions(withGifs)));
  if (!ns || !html.includes('<img')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('img').forEach((img) => {
    img.setAttribute('src', fileUrl(ns, img.getAttribute('src') || ''));
    img.setAttribute('loading', 'lazy');
  });
  return tpl.innerHTML;
}

// Rendered message HTML. React 19 compares dangerouslySetInnerHTML by object
// identity, so a plain div rewrote every message's innerHTML whenever the list
// re-rendered, even with the same text. That recreated each image, which
// reloaded, collapsed and pushed the last message out of view on every poll.
// memo on the string keeps the DOM untouched unless the HTML really changed.
const Html = memo(function Html({ className, html }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

// Keep the current value when a poll returns the same thing, so state that
// feeds the message list does not change identity (and rebuild it) every 3s.
const sameOr = (next) => (cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next);

const AS_KEY = 'mdnest_chat_as';
const seenKey = (ns, path) => `mdnest_chat_seen:${ns}/${path}`;

function readSeen(ns, path) {
  try { return parseInt(localStorage.getItem(seenKey(ns, path)) || '0', 10) || 0; } catch { return 0; }
}
function writeSeen(ns, path, n) {
  try { localStorage.setItem(seenKey(ns, path), String(n)); } catch { /* storage blocked: unread badges just stay */ }
}

function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

function NewChatForm({ ns, canPrivate, onCreated, onCancel }) {
  const [title, setTitle] = useState('');
  // Private by default where it exists (multi mode): a new chat is for the
  // people you invite, not everyone who can read the workspace.
  const [isPrivate, setIsPrivate] = useState(true);
  const [folder, setFolder] = useState(DEFAULT_CHAT_FOLDER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = chatPathFor(title, folder);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !ns) return;
    setBusy(true);
    setError('');
    try {
      await convertToChat(ns, path, title.trim(), canPrivate && isPrivate);
      onCreated({ ns, path });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="chat-new" onSubmit={submit}>
      <input
        autoFocus
        className="chat-input"
        placeholder="Channel name, e.g. Release coordination"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={60}
      />
      <div className="chat-new-row">
        <input
          className="chat-input"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          aria-label="Folder"
          placeholder="Folder"
        />
      </div>
      <div className="chat-new-path" title="The note this chat is stored in">{ns}/{path}</div>
      {canPrivate && (
        <label className="chat-new-private">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} data-testid="chat-new-private" />
          Only people I invite
        </label>
      )}
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-new-row">
        <button type="button" className="chat-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="chat-btn chat-btn-primary" disabled={busy || !title.trim() || !ns}>
          {busy ? 'Creating…' : 'Create chat'}
        </button>
      </div>
    </form>
  );
}

const PinIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" />
  </svg>
);

// Pinned | All. Pinned shows only the chats you pinned, in pin order.
function ChatTabs({ tab, onTab, pinnedCount, allCount }) {
  return (
    <div className="chat-tabs" role="tablist">
      {[['pinned', `Pinned${pinnedCount ? ` ${pinnedCount}` : ''}`], ['all', `All ${allCount}`]].map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} className={`chat-tab${tab === id ? ' active' : ''}`}
          onClick={() => onTab(id)} data-testid={`chat-tab-${id}`}>{label}</button>
      ))}
    </div>
  );
}

function ChatList({ chats, loading, error, openChat, onSelect, filter, onFilter, onMenu, pins, onTogglePin, tab }) {
  const f = filter.trim().toLowerCase();
  const inTab = chatsForTab(chats, pins || [], tab);
  const shown = f
    ? inTab.filter((c) => `${c.title} ${c.path}`.toLowerCase().includes(f))
    : inTab;
  if (error) return <div className="chat-empty chat-error">{error}</div>;
  return (
    <>
      {inTab.length > 6 && (
        <input className="chat-input chat-filter" placeholder="Filter chats" value={filter} onChange={(e) => onFilter(e.target.value)} />
      )}
      <ul className="chat-list-items">
        {shown.map((c) => {
          const active = openChat && openChat.ns === c.ns && openChat.path === c.path;
          const unread = active ? 0 : Math.max(0, c.count - readSeen(c.ns, c.path));
          const pinned = !!pins && pins.includes(pinKey(c.ns, c.path));
          return (
            <li key={`${c.ns}/${c.path}`} className={`chat-list-row${pinned ? ' pinned' : ''}`}>
              {/* A sibling of the row's button, not inside it: a button
                  cannot hold another button. Hidden until hover, except on a
                  pinned chat, where it shows the pin is on. */}
              {pins && (
                <button
                  className={`chat-pin${pinned ? ' on' : ''}`}
                  onClick={() => onTogglePin(c)}
                  title={pinned ? 'Unpin' : 'Pin to the Pinned tab'}
                  aria-label={pinned ? `Unpin ${c.title}` : `Pin ${c.title}`}
                  aria-pressed={pinned}
                  data-testid="chat-pin"
                ><PinIcon /></button>
              )}
              <button
                className={`chat-list-item${active ? ' active' : ''}`}
                onClick={() => onSelect({ ns: c.ns, path: c.path })}
                onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e.clientX, e.clientY, c); } : undefined}
              >
                <span className="chat-list-top">
                  <span className="chat-list-title">
                    {c.private && <span className="chat-list-lock" title="Private: only invited people can open it" aria-label="Private"><LockIcon /></span>}
                    {c.title}
                  </span>
                  {c.lastTime && <span className="chat-list-time">{formatChatTime(c.lastTime)}</span>}
                </span>
                <span className="chat-list-bottom">
                  <span className="chat-list-preview">
                    {c.lastText ? <><b>{c.lastAuthor}:</b> {plainPreview(c.lastText)}</> : <i>No messages yet</i>}
                  </span>
                  {unread > 0 && <span className="chat-unread" aria-label={`${unread} unread`}>{unread}</span>}
                </span>
                <span className="chat-list-path">{c.path}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {!loading && !error && chats.length > 0 && tab === 'pinned' && inTab.length === 0 && (
        <div className="chat-empty">
          Nothing pinned yet. Hover a chat in <b>All</b> and click the pin to keep it here.
        </div>
      )}
      {!loading && chats.length === 0 && (
        <div className="chat-empty">
          No chats in this workspace yet. Create one with <b>+ New</b>, or right-click a folder and choose <b>New chat</b>.
        </div>
      )}
    </>
  );
}

const LockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

// Who can read and post in this chat. An open chat is readable by everyone
// with access to the workspace; inviting someone (or "Make private") limits it
// to the people listed. Any member can add or remove anyone, and the server
// refuses removing the last one. The list itself is enforced on the server for
// every way of reaching the note, not just this view.
function ChatMembers({ chat, account, onClose, onChanged }) {
  const [state, setState] = useState(null); // { private, members }
  const [users, setUsers] = useState([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setState(null);
    setError('');
    getChatMembers(chat.ns, chat.path)
      .then((s) => { if (alive) setState(s); })
      .catch((e) => { if (alive) setError(e.message); });
    getNamespaceUsers(chat.ns)
      .then((u) => { if (alive) setUsers(u || []); })
      .catch(() => { if (alive) setUsers([]); });
    return () => { alive = false; };
  }, [chat.ns, chat.path]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      setState(next);
      setPick('');
      onChanged?.(next);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const memberIds = new Set((state?.members || []).map((m) => m.id));
  const candidates = users.filter((u) => !memberIds.has(u.id) && u.username !== account);

  return (
    <div className="chat-agent chat-members" data-testid="chat-members">
      <div className="chat-agent-head">
        <strong>{state?.private ? 'Private chat' : 'Members'}</strong>
        <button className="chat-btn chat-btn-icon chat-agent-close" onClick={onClose} title="Close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      {!state && !error && <p>Loading…</p>}
      {state && !state.private && (
        <p>
          Everyone with access to <b>{chat.ns}</b> can read and post here. A workspace admin can make
          it private, and then only the people listed can open it. Anyone can create a new private
          chat with <b>+ New</b>.
        </p>
      )}
      {state && state.private && (
        <>
          <p>Only these people can open this chat. Anyone you add can read the whole history.</p>
          <ul className="chat-members-list">
            {state.members.map((m) => (
              <li key={m.id}>
                <span>{m.username}{m.username === account ? ' (you)' : ''}</span>
                <button
                  className="chat-btn chat-btn-icon"
                  disabled={busy || state.members.length === 1}
                  onClick={() => run(() => removeChatMember(chat.ns, chat.path, m.id))}
                  title={state.members.length === 1 ? 'The last member cannot be removed' : (m.username === account ? 'Leave this chat' : `Remove ${m.username}`)}
                  aria-label={m.username === account ? 'Leave this chat' : `Remove ${m.username}`}
                  data-testid="chat-member-remove"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
              </li>
            ))}
          </ul>
          <p className="chat-members-note">
            Membership limits who can open the chat here. A copy of the notes in a connected git
            remote is not covered by it.
          </p>
        </>
      )}
      {state && (
        <div className="chat-new-row">
          <select className="chat-input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Person to invite" data-testid="chat-member-pick">
            <option value="">{candidates.length ? 'Invite someone…' : 'Nobody else to invite'}</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
          <button className="chat-btn chat-btn-primary" disabled={busy || !pick}
            onClick={() => run(() => addChatMember(chat.ns, chat.path, Number(pick)))} data-testid="chat-member-add">
            Add
          </button>
          {!state.private && (
            <button className="chat-btn" disabled={busy} onClick={() => run(() => addChatMember(chat.ns, chat.path))} data-testid="chat-make-private">
              Make private
            </button>
          )}
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
    </div>
  );
}

// A popup over the chat view. Members and Connect an agent open in one, from
// the chat's header or from a right-click on the chat in the list, so neither
// pushes the conversation down. Esc or a click outside closes it.
function ChatDialog({ label, wide, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="chat-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`chat-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

// How an agent joins a chat: a name, what it should do here, and the prompt to
// paste into it. It reads the saved roles itself, so it also works for a chat
// opened from the list's right-click menu without opening it first.
function ChatAgentPanel({ chat, serverAlias, onClose }) {
  const [agents, setAgents] = useState({}); // each agent's saved role, by name (kept in the note)
  const [agentName, setAgentName] = useState('');
  const [agentIntent, setAgentIntent] = useState('');
  const [agentRole, setAgentRole] = useState(''); // a CHAT_ROLES id, or '' for none
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const loadAgents = useCallback(() => getChat(chat.ns, chat.path, Number.MAX_SAFE_INTEGER)
    .then((r) => setAgents(r.agents || {}))
    .catch((e) => setError(e.message)), [chat.ns, chat.path]);
  useEffect(() => { loadAgents(); }, [loadAgents]);
  const saveRole = (name, role) => {
    saveChatAgentRole(chat.ns, chat.path, name, role).then(loadAgents).catch((e) => setError(e.message));
  };
  const prompt = agentInstructions(serverAlias, chat.ns, chat.path, agentName || 'AGENT_NAME', agentIntent);

  return (
    <div className="chat-agent" data-testid="chat-agent">
      <div className="chat-agent-head">
        <strong>Connect an agent</strong>
        <button className="chat-btn chat-btn-icon chat-agent-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p className="chat-agent-sub">
        To <b>{chat.title || chat.path}</b>. Paste the prompt into the agent. Give it one name and it uses that name
        everywhere, so <code>@name</code> reaches it.
      </p>
      {Object.keys(agents).length > 0 && (
        <div className="chat-agent-saved" data-testid="chat-agent-saved">
          <div className="chat-agent-saved-head">Saved roles. Each agent is reminded of its role while it waits.</div>
          {Object.entries(agents).map(([name, role]) => (
            <div key={name} className="chat-agent-saved-row">
              <strong style={{ color: `var(${colorForAuthor(name)})` }}>{name}</strong>
              <span className="chat-agent-saved-role">{role}</span>
              <button type="button" className="chat-btn chat-btn-icon" onClick={() => saveRole(name, '')}
                title={`Remove ${name}'s role`} aria-label={`Remove ${name}'s role`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-agent-step">1. Pick a role, or skip it</div>
      {/* Role templates: a suggested name and a one-line trait, both still
          editable below. Leads start helpers who join this same chat. */}
      <div className="chat-agent-roles" role="radiogroup" aria-label="Role">
        {CHAT_ROLES.map((r) => (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={agentRole === r.id}
            className={`chat-role${agentRole === r.id ? ' active' : ''}`}
            title={r.trait}
            onClick={() => {
              const nextId = agentRole === r.id ? '' : r.id;
              const next = applyRole({ name: agentName, intent: agentIntent, prevRoleId: agentRole }, nextId);
              setAgentName(next.name);
              setAgentIntent(next.intent);
              setAgentRole(nextId);
            }}
          >{r.label}</button>
        ))}
      </div>
      <div className="chat-agent-step">2. Name it and say what it should do</div>
      <input
        className="chat-input chat-agent-name"
        placeholder="Agent name, e.g. codxu"
        value={agentName}
        onChange={(e) => setAgentName(e.target.value.replace(/[^\w.-]/g, ''))}
        maxLength={40}
        aria-label="Agent name"
      />
      {/* What the agent is for, in the person's own words. It goes into the
          prompt after the name, so the agent starts with its job instead of
          asking for one. */}
      <textarea
        {...NO_GRAMMAR_ASSIST}
        className="chat-input chat-agent-intent"
        placeholder="What should this agent do here? e.g. Review the API pull requests and flag anything touching auth. (optional)"
        value={agentIntent}
        onChange={(e) => setAgentIntent(e.target.value)}
        maxLength={2000}
        rows={3}
        aria-label="What this agent should do"
      />
      <p className="chat-agent-hint">This is saved as the agent's role in the chat when you copy the prompt. Keep it to a line or two: it is repeated to the agent every time new messages arrive.</p>
      <div className="chat-agent-step">3. Copy the prompt into the agent</div>
      <pre>{prompt}</pre>
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-agent-foot">
        <span className="chat-agent-mcp">MCP clients: <code>read_chat</code>, <code>post_chat</code>, <code>wait_chat</code>.</span>
        <button
          className="chat-btn chat-btn-primary"
          onClick={() => {
            if (copyPlainText(prompt)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
            // The job typed here is also saved as the agent's role, so the
            // server can keep reminding it after its context fills up.
            if (agentName && agentIntent.trim()) saveRole(agentName, agentIntent);
          }}
        >{copied ? 'Copied!' : 'Copy prompt'}</button>
      </div>
    </div>
  );
}

function ChatRoom({ chat, account, serverAlias, onOpenNote, onDeleteChat, onBack, onActivity, onDialog }) {
  const [doc, setDoc] = useState(null); // { title, description, you }
  const [working, setWorking] = useState([]); // who said they are busy, from the server
  const [contexts, setContexts] = useState({}); // each agent's last /context report, by name
  const [agents, setAgents] = useState({}); // each agent's saved role, by name (kept in the note)
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [postingAs, setPostingAs] = useState(() => {
    try { return localStorage.getItem(AS_KEY) || ''; } catch { return ''; }
  });
  const [caret, setCaret] = useState(0);
  const draftRef = useRef(null);
  // The draft grows with its content, wrapped lines included, up to a cap
  // (then it scrolls). Measured from scrollHeight after each change.
  useLayoutEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.max(120, Math.round(window.innerHeight * 0.4));
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft]);
  const [gifs, setGifs] = useState([]);
  const [showGifs, setShowGifs] = useState(false);
  const scrollRef = useRef(null);
  // The view jumps to the bottom only when the chat opens and when you send.
  // Messages from others never move it: they raise a "N new messages" pill
  // instead, and you scroll yourself (or click it).
  const followNext = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const shownRef = useRef(new Set()); // message numbers already on screen
  const countRef = useRef(0);
  const visible = useVisible();

  const effectiveAs = postingAs.trim() || doc?.you || account || '';

  const [reloadNonce, setReloadNonce] = useState(0);
  const [reloading, setReloading] = useState(false);

  // Load from scratch when the chat changes, or on Refresh. Refresh re-reads
  // the WHOLE note rather than "after N", so it also picks up a message that
  // was edited or removed by hand in the editor, which polling never sees.
  useEffect(() => {
    let cancelled = false;
    if (reloadNonce === 0) {
      setDoc(null);
      setMessages([]);
    }
    setError('');
    countRef.current = 0;
    followNext.current = true;
    setUnseen(0);
    getChat(chat.ns, chat.path, 0)
      .then((r) => {
        if (cancelled) return;
        setDoc({ title: r.title, description: r.description, you: r.you });
        setMessages(r.messages || []);
        setWorking(r.working || []);
        setContexts(r.contexts || {});
        setAgents(r.agents || {});
        countRef.current = r.count;
        writeSeen(chat.ns, chat.path, r.count);
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setReloading(false); });
    return () => { cancelled = true; };
  }, [chat.ns, chat.path, reloadNonce]);

  useEffect(() => {
    let cancelled = false;
    listChatGifs(chat.ns).then((g) => { if (!cancelled) setGifs(g); }).catch(() => {});
    return () => { cancelled = true; };
  }, [chat.ns, reloadNonce]);

  const poll = useCallback(async () => {
    try {
      const r = await getChat(chat.ns, chat.path, countRef.current);
      if (r.messages?.length) {
        // Your own post comes back once more from the next poll (it starts
        // from the old count); it is already on screen, so it is not new.
        const fresh = r.messages.filter((m) => !shownRef.current.has(m.n)).length;
        if (fresh) setUnseen((u) => u + fresh);
        setMessages((cur) => mergeMessages(cur, r.messages));
        onActivity?.();
      }
      countRef.current = Math.max(countRef.current, r.count);
      writeSeen(chat.ns, chat.path, countRef.current);
      setWorking(sameOr(r.working || []));
      setContexts(sameOr(r.contexts || {}));
      setAgents(sameOr(r.agents || {}));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [chat.ns, chat.path, onActivity]);

  useEffect(() => {
    if (!doc || !visible) return undefined;
    const id = setInterval(poll, CHAT_POLL_MS);
    return () => clearInterval(id);
  }, [doc, visible, poll]);

  const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  useEffect(() => {
    shownRef.current = new Set(messages.map((m) => m.n));
    const el = scrollRef.current;
    if (!el) return;
    if (followNext.current && messages.length) {
      el.scrollTop = el.scrollHeight;
      followNext.current = false;
      setUnseen(0);
    } else if (el.scrollHeight <= el.clientHeight) {
      setUnseen(0); // everything fits: nothing is out of sight
    }
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el && atBottom(el)) setUnseen(0);
  };

  const showNew = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setUnseen(0);
  };

  const send = async (override) => {
    const text = (typeof override === 'string' ? override : draft).trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await postChatMessage(chat.ns, chat.path, text, postingAs.trim());
      if (typeof override !== 'string') setDraft('');
      followNext.current = true;
      setMessages((cur) => mergeMessages(cur, [r.message]));
      // Anything posted by others in between is fetched by the next poll,
      // which still starts from the old count.
      onActivity?.();
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if ((e.key === 'Tab' || e.key === 'Enter') && suggestions.length && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      applySuggestion(suggestions[0]);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const savePostingAs = (v) => {
    setPostingAs(v);
    try { localStorage.setItem(AS_KEY, v); } catch { /* ignore */ }
  };

  const grouped = useMemo(() => groupMessages(messages), [messages]);
  // A /context report is today's figure, so it sits only on each author's
  // most recent group, not on every old message.
  const latestGroupOf = useMemo(() => {
    const out = {};
    for (const m of grouped) if (m.startsGroup) out[m.author] = m.n;
    return out;
  }, [grouped]);
  // The conversation, built only when the messages (or who "you" are) change.
  // Rendering it on every keystroke ran marked + DOMPurify over every message
  // in the chat, which made typing lag (~66ms a key with 300 messages).
  const messageList = useMemo(() => (
    <>
        {doc?.description && <Html className="chat-description" html={renderMessage(doc.description, chat.ns, gifs)} />}
        {!doc && !error && <div className="chat-empty">Loading…</div>}
        {doc && messages.length === 0 && <div className="chat-empty">No messages yet — say hello.</div>}
        {grouped.map((m) => {
          const own = isOwnMessage(m, account, effectiveAs);
          const forMe = !own && mentionsName(m.text, effectiveAs);
          return (
            <div key={m.n} className={`chat-msg${own ? ' own' : ''}${forMe ? ' mentions-me' : ''}${m.startsGroup ? ' first' : ''}`}>
              {m.startsGroup && (
                <div className="chat-msg-meta">
                  {(() => {
                    // Everyone gets a thumbnail: their avatar if they set one,
                    // else their initial in their name colour.
                    const av = avatarFor(gifs, m.author);
                    return av
                      ? <img className="chat-avatar" src={gifUrl(chat.ns, av)} alt="" loading="lazy" />
                      : <span className="chat-avatar chat-avatar-initial" style={{ background: `var(${colorForAuthor(m.author)})` }} aria-hidden="true">{initialOf(m.author)}</span>;
                  })()}
                  <span className="chat-msg-author" style={{ color: `var(${colorForAuthor(m.author)})` }}
                    title={roleFor(agents, m.author) ? `Role: ${roleFor(agents, m.author)}` : undefined}>{m.author}</span>
                  {m.via && <span className="chat-msg-via">via {m.via}</span>}
                  {latestGroupOf[m.author] === m.n && contextLabel(contexts[m.author]) && (
                    <span className={`chat-context${contexts[m.author].pct >= CONTEXT_HIGH ? ' high' : ''}`}
                      title={contextTitle(contexts[m.author])} data-testid="chat-context">
                      {contextLabel(contexts[m.author])}
                    </span>
                  )}
                  <span className="chat-msg-time" title={m.time}>{formatChatTime(m.time)}</span>
                </div>
              )}
              <Html className="chat-bubble" html={renderMessage(m.text, chat.ns, gifs)} />
            </div>
          );
        })}
    </>
  ), [doc, error, messages.length, grouped, gifs, chat.ns, account, effectiveAs, contexts, latestGroupOf, agents]);
  // @-completion: while the word at the caret starts with @, offer the
  // people in this chat (plus @all), most recent first.
  const query = mentionQuery(draft, caret);
  const suggestions = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return [...participants(messages), 'all']
      .filter((n) => n && n !== effectiveAs && n.toLowerCase().startsWith(q))
      .slice(0, 6);
  }, [query, messages, effectiveAs]);
  const applySuggestion = (name) => {
    const r = completeMention(draft, caret, name);
    setDraft(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => {
      const el = draftRef.current;
      if (el) { el.focus(); el.setSelectionRange(r.caret, r.caret); }
    });
  };

  return (
    <section className="chat-room">
      <header className="chat-room-header">
        {onBack && <button className="chat-btn chat-back" onClick={onBack} aria-label="Back to chats">‹</button>}
        <div className="chat-room-title">
          <h2>{doc?.title || chat.path}</h2>
          <button className="chat-room-path" onClick={() => onOpenNote(chat.ns, chat.path)} title="Open the note behind this chat">
            {chat.ns}/{chat.path}
          </button>
        </div>
        {account && onDialog && (
          <button className="chat-btn" onClick={() => onDialog('members')}
            title="Who can open this chat" data-testid="chat-members-toggle">
            Members
          </button>
        )}
        {onDialog && (
          <button className="chat-btn" onClick={() => onDialog('agent')} title="How an agent joins this chat">
            <span className="chat-label-long">Connect an agent</span>
            <span className="chat-label-short">Agents</span>
          </button>
        )}
        <button
          className={`chat-btn chat-btn-icon chat-refresh${reloading ? ' spinning' : ''}`}
          onClick={() => { setReloading(true); setReloadNonce((n) => n + 1); onActivity?.(); }}
          disabled={reloading}
          title="Refresh this chat"
          aria-label="Refresh this chat"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
        </button>
        {onDeleteChat && (
          <button
            className="chat-btn chat-btn-icon chat-delete"
            onClick={async () => {
              try { await onDeleteChat(chat.ns, chat.path, doc?.title); } catch (e) { setError(e.message); }
            }}
            title="Delete this chat"
            aria-label="Delete this chat"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>
        )}
      </header>

      <div className="chat-messages-wrap">
        <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
          {messageList}
        </div>
        {unseen > 0 && (
          <button className="chat-new-pill" onClick={showNew} data-testid="chat-new-pill">
            {unseen} new message{unseen === 1 ? '' : 's'} ↓
          </button>
        )}
      </div>

      {error && (
        <div className="chat-error chat-room-error">
          {/* The server says only "access denied", for a private chat and a
              missing grant alike, so it does not reveal which one it is. */}
          {error === 'access denied'
            ? 'You cannot open this chat. It may be private: ask someone in it to add you.'
            : error}
        </div>
      )}

      {showGifs && (
        <div className="chat-gifs" role="listbox" aria-label="React with an image">
          {reactions(gifs).length === 0 ? (
            <span className="chat-gifs-empty">
              No images available. Add some to {chat.ns}/ChatGifs, or ask an agent to make one
              (see Connect an agent).
            </span>
          ) : reactions(gifs).map((g) => (
            <button
              key={g.path}
              className="chat-gif"
              title={g.scope === 'workspace' ? `${g.name} (this workspace)` : g.name}
              onClick={() => { setShowGifs(false); send(gifMarkdown(g)); }}
            >
              <img src={gifUrl(chat.ns, g)} alt={g.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="chat-suggest" role="listbox" aria-label="Mention someone">
          {suggestions.map((n, i) => (
            <button
              key={n}
              role="option"
              aria-selected={i === 0}
              className={`chat-suggest-item${i === 0 ? ' first' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); applySuggestion(n); }}
            >@{n}</button>
          ))}
          <span className="chat-suggest-hint">Tab to complete</span>
        </div>
      )}
      {/* Who is busy, on one quiet line. It is always there (empty when
          nobody is working) so the conversation above never jumps when an
          agent starts or finishes. */}
      {(() => {
        const line = workingLine(working, account, effectiveAs);
        return (
          <div className="chat-working" role="status" aria-live="polite" title={line?.title || ''} data-testid="chat-working">
            {line && <>
              {line.busy
                ? <span className="chat-working-dots" aria-hidden="true"><i /><i /><i /></span>
                : <span className="chat-listening-dot" aria-hidden="true" />}
              <span className="chat-working-text">{line.text}</span>
            </>}
          </div>
        );
      })()}
      {/* Slack-style: one roomy box. The text area spans the full width and
          grows with what you type (wrapped lines too, not only Shift+Enter
          ones); the posting name and the buttons sit in a bar inside it. The
          old composer was a one-row input squeezed between them, so a long
          message scrolled out of sight while you were writing it. */}
      <div className="chat-composer">
        <div className="chat-compose-box">
          <textarea
            {...NO_GRAMMAR_ASSIST}
            ref={draftRef}
            className="chat-draft"
            rows={2}
            placeholder={doc?.title ? `Message ${doc.title}` : 'Message'}
            title="Enter to send, Shift+Enter for a new line"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); }}
            onSelect={(e) => setCaret(e.target.selectionStart)}
            onKeyDown={onKeyDown}
            disabled={!doc}
            aria-label="Message"
          />
          <div className="chat-compose-bar">
            <label className="chat-as">
              <span>as</span>
              <input
                className="chat-input"
                value={postingAs}
                placeholder={doc?.you || account || 'me'}
                onChange={(e) => savePostingAs(e.target.value)}
                maxLength={60}
                aria-label="Posting as"
              />
            </label>
            <button
              className={`chat-btn chat-gif-toggle${showGifs ? ' active' : ''}`}
              onClick={() => setShowGifs((v) => !v)}
              disabled={!doc}
              title="React with an image from ChatGifs"
              aria-label="React with an image"
            >GIF</button>
            <span className="chat-compose-hint">Enter to send · Shift+Enter for a new line</span>
            <button className="chat-btn chat-btn-primary chat-send" onClick={send} disabled={!doc || sending || !draft.trim()}>
              Send
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

// The chat list is per workspace, and in chat mode the file tree (which holds
// the sidebar's workspace switcher) is hidden, so the header carries its own.
function NsPicker({ ns, namespaces, onSelectNs }) {
  if (!onSelectNs || !namespaces || namespaces.length < 2) return <span className="chat-list-ns">{ns}</span>;
  return (
    <select className="chat-ns-select" value={ns || ''} onChange={(e) => onSelectNs(e.target.value)} aria-label="Workspace">
      {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}

function ChatView({ ns, namespaces, onSelectNs, account, serverAlias, isMobile, openChat, onSelectChat, onOpenNote, onDeleteChat, onClose }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState(null); // {x, y, chat} while the right-click menu is open
  const [dialog, setDialog] = useState(null); // {kind: 'members' | 'agent', chat} while a popup is open
  const closeDialog = useCallback(() => setDialog(null), []);
  const [filter, setFilter] = useState('');
  const visible = useVisible();
  // Per-browser view choices; failing storage just means the defaults.
  const stored = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };
  const [collapsed, setCollapsed] = useState(() => stored('mdnest_chat_list_collapsed', '') === '1');
  const [tab, setTab] = useState(() => stored('mdnest_chat_tab', 'all'));
  const chooseTab = (t) => { setTab(t); store('mdnest_chat_tab', t); };
  const toggleCollapsed = () => setCollapsed((c) => { store('mdnest_chat_list_collapsed', c ? '' : '1'); return !c; });

  // Pinned chats follow the person (the chat_pins preference). The list is
  // saved WHOLE, so nothing is saved until a read has succeeded: a failed
  // read is not "no pins", and saving over it would drop the real ones.
  // null = not loaded (pin buttons hidden).
  const [pins, setPins] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchPreferencesStrict()
      .then((p) => { if (!cancelled) setPins(parsePins(p?.chat_pins)); })
      .catch(() => { if (!cancelled) setPins(null); });
    return () => { cancelled = true; };
  }, []);
  const togglePinFor = (c) => {
    if (!pins) return;
    const next = togglePin(pins, pinKey(c.ns, c.path));
    const value = JSON.stringify(next);
    if (value.length > MAX_CHAT_PINS_LENGTH) { alert('Too many pinned chats. Unpin some first.'); return; }
    const before = pins;
    setPins(next);
    savePreferences({ chat_pins: value }).catch(() => { setPins(before); alert('Could not save your pins. Try again.'); });
  };

  // Scoped to the workspace you are in, like the rest of the sidebar. A chat
  // in another workspace is still reachable by its link (#!chats/ns/path).
  // A response for a workspace you have since switched away from is dropped,
  // or a slow A list could land under B's heading.
  const nsRef = useRef(ns);
  nsRef.current = ns;
  const refresh = useCallback(async () => {
    if (!ns) { setChats([]); setLoading(false); return; }
    try {
      const list = await listChats(ns);
      if (nsRef.current !== ns) return;
      setChats(list);
      setError('');
    } catch (e) {
      if (nsRef.current === ns) setError(e.message);
    } finally {
      if (nsRef.current === ns) setLoading(false);
    }
  }, [ns]);

  useEffect(() => { setLoading(true); setChats([]); refresh(); }, [refresh]);
  useEffect(() => {
    if (!visible) return undefined;
    const id = setInterval(refresh, CHAT_LIST_POLL_MS);
    return () => clearInterval(id);
  }, [visible, refresh]);

  const showList = !isMobile || !openChat;
  const showRoom = !!openChat;
  const narrow = collapsed && !isMobile;
  const pinnedHere = chatsForTab(chats, pins || [], 'pinned');
  const railChats = tab === 'pinned' && pinnedHere.length ? pinnedHere : chats;

  return (
    <div className="chat-panel">
      {showList && narrow && (
        // Collapsed: a slim strip with the way back out and one initial per
        // chat (the Pinned tab's chats when you are on it), unread marked.
        <aside className="chat-list collapsed" data-testid="chat-list-collapsed">
          <button className="chat-btn chat-btn-icon chat-collapse" onClick={toggleCollapsed}
            title="Show the chat list" aria-label="Show the chat list" aria-expanded="false">&#187;</button>
          <ul className="chat-rail">
            {railChats.map((c) => {
              const active = openChat && openChat.ns === c.ns && openChat.path === c.path;
              const unread = active ? 0 : Math.max(0, c.count - readSeen(c.ns, c.path));
              return (
                <li key={`${c.ns}/${c.path}`}>
                  <button className={`chat-rail-item${active ? ' active' : ''}`} title={c.title}
                    aria-label={`${c.title}${unread ? `, ${unread} unread` : ''}`}
                    style={{ background: `var(${colorForAuthor(c.title)})` }}
                    onClick={() => onSelectChat({ ns: c.ns, path: c.path })}>
                    {initialOf(c.title)}
                    {unread > 0 && <span className="chat-rail-unread" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      )}
      {showList && !narrow && (
        <aside className="chat-list">
          <header className="chat-list-header">
            {/* Phone: the app bar already says "Chats", so this row is the
                way back plus the count, laid out like the task board's
                header (← on the left). Desktop keeps the title and ✕. */}
            {isMobile ? (
              <>
                <button className="chat-btn chat-back" onClick={onClose} title="Back to where you were" aria-label="Leave chats">&#8592;</button>
                <NsPicker ns={ns} namespaces={namespaces} onSelectNs={onSelectNs} />
                <span className="chat-list-count">{loading ? '' : `${chats.length} chat${chats.length === 1 ? '' : 's'}`}</span>
              </>
            ) : (
              <h2>Chats</h2>
            )}
            <div className="chat-list-actions">
              <button className="chat-btn chat-btn-icon" onClick={refresh} title="Refresh the list of chats" aria-label="Refresh the list of chats">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
              </button>
              <button className="chat-btn chat-btn-primary" onClick={() => setCreating((v) => !v)}>+ New</button>
              {!isMobile && (
                <button className="chat-btn chat-btn-icon chat-collapse" onClick={toggleCollapsed}
                  title="Hide the chat list" aria-label="Hide the chat list" aria-expanded="true">&#171;</button>
              )}
              {/* No ✕ on desktop: the toolbar's "← Back to …" is the way out,
                  and two exits for one view was the confusing part. */}
            </div>
            {/* Desktop: the workspace gets its own full-width row, so the
                title and the buttons share one line instead of wrapping. */}
            {!isMobile && (
              <div className="chat-list-scope">
                <span className="chat-list-in">in</span>
                <NsPicker ns={ns} namespaces={namespaces} onSelectNs={onSelectNs} />
              </div>
            )}
          </header>
          {creating && (
            <NewChatForm
              ns={ns}
              canPrivate={!!account}
              onCancel={() => setCreating(false)}
              onCreated={(c) => { setCreating(false); refresh(); onSelectChat(c); }}
            />
          )}
          {chats.length > 0 && (
            <ChatTabs tab={tab} onTab={chooseTab} pinnedCount={pinnedHere.length} allCount={chats.length} />
          )}
          <ChatList
            chats={chats} loading={loading} error={error} openChat={openChat} onSelect={onSelectChat} filter={filter} onFilter={setFilter}
            onMenu={(x, y, c) => setMenu({ x, y, chat: c })}
            pins={pins} onTogglePin={togglePinFor} tab={tab}
          />
          {/* Right-click on a chat: the same menu component as the file tree. */}
          <ContextMenu
            visible={!!menu}
            x={menu?.x || 0}
            y={menu?.y || 0}
            target={menu?.chat || null}
            title={menu?.chat?.title}
            groups={chatMenuGroups({ canDelete: !!onDeleteChat, canMembers: !!account, pinned: pins && menu?.chat ? pins.includes(pinKey(menu.chat.ns, menu.chat.path)) : undefined })}
            onClose={() => setMenu(null)}
            onAction={async (action, c) => {
              if (!c) return;
              if (action === 'pin-chat' || action === 'unpin-chat') togglePinFor(c);
              if (action === 'open-note') onOpenNote(c.ns, c.path);
              if (action === 'chat-members') setDialog({ kind: 'members', chat: c });
              if (action === 'connect-agent') setDialog({ kind: 'agent', chat: c });
              if (action === 'copy-path') copyPlainText(mdnestUri(serverAlias, c.ns, c.path));
              if (action === 'delete-chat' && onDeleteChat) {
                try { if (await onDeleteChat(c.ns, c.path, c.title)) refresh(); } catch (e) { alert('Failed to delete the chat: ' + e.message); }
              }
            }}
          />
        </aside>
      )}
      {showRoom ? (
        <ChatRoom
          key={`${openChat.ns}/${openChat.path}`}
          chat={openChat}
          account={account}
          serverAlias={serverAlias}
          onOpenNote={onOpenNote}
          onDeleteChat={onDeleteChat ? async (ns, path, title) => {
            if (await onDeleteChat(ns, path, title)) refresh();
          } : null}
          onBack={isMobile ? () => onSelectChat(null) : null}
          onActivity={refresh}
          onDialog={(kind) => setDialog({ kind, chat: { ...openChat, title: chats.find((c) => c.ns === openChat.ns && c.path === openChat.path)?.title } })}
        />
      ) : !isMobile && (
        <section className="chat-room chat-room-placeholder">
          <div className="chat-empty">
            Pick a chat, or start one with <b>+ New</b>. A chat is an ordinary note, so people here and agents using
            <code> mdnest chat</code> talk in the same file.
          </div>
        </section>
      )}
      {dialog?.kind === 'members' && account && (
        <ChatDialog label="Members" onClose={closeDialog}>
          <ChatMembers chat={dialog.chat} account={account} onClose={closeDialog} onChanged={() => refresh()} />
        </ChatDialog>
      )}
      {dialog?.kind === 'agent' && (
        <ChatDialog label="Connect an agent" wide onClose={closeDialog}>
          <ChatAgentPanel chat={dialog.chat} serverAlias={serverAlias} onClose={closeDialog} />
        </ChatDialog>
      )}
    </div>
  );
}

export default ChatView;
