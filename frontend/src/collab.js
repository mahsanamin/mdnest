import { getToken } from './api.js';

// WebSocket collaboration client for presence and cursor sharing.
// Connects to /api/ws when a note is opened, disconnects on close.

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
    this.closed = false;
    this._cursorThrottle = null;
    this._status = 'disconnected';
  }

  _setStatus(status) {
    if (status !== this._status) {
      this._status = status;
      if (this.onStatusChange) this.onStatusChange(status);
    }
  }

  connect(ns, path) {
    this.disconnect();
    this.ns = ns;
    this.path = path;
    this.closed = false;
    this.reconnectDelay = 1000;
    this._connect();
  }

  _connect() {
    if (this.closed || !this.ns || !this.path) return;

    const token = getToken();
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${proto}//${host}/api/ws?ns=${encodeURIComponent(this.ns)}&path=${encodeURIComponent(this.path)}&token=${encodeURIComponent(token)}`;

    this._setStatus('connecting');

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this._setStatus('disconnected');
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this._setStatus('connected');
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (this.onMessage) this.onMessage(msg);
      } catch (err) {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.closed) {
        this._setStatus('connecting'); // will reconnect
        this._scheduleReconnect();
      } else {
        this._setStatus('disconnected');
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  _scheduleReconnect() {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this._connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  disconnect() {
    this.closed = true;
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

  // Send live content (throttled to every 200ms)
  sendContent(content) {
    if (this._contentThrottle) return;
    this._send({ type: 'content', content });
    this._contentThrottle = setTimeout(() => {
      this._contentThrottle = null;
    }, 200);
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

export default CollabClient;
