// @vitest-environment jsdom
// One websocket per visit (v4.8.13): switching notes is a join message on
// the same socket, note messages that arrive before the server confirms a
// join belong to the previous note and are dropped, and an older server
// (one that wants ns and path in the URL) gets the per-note socket as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import CollabClient from '../collab.js';

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
  }
  send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  serverClose() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  msg(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  joins() { return this.sent.filter((m) => m.type === 'join'); }
}
FakeSocket.OPEN = 1;

function client() {
  const got = [];
  const status = [];
  const c = new CollabClient((m) => got.push(m), (s) => status.push(s));
  return { c, got, status };
}

describe('CollabClient: one socket per visit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    globalThis.WebSocket = FakeSocket;
    localStorage.setItem('mdnest_token', 'tok');
  });
  afterEach(() => vi.useRealTimers());

  it('opens one token-only socket and joins notes on it', () => {
    const { c, got, status } = client();
    c.setNote('ns', 'a.md');
    c.connect();
    expect(FakeSocket.all).toHaveLength(1);
    const ws = FakeSocket.all[0];
    expect(ws.url).toMatch(/\/api\/ws\?token=tok$/);
    ws.open();
    expect(ws.joins()).toEqual([{ type: 'join', ns: 'ns', path: 'a.md', seq: 1 }]);

    // Before the server confirms, nothing about a note is let through.
    ws.msg({ type: 'presence', users: [] });
    expect(got).toEqual([]);
    ws.msg({ type: 'joined', seq: 1, ns: 'ns', path: 'a.md' });
    ws.msg({ type: 'presence', users: [{ id: 1 }] });
    expect(got.map((m) => m.type)).toEqual(['presence']);

    // A switch: a message on the same socket, no new socket, no status change.
    c.setNote('ns', 'b.md');
    expect(FakeSocket.all).toHaveLength(1);
    expect(ws.joins().at(-1)).toEqual({ type: 'join', ns: 'ns', path: 'b.md', seq: 2 });
    ws.msg({ type: 'file-changed', etag: 'old note' }); // still a.md's
    ws.msg({ type: 'tree-changed' }); // not about one note: passes
    ws.msg({ type: 'joined', seq: 2, ns: 'ns', path: 'b.md' });
    ws.msg({ type: 'file-changed', etag: 'b' });
    expect(got.map((m) => m.etag || m.type)).toEqual(['presence', 'tree-changed', 'b']);
    expect(status).toEqual(['connecting', 'connected']);

    // No note: leave it, keep the socket.
    c.setNote(null, null);
    expect(ws.sent.at(-1)).toEqual({ type: 'leave-note' });
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('tells shared editing when it is in the note and when it is not', () => {
    const { c } = client();
    const events = [];
    c.shared = { onJoined: () => events.push('joined'), onClosed: () => events.push('closed'), onBinary: () => events.push('bin') };
    c.setNote('ns', 'a.md');
    c.connect();
    const ws = FakeSocket.all[0];
    ws.open();
    ws.onmessage({ data: new ArrayBuffer(2) }); // before joined: dropped
    ws.msg({ type: 'joined', seq: 1, ns: 'ns', path: 'a.md' });
    ws.onmessage({ data: new ArrayBuffer(2) });
    expect(events).toEqual(['joined', 'bin']);
    expect(c.joinedTo('ns', 'a.md')).toBe(true);
    ws.serverClose();
    expect(events.at(-1)).toBe('closed');
    expect(c.joinedTo('ns', 'a.md')).toBe(false);
    // Reconnects to the same visit socket and joins again.
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1].url).toMatch(/\?token=tok$/);
  });

  it('joins again after the server took it out of the note', () => {
    const { c } = client();
    c.setNote('ns', 'a.md');
    c.connect();
    const ws = FakeSocket.all[0];
    ws.open();
    ws.msg({ type: 'joined', seq: 1, ns: 'ns', path: 'a.md' });
    ws.msg({ type: 'note-left', ns: 'ns', path: 'a.md', reason: 'access' });
    expect(c.inNote).toBe(false);
    vi.advanceTimersByTime(300);
    expect(ws.joins().at(-1)).toMatchObject({ path: 'a.md', seq: 2 });
  });

  it('falls back to the per-note URL when the token-only socket is refused', () => {
    const { c, got } = client();
    c.setNote('ns', 'a.md');
    c.connect();
    FakeSocket.all[0].serverClose(); // an older server: 400, never opens
    vi.advanceTimersByTime(1000);
    const ws = FakeSocket.all[1];
    expect(ws.url).toMatch(/\?token=tok&ns=ns&path=a\.md$/);
    ws.open();
    expect(ws.joins()).toEqual([]);
    ws.msg({ type: 'presence', users: [] }); // in the note from the start
    expect(got.map((m) => m.type)).toEqual(['presence']);
    // A switch reopens the socket for the next note, as before v4.8.13.
    c.setNote('ns', 'b.md');
    expect(FakeSocket.all).toHaveLength(3);
    expect(FakeSocket.all[2].url).toMatch(/&path=b\.md$/);
  });

  it('falls back when nobody answers the join', () => {
    const { c } = client();
    c.setNote('ns', 'a.md');
    c.connect();
    FakeSocket.all[0].open();
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1].url).toMatch(/&ns=ns&path=a\.md$/);
  });

  it('a socket that worked once does not fall back when it later fails to connect', () => {
    const { c } = client();
    c.setNote('ns', 'a.md');
    c.connect();
    FakeSocket.all[0].open();
    FakeSocket.all[0].msg({ type: 'joined', seq: 1 });
    FakeSocket.all[0].serverClose();
    vi.advanceTimersByTime(1000);
    FakeSocket.all[1].serverClose(); // the network, not an old server
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all[2].url).toMatch(/\?token=tok$/);
  });
});
