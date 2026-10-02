import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import { listChats, getChat, postChatMessage, convertToChat } from '../api.js';
import { sanitizeHtml } from '../sanitize.js';
import {
  CHAT_POLL_MS, CHAT_LIST_POLL_MS, DEFAULT_CHAT_FOLDER, chatPathFor, colorForAuthor,
  isOwnMessage, groupMessages, mergeMessages, formatChatTime, agentInstructions, plainPreview,
} from '../chat.js';
import './ChatView.css';

// The chats view: every chat channel on the left, the open conversation on
// the right. A chat is just a note (`mdnest-chat: true`), so everything shown
// here is also readable — and appendable — as that note, by people and agents.
//
// Updates are polled rather than pushed: live-collab is off by default and
// multi-mode only, and a chat has to work on every install.

const md = new Marked({ gfm: true, breaks: true });
const renderMessage = (text) => sanitizeHtml(md.parse(text || ''));

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

function NewChatForm({ namespaces, defaultNs, onCreated, onCancel }) {
  const [title, setTitle] = useState('');
  const [ns, setNs] = useState(defaultNs || namespaces[0] || '');
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
        <select className="chat-input" value={ns} onChange={(e) => setNs(e.target.value)} aria-label="Workspace">
          {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
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

function ChatList({ chats, loading, error, openChat, onSelect, filter, onFilter }) {
  const f = filter.trim().toLowerCase();
  const shown = f
    ? chats.filter((c) => `${c.title} ${c.ns}/${c.path}`.toLowerCase().includes(f))
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
              <button className={`chat-list-item${active ? ' active' : ''}`} onClick={() => onSelect({ ns: c.ns, path: c.path })}>
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
                <span className="chat-list-path">{c.ns}/{c.path}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {!loading && chats.length === 0 && (
        <div className="chat-empty">
          No chats yet. Create one, or right-click any note and choose <b>Make it a chat</b>.
        </div>
      )}
    </>
  );
}

function ChatRoom({ chat, account, serverAlias, onOpenNote, onBack, onActivity }) {
  const [doc, setDoc] = useState(null); // { title, description, you }
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [postingAs, setPostingAs] = useState(() => {
    try { return localStorage.getItem(AS_KEY) || ''; } catch { return ''; }
  });
  const [showAgent, setShowAgent] = useState(false);
  const scrollRef = useRef(null);
  const stickToBottom = useRef(true);
  const countRef = useRef(0);
  const visible = useVisible();

  const effectiveAs = postingAs.trim() || doc?.you || account || '';

  // Load from scratch when the chat changes.
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setMessages([]);
    setError('');
    countRef.current = 0;
    stickToBottom.current = true;
    getChat(chat.ns, chat.path, 0)
      .then((r) => {
        if (cancelled) return;
        setDoc({ title: r.title, description: r.description, you: r.you });
        setMessages(r.messages || []);
        countRef.current = r.count;
        writeSeen(chat.ns, chat.path, r.count);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [chat.ns, chat.path]);

  const poll = useCallback(async () => {
    try {
      const r = await getChat(chat.ns, chat.path, countRef.current);
      if (r.messages?.length) {
        setMessages((cur) => mergeMessages(cur, r.messages));
        onActivity?.();
      }
      countRef.current = Math.max(countRef.current, r.count);
      writeSeen(chat.ns, chat.path, countRef.current);
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

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await postChatMessage(chat.ns, chat.path, text, postingAs.trim());
      setDraft('');
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
          Connect an agent
        </button>
      </header>

      {showAgent && (
        <div className="chat-agent">
          <p>
            Hand an agent this chat and it can talk here. Each agent should post under its own <code>--as</code> name; <code>wait</code> blocks until someone replies.
          </p>
          <pre>{agentInstructions(serverAlias, chat.ns, chat.path)}</pre>
          <p className="chat-agent-mcp">MCP clients: <code>read_chat</code>, <code>post_chat</code>, <code>wait_chat</code>.</p>
        </div>
      )}

      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        {doc?.description && <div className="chat-description" dangerouslySetInnerHTML={{ __html: renderMessage(doc.description) }} />}
        {!doc && !error && <div className="chat-empty">Loading…</div>}
        {doc && messages.length === 0 && <div className="chat-empty">No messages yet — say hello.</div>}
        {grouped.map((m) => {
          const own = isOwnMessage(m, account, effectiveAs);
          return (
            <div key={m.n} className={`chat-msg${own ? ' own' : ''}${m.startsGroup ? ' first' : ''}`}>
              {m.startsGroup && (
                <div className="chat-msg-meta">
                  <span className="chat-msg-author" style={{ color: `var(${colorForAuthor(m.author)})` }}>{m.author}</span>
                  {m.via && <span className="chat-msg-via">via {m.via}</span>}
                  <span className="chat-msg-time" title={m.time}>{formatChatTime(m.time)}</span>
                </div>
              )}
              <div className="chat-bubble" dangerouslySetInnerHTML={{ __html: renderMessage(m.text) }} />
            </div>
          );
        })}
      </div>

      {error && <div className="chat-error chat-room-error">{error}</div>}

      <div className="chat-composer">
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
        <textarea
          className="chat-input chat-draft"
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          placeholder="Message"
          title="Enter to send, Shift+Enter for a new line"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!doc}
        />
        <button className="chat-btn chat-btn-primary" onClick={send} disabled={!doc || sending || !draft.trim()}>
          Send
        </button>
      </div>
    </section>
  );
}

function ChatView({ namespaces, defaultNs, account, serverAlias, isMobile, openChat, onSelectChat, onOpenNote, onClose }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const visible = useVisible();

  const refresh = useCallback(async () => {
    try {
      setChats(await listChats());
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
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
                <button className="chat-btn chat-back" onClick={onClose} title="Back to the editor" aria-label="Close chats">&#8592;</button>
                <span className="chat-list-count">{loading ? '' : `${chats.length} chat${chats.length === 1 ? '' : 's'}`}</span>
              </>
            ) : (
              <h2>Chats</h2>
            )}
            <div className="chat-list-actions">
              <button className="chat-btn chat-btn-primary" onClick={() => setCreating((v) => !v)}>+ New</button>
              {!isMobile && <button className="chat-btn" onClick={onClose} title="Back to the editor" aria-label="Close chats">✕</button>}
            </div>
          </header>
          {creating && (
            <NewChatForm
              namespaces={namespaces}
              defaultNs={defaultNs}
              onCancel={() => setCreating(false)}
              onCreated={(c) => { setCreating(false); refresh(); onSelectChat(c); }}
            />
          )}
          <ChatList chats={chats} loading={loading} error={error} openChat={openChat} onSelect={onSelectChat} filter={filter} onFilter={setFilter} />
        </aside>
      )}
      {showRoom ? (
        <ChatRoom
          key={`${openChat.ns}/${openChat.path}`}
          chat={openChat}
          account={account}
          serverAlias={serverAlias}
          onOpenNote={onOpenNote}
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
