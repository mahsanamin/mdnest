import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import { listChats, getChat, postChatMessage, convertToChat, listChatGifs, getToken } from '../api.js';
import { resolveImgSrc } from '../img-src.js';
import { sanitizeHtml } from '../sanitize.js';
import {
  CHAT_POLL_MS, CHAT_LIST_POLL_MS, DEFAULT_CHAT_FOLDER, chatPathFor, colorForAuthor,
  isOwnMessage, groupMessages, mergeMessages, workingLine, formatChatTime, agentInstructions, plainPreview,
  highlightMentions, mentionsName, participants, mentionQuery, completeMention,
  avatarFor, reactions, gifMarkdown, expandGifRefs, initialOf,
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

function NewChatForm({ ns, onCreated, onCancel }) {
  const [title, setTitle] = useState('');
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
      await convertToChat(ns, path, title.trim());
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

function ChatList({ chats, loading, error, openChat, onSelect, filter, onFilter, onMenu }) {
  const f = filter.trim().toLowerCase();
  const shown = f
    ? chats.filter((c) => `${c.title} ${c.path}`.toLowerCase().includes(f))
    : chats;
  if (error) return <div className="chat-empty chat-error">{error}</div>;
  return (
    <>
      {chats.length > 6 && (
        <input className="chat-input chat-filter" placeholder="Filter chats" value={filter} onChange={(e) => onFilter(e.target.value)} />
      )}
      <ul className="chat-list-items">
        {shown.map((c) => {
          const active = openChat && openChat.ns === c.ns && openChat.path === c.path;
          const unread = active ? 0 : Math.max(0, c.count - readSeen(c.ns, c.path));
          return (
            <li key={`${c.ns}/${c.path}`}>
              <button
                className={`chat-list-item${active ? ' active' : ''}`}
                onClick={() => onSelect({ ns: c.ns, path: c.path })}
                onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e.clientX, e.clientY, c); } : undefined}
              >
                <span className="chat-list-top">
                  <span className="chat-list-title">{c.title}</span>
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
      {!loading && chats.length === 0 && (
        <div className="chat-empty">
          No chats in this workspace yet. Create one with <b>+ New</b>, or right-click a folder and choose <b>New chat</b>.
        </div>
      )}
    </>
  );
}

function ChatRoom({ chat, account, serverAlias, onOpenNote, onDeleteChat, onBack, onActivity }) {
  const [doc, setDoc] = useState(null); // { title, description, you }
  const [working, setWorking] = useState([]); // who said they are busy, from the server
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [postingAs, setPostingAs] = useState(() => {
    try { return localStorage.getItem(AS_KEY) || ''; } catch { return ''; }
  });
  const [showAgent, setShowAgent] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [agentIntent, setAgentIntent] = useState('');
  const [agentRole, setAgentRole] = useState(''); // a CHAT_ROLES id, or '' for none
  // Esc closes the agent panel from anywhere in the chat, besides its × button.
  useEffect(() => {
    if (!showAgent) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) setShowAgent(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showAgent]);
  const [copied, setCopied] = useState(false);
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
  const stickToBottom = useRef(true);
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
    stickToBottom.current = true;
    getChat(chat.ns, chat.path, 0)
      .then((r) => {
        if (cancelled) return;
        setDoc({ title: r.title, description: r.description, you: r.you });
        setMessages(r.messages || []);
        setWorking(r.working || []);
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
        setMessages((cur) => mergeMessages(cur, r.messages));
        onActivity?.();
      }
      countRef.current = Math.max(countRef.current, r.count);
      writeSeen(chat.ns, chat.path, countRef.current);
      setWorking(r.working || []);
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

  // Follow new messages only if the reader is already at the bottom —
  // scrolling up to read history must not be yanked back down by a poll.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const send = async (override) => {
    const text = (typeof override === 'string' ? override : draft).trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await postChatMessage(chat.ns, chat.path, text, postingAs.trim());
      if (typeof override !== 'string') setDraft('');
      stickToBottom.current = true;
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
        <button className={`chat-btn${showAgent ? ' active' : ''}`} onClick={() => setShowAgent((v) => !v)} title="How an agent joins this chat">
          <span className="chat-label-long">Connect an agent</span>
          <span className="chat-label-short">Agents</span>
        </button>
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

      {showAgent && (
        <div className="chat-agent">
          <div className="chat-agent-head">
            <strong>Connect an agent</strong>
            <button
              className="chat-btn chat-btn-icon chat-agent-close"
              onClick={() => setShowAgent(false)}
              title="Close (Esc)"
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
          <p>
            Paste this into the agent. Give it one name and it will use that name everywhere, so <code>@name</code> reaches it.
          </p>
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
          <div className="chat-agent-row">
            <input
              className="chat-input"
              placeholder="Agent name, e.g. codxu"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value.replace(/[^\w.-]/g, ''))}
              maxLength={40}
              aria-label="Agent name"
            />
            <button
              className="chat-btn"
              onClick={() => {
                if (copyPlainText(agentInstructions(serverAlias, chat.ns, chat.path, agentName || 'AGENT_NAME', agentIntent))) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >{copied ? 'Copied!' : 'Copy prompt'}</button>
          </div>
          {/* What the agent is for, in the person's own words. It goes into the
              prompt after the name, so the agent starts with its job instead
              of asking for one. */}
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
          <pre>{agentInstructions(serverAlias, chat.ns, chat.path, agentName || 'AGENT_NAME', agentIntent)}</pre>
          <p className="chat-agent-mcp">MCP clients: <code>read_chat</code>, <code>post_chat</code>, <code>wait_chat</code>.</p>
        </div>
      )}

      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        {doc?.description && <div className="chat-description" dangerouslySetInnerHTML={{ __html: renderMessage(doc.description, chat.ns, gifs) }} />}
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
                  <span className="chat-msg-author" style={{ color: `var(${colorForAuthor(m.author)})` }}>{m.author}</span>
                  {m.via && <span className="chat-msg-via">via {m.via}</span>}
                  <span className="chat-msg-time" title={m.time}>{formatChatTime(m.time)}</span>
                </div>
              )}
              <div className="chat-bubble" dangerouslySetInnerHTML={{ __html: renderMessage(m.text, chat.ns, gifs) }} />
            </div>
          );
        })}
      </div>

      {error && <div className="chat-error chat-room-error">{error}</div>}

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
            {line && <><span className="chat-working-dots" aria-hidden="true"><i /><i /><i /></span><span className="chat-working-text">{line.text}</span></>}
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
  const [filter, setFilter] = useState('');
  const visible = useVisible();

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

  return (
    <div className="chat-panel">
      {showList && (
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
              <h2>Chats <span className="chat-list-in">in</span> <NsPicker ns={ns} namespaces={namespaces} onSelectNs={onSelectNs} /></h2>
            )}
            <div className="chat-list-actions">
              <button className="chat-btn chat-btn-icon" onClick={refresh} title="Refresh the list of chats" aria-label="Refresh the list of chats">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
              </button>
              <button className="chat-btn chat-btn-primary" onClick={() => setCreating((v) => !v)}>+ New</button>
              {/* No ✕ on desktop: the toolbar's "← Back to …" is the way out,
                  and two exits for one view was the confusing part. */}
            </div>
          </header>
          {creating && (
            <NewChatForm
              ns={ns}
              onCancel={() => setCreating(false)}
              onCreated={(c) => { setCreating(false); refresh(); onSelectChat(c); }}
            />
          )}
          <ChatList
            chats={chats} loading={loading} error={error} openChat={openChat} onSelect={onSelectChat} filter={filter} onFilter={setFilter}
            onMenu={(x, y, c) => setMenu({ x, y, chat: c })}
          />
          {/* Right-click on a chat: the same menu component as the file tree. */}
          <ContextMenu
            visible={!!menu}
            x={menu?.x || 0}
            y={menu?.y || 0}
            target={menu?.chat || null}
            title={menu?.chat?.title}
            groups={chatMenuGroups({ canDelete: !!onDeleteChat })}
            onClose={() => setMenu(null)}
            onAction={async (action, c) => {
              if (!c) return;
              if (action === 'open-note') onOpenNote(c.ns, c.path);
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
        />
      ) : !isMobile && (
        <section className="chat-room chat-room-placeholder">
          <div className="chat-empty">
            Pick a chat, or start one with <b>+ New</b>. A chat is an ordinary note, so people here and agents using
            <code> mdnest chat</code> talk in the same file.
          </div>
        </section>
      )}
    </div>
  );
}

export default ChatView;
