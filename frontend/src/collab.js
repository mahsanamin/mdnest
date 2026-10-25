import { getToken } from './api.js';

// WebSocket collaboration client for presence, cursors and shared editing.
//
// One socket for the whole visit (v4.8.13): it opens once, and opening a note
// sends {type:"join"} on it instead of closing it and opening another. The
// server answers "joined" before anything that belongs to that note, so every
// note message that arrives before the answer to the latest join belongs to
// the previous note and is dropped. Tree and access changes are not about one
// note and always pass.
//
// An older backend only knows the per-note URL (/api/ws?ns=&path=). When the
// token-only socket is refused, or no "joined" comes back, the client goes
// back to that: one socket per note, reopened on every switch, as before.

const JOIN_WAIT = 2000; // no "joined" by then: an older server
const VISIT_WIDE = new Set(['tree-changed', 'access-changed']);

class CollabClient {
  // status: 'connected' | 'connecting' | 'disconnected'
  constructor(onMessage, onStatusChange) {
    this.ws = null;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.ns = null;
    this.path = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.closed = true;
    this._cursorThrottle = null;
    this._status = 'disconnected';
    this._connId = 0; // incremented on each connect, used to discard stale onclose
    // perNote: the server only takes the per-note URL (an older backend).
    this.perNote = false;
    this._everJoined = false;
    // The latest join sent, and the latest the server confirmed. Note
    // messages count only while they match.
    this.seq = 0;
    this.joinedSeq = -1;
    this.readOnly = false;
    this._joinTimer = null;
    // Shared editing (sharedDoc.js) attaches here: binary frames go to
    // onBinary, onJoined runs every time this socket is in the session's note
    // (after a switch or a reconnect), and onClosed when it no longer is.
    this.shared = null; // { onBinary(u8), onJoined(), onClosed() }
  }

  _setStatus(status) {
    if (status !== this._status) {
      this._status = status;
      if (this.onStatusChange) this.onStatusChange(status);
    }
  }

  // Open the socket for the visit (no-op when it is already open).
  connect() {
    if (!this.closed) return;
    this.closed = false;
    this.reconnectDelay = 1000;
    this._connId++;
    this._connect();
  }

  // Move to a note (or to none with ns/path null). On the visit socket this
  // is one message; on an older server it reopens the socket.
  setNote(ns, path) {
    if (ns === this.ns && path === this.path) return;
    this._dropPendingContent();
    const wasIn = this.inNote;
    // The note changes first, so the session of the note being left sees
    // that the socket moved on (it is about to go), not a lost connection.
    this.ns = ns || null;
    this.path = path || null;
    this.seq += 1;
    this.joinedSeq = -1;
    if (wasIn) this._leftShared();
    if (this.closed) return;
    if (this.perNote) {
      this._reopen();
      return;
    }
    this._sendJoin();
  }

  joinedTo(ns, path) {
    return this.connected && this.joinedSeq === this.seq && this.ns === ns && this.path === path;
  }

  get inNote() {
    return this.connected && !!this.ns && this.joinedSeq === this.seq;
  }

  _url() {
    const token = getToken();
    if (!token) return null;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
    if (this.perNote) {
      if (!this.ns || !this.path) return null;
      url += `&ns=${encodeURIComponent(this.ns)}&path=${encodeURIComponent(this.path)}`;
    }
    return url;
  }

  _connect() {
    if (this.closed) return;
    const url = this._url();
    if (!url) return;

    this._setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
    } catch (e) {
      this._setStatus('disconnected');
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    const myConnId = this._connId;

    ws.onopen = () => {
      if (this._connId !== myConnId) return;
      this.reconnectDelay = 1000;
      // "connected" means the server answers, not only that the socket
      // opened: a proxy can open one and pass nothing.
      if (!this.perNote && !(this.ns && this.path)) this._setStatus('connected');
      if (this.perNote) {
        // The URL named the note: in it from the start.
        this.joinedSeq = this.seq;
        this.readOnly = false;
        if (this.shared) this.shared.onJoined();
        return;
      }
      if (this.ns && this.path) this._sendJoin();
    };

    ws.onmessage = (e) => {
      if (this._connId !== myConnId) return;
      if (e.data instanceof ArrayBuffer) {
        if (this.inNote && this.shared) this.shared.onBinary(new Uint8Array(e.data));
        return;
      }
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      // A per-note socket is answered with the note's presence first.
      if (this.perNote) this._setStatus('connected');
      this._onJSON(msg);
    };

    ws.onclose = () => {
      // Ignore a socket we already replaced.
      if (this._connId !== myConnId) return;
      this.ws = null;
      this._clearJoinTimer();
      this.joinedSeq = -1;
      this._leftShared();
      if (!this._everJoined && !this.perNote && this.ns && this.path) {
        // The token-only socket closed before the server ever confirmed a
        // join: an older server that wants ns and path in the URL (it
        // refuses this one with a 400), or something in between that does.
        this.perNote = true;
      }
      if (!this.closed) {
        this._setStatus('connecting');
        this._scheduleReconnect();
      } else {
        this._setStatus('disconnected');
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  _onJSON(msg) {
    switch (msg.type) {
      case 'joined':
        if (msg.seq !== this.seq) return; // an earlier join
        this._clearJoinTimer();
        this._everJoined = true;
        this._setStatus('connected');
        this.joinedSeq = this.seq;
        this.readOnly = !!msg.readOnly;
        if (this.shared) this.shared.onJoined();
        return;
      case 'join-error':
        if (msg.seq === this.seq) this._clearJoinTimer();
        return;
      case 'note-left':
        if (msg.ns !== this.ns || msg.path !== this.path) return;
        // Access to the note changed: out of it now; ask again, and the
        // server answers with the access there is now (or refuses).
        this.joinedSeq = -1;
        this._leftShared();
        setTimeout(() => { if (this.ns === msg.ns && this.path === msg.path) { this.seq += 1; this._sendJoin(); } }, 300);
        return;
      default:
    }
    if (!VISIT_WIDE.has(msg.type) && !this.inNote) return; // for a note we left
    if (this.onMessage) this.onMessage(msg);
  }

  _sendJoin() {
    if (!this.ns || !this.path) {
      this._send({ type: 'leave-note' });
      return;
    }
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'join', ns: this.ns, path: this.path, seq: this.seq }));
    this._clearJoinTimer();
    this._joinTimer = setTimeout(() => {
      this._joinTimer = null;
      if (this.joinedSeq === this.seq || !this.connected || this.perNote) return;
      // The socket is open but nobody answers joins: an older server
      // (it would have closed a token-only socket) or one that swallows
      // our messages. Use the per-note URL from now on.
      this.perNote = true;
      this._reopen();
    }, JOIN_WAIT);
  }

  _clearJoinTimer() {
    if (this._joinTimer) clearTimeout(this._joinTimer);
    this._joinTimer = null;
  }

  // Shared editing loses the note when the socket closes or moves on.
  _leftShared() {
    if (this.shared && this.shared.onClosed) this.shared.onClosed();
  }

  // Close the current socket and open a new one at once (per-note mode).
  _reopen() {
    this._connId++;
    this._clearJoinTimer();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.joinedSeq = -1;
    this.reconnectDelay = 1000;
    this._connect();
  }

  _scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  _dropPendingContent() {
    // A trailing content send belongs to the note being left; sending it
    // after a switch would put this note's text into the next note.
    if (this._contentThrottle) {
      clearTimeout(this._contentThrottle);
      this._contentThrottle = null;
    }
    this._pendingContent = undefined;
  }

  // Close for good (sign-out, collaboration switched off).
  disconnect() {
    this.closed = true;
    this._connId++;
    this._dropPendingContent();
    this._clearJoinTimer();
    this._leftShared();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.ns = null;
    this.path = null;
    this.joinedSeq = -1;
    this._setStatus('disconnected');
  }

  // Send cursor position (throttled to every 100ms)
  sendCursor(line, ch) {
    if (this._cursorThrottle) return;
    this._send({ type: 'cursor', line, ch });
    this._cursorThrottle = setTimeout(() => {
      this._cursorThrottle = null;
    }, 100);
  }

  // Send selection range
  sendSelection(fromLine, fromCh, toLine, toCh) {
    this._send({ type: 'selection', fromLine, fromCh, toLine, toCh });
  }

  // Send live content, at most every 200ms. The LAST call inside a throttle
  // window is always sent when the window closes: without that trailing send
  // the final keystrokes of a burst never reached anyone else.
  sendContent(content) {
    if (this._contentThrottle) {
      this._pendingContent = content;
      return;
    }
    this._send({ type: 'content', content });
    this._pendingContent = undefined;
    this._contentThrottle = setTimeout(() => {
      this._contentThrottle = null;
      if (this._pendingContent !== undefined) {
        const next = this._pendingContent;
        this._pendingContent = undefined;
        this.sendContent(next);
      }
    }, 200);
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // Shared editing: a JSON control message or a binary Yjs frame, only while
  // the socket is in the note. Returns false otherwise (the session joins the
  // room again when it is).
  sendJSON(msg) {
    if (!this.inNote) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(u8) {
    if (!this.inNote) return false;
    this.ws.send(u8);
    return true;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

export default CollabClient;
