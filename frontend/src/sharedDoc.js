// Shared editing for one open markdown note (lazily loaded chunk).
//
// Everyone in a note keeps one Yjs document. The server relays the updates
// and keeps them in memory for people who join later (backend/collab/yjs.go);
// it never reads them. The file on disk stays the source of truth: exactly one
// browser in the room, the "saver" the server picks, writes the markdown with
// the ordinary PUT /api/note, so there are no longer several tabs racing to
// save their own copy of the whole file.
//
// What the document holds:
//   - the editor content (y-prosemirror's 'prosemirror' fragment),
//   - 'frontmatter': the YAML block, kept out of the editor (sharedText.js),
//   - 'meta', the last time the room and the file agreed: etag (what the
//     next save sends as If-Match), base (the file text then), baseMd (what
//     the editor serialized then, stored only when it differs from base),
//     dirty ("the room has text the file does not", so the saver writes
//     it). A save happens only when the editor's markdown differs from
//     baseMd, which is why opening a note and leaving it never rewrites the
//     file. Plain values, replaced on each save: Yjs drops a replaced value
//     completely when the saver compacts the room, which keeps the snapshot
//     small over a long session (frontend/scripts/measure-shared-room.mjs).
//
// Changes from outside the room (git-sync, the CLI, an agent, a restore) are
// merged by the saver: a three-way merge of base, the room's text and the
// file, applied to the editor as an ordinary edit, so it reaches everyone.
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { undo as yUndo, redo as yRedo } from 'y-prosemirror';
import { prosePluginsCtx } from '@milkdown/core';
import { saveNote, getNote, saveNoteOnLeave } from './api.js';
import {
  splitFrontMatter, joinFrontMatter, mergeThreeWay,
  encodeFrame, encodeSnapshot, decodeServerFrame,
  TAG_UPDATE, TAG_AWARENESS, TAG_STATE,
} from './sharedText.js';

export { collab as collabPlugin, yUndo, yRedo };

const SAVE_DELAY = 800;
// How long the saver waits after a file-changed it did not cause before it
// checks the file: long enough for a just-replaced saver's meta to arrive.
const OUTSIDE_GRACE = 1200;
// The saver also looks at the file on a timer. git-sync pulls and edits made
// on the host write the file without telling the server's collab hub, so no
// file-changed ever arrives for them. (The whole-file path has the app's own
// 60 s poll; a shared note skips it, because reloading would replace the
// room's text, so the saver does the check here instead, as a merge.)
const OUTSIDE_POLL = 20000;
const REMOTE = 'remote';
// What the editor tells the person when shared editing stops for them.
const ERROR_TEXT = {
  'room-full': 'Too many people are in this note to edit it together. It is read-only for you; reload to try again.',
  'no-write': 'You can no longer save this note.',
  'server-full': 'The server is holding too many shared notes right now. This note is read-only for you; reload in a while.',
  'room-too-big': 'Shared editing stopped for this note (it grew too large). Reload to continue.',
};
const errorEvent = (error) => ({ type: 'error', error, message: ERROR_TEXT[error] || ERROR_TEXT['room-too-big'] });
const META = 'meta';

let nextId = 1;

export class SharedSession {
  // initialText: what this tab shows (it seeds the room if it is first).
  // initialBase/initialEtag: the file as last loaded or saved. They differ
  // only if this tab had text it could not save before shared editing
  // started; the room then starts out unsaved and the saver writes it.
  constructor({ client, ns, path, initialText, initialBase, initialEtag, canWrite, user, onEvent }) {
    this.id = nextId++;
    // For LiveEditorCrepe, which must not import this chunk itself.
    this.collabPlugin = collab;
    this.undo = yUndo;
    this.redo = yRedo;
    this.client = client;
    this.ns = ns;
    this.path = path;
    this.initialText = initialText || '';
    this.initialBase = typeof initialBase === 'string' ? initialBase : this.initialText;
    this.initialEtag = initialEtag || null;
    this.canWrite = !!canWrite;
    this.onEvent = onEvent || (() => {});
    this.initial = splitFrontMatter(this.initialText);

    this.doc = new Y.Doc();
    this.fragment = this.doc.getXmlFragment('prosemirror');
    this.fm = this.doc.getText('frontmatter');
    this.meta = this.doc.getMap('meta');
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalStateField('user', user || { name: 'someone', color: '#89b4fa' });

    this.lastSeq = 0;
    this.ownSent = 0;
    this.saver = false;
    this.seed = false;
    this.ready = false;
    this.bound = false;
    this.closed = false;
    this.disabled = false;
    this.editor = null;
    this.ownEtags = new Set();
    // Cursor labels. The name inside an awareness update is whatever the
    // sender wrote, so it is never shown: the server stamps each relayed
    // update with the sender's account id (owners: awareness client id ->
    // account id) and the label comes from the presence list (people:
    // account id -> { username, color }), which the server also wrote.
    this.owners = new Map();
    this.people = new Map();
    this.saveTimer = null;
    this.saving = null;
    this.savePending = false;

    this._onDocUpdate = this._onDocUpdate.bind(this);
    this._onAwareness = this._onAwareness.bind(this);
    this._onPageHide = this._onPageHide.bind(this);
    this.doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwareness);
    window.addEventListener('pagehide', this._onPageHide);

    client.shared = {
      owner: this,
      onBinary: (u8) => this._onBinary(u8),
      onOpen: () => this._hello(),
    };
    if (client.connected) this._hello();
  }

  // --- The editor ------------------------------------------------------------

  // Called by LiveEditorCrepe once Crepe is created (with `collabPlugin`
  // already .use()d). api: { editor, serialize(), applyBody(markdown) }.
  attachEditor(api) {
    this.editor = api;
    this._maybeBind();
  }

  detachEditor() {
    this.editor = null;
  }

  // The whole file for an editor body (the editor never holds front matter).
  withFrontMatter(body) {
    return joinFrontMatter(this.fm.toString(), body);
  }

  setUser(user) {
    const cur = this.awareness.getLocalState()?.user;
    if (!cur || cur.id !== user.id || cur.name !== user.name || cur.color !== user.color) {
      this.awareness.setLocalStateField('user', user);
    }
  }

  // The whole file as the room has it now.
  fullMarkdown() {
    if (!this.editor) return null;
    return joinFrontMatter(this.fm.toString(), this.editor.serialize());
  }

  _maybeBind() {
    if (this.bound || !this.editor || !this.ready || this.closed) return;
    const seeding = this.seed && this.fragment.length === 0;
    if (!seeding && this.fragment.length === 0) return; // wait for the seed
    const { editor } = this.editor;
    editor.action((ctx) => {
      // Undo is per person through Yjs' undo manager; ProseMirror's own
      // history would undo other people's edits.
      ctx.update(prosePluginsCtx, (ps) => ps.filter((p) => !String(p.key || '').startsWith('history$')));
      const svc = ctx.get(collabServiceCtx);
      svc.bindDoc(this.doc).setAwareness(this.awareness);
      svc.mergeOptions({
        yCursorOpts: {
          cursorBuilder: (_user, clientId) => this._cursorDom(clientId),
          selectionBuilder: (_user, clientId) => ({
            style: `background-color: ${this._person(clientId).color}40`,
            class: 'ProseMirror-yjs-selection',
          }),
        },
      });
      if (seeding) {
        this.doc.transact(() => {
          if (this.initial.frontMatter) this.fm.insert(0, this.initial.frontMatter);
        });
        svc.applyTemplate(this.initial.body, () => true);
        if (this.fragment.length === 0) {
          // An empty note still needs one block, or nobody else can tell
          // the room was seeded.
          this.fragment.insert(0, [new Y.XmlElement('paragraph')]);
        }
      }
      svc.connect();
    });
    this.bound = true;
    this.seed = false;
    if (seeding) {
      // Record what "unchanged" serializes to once the editor shows the
      // seeded document (next frames), then tell the server this state is
      // the file's.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this.closed) return;
        const md = this.fullMarkdown();
        this.doc.transact(() => {
          this._setAgreed(this.initialEtag, this.initialBase, md, this.initialBase !== this.initialText);
        }, META);
        if (this.initialBase === this.initialText) this._sendSaved(this.lastSeq, this.ownSent);
        else if (this.saver) this._scheduleSave(0);
      }));
    }
    this.onEvent({ type: 'bound' });
    if (this.saver) this._becameSaver();
  }

  // --- Wire ------------------------------------------------------------------

  _hello() {
    // Only ever on a socket for this note: the client may still be on the
    // previous note's socket when the session is created.
    if (this.closed || this.left || this.client.ns !== this.ns || this.client.path !== this.path) return;
    this.client.sendJSON({ type: 'yjs-hello' });
  }

  _sendSaved(recv, own) {
    if (!this.canWrite || this.left) return;
    this.client.sendJSON({ type: 'yjs-saved', recv, own });
  }

  // JSON control messages (App forwards every yjs-* message here).
  onControl(msg) {
    if (this.closed) return;
    switch (msg.type) {
      case 'yjs-seed':
        if (this.canWrite) {
          this.seed = true;
          this._maybeBind();
        }
        break;
      case 'yjs-role': {
        const was = this.saver;
        this.saver = !!msg.saver && this.canWrite;
        if (this.saver && !was && this.bound) this._becameSaver();
        if (!this.saver) { this._cancelSave(); this._stopPoll(); }
        break;
      }
      case 'yjs-ready':
        this.ready = true;
        this._maybeBind();
        break;
      case 'yjs-compact':
        if (this.saver) {
          this.client.sendBinary(encodeSnapshot(this.lastSeq, Y.encodeStateAsUpdate(this.doc)));
        }
        break;
      case 'yjs-error':
        this.disabled = true;
        this._cancelSave();
        this.onEvent(errorEvent(msg.error));
        break;
      case 'yjs-closed':
        this.onEvent({ type: 'closed', reason: msg.reason });
        this.destroy();
        break;
      default:
    }
  }

  _onBinary(u8) {
    if (this.closed) return;
    const f = decodeServerFrame(u8);
    if (!f) return;
    if (f.tag === TAG_STATE) {
      // Joining (or rejoining after a reconnect). Anything this tab has that
      // the server does not (it restarted, or our last updates were lost
      // with the old socket) is sent back; Yjs ignores what it already has.
      const hadState = this.doc.store.clients.size > 0;
      const server = new Y.Doc();
      for (const e of f.entries) {
        Y.applyUpdate(this.doc, e, REMOTE);
        Y.applyUpdate(server, e);
      }
      this.lastSeq = Math.max(this.lastSeq, f.seq);
      if (hadState && this.canWrite) {
        const missing = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(server));
        if (missing.length > 2) this._sendUpdate(missing);
      }
      server.destroy();
      this._maybeBind();
    } else if (f.tag === TAG_UPDATE) {
      this.lastSeq = Math.max(this.lastSeq, f.seq);
      Y.applyUpdate(this.doc, f.payload, REMOTE);
      this._maybeBind();
    } else if (f.tag === TAG_AWARENESS) {
      applyAwarenessUpdate(this.awareness, f.payload, { remoteUser: f.userId });
    }
  }

  _sendUpdate(u) {
    if (this.client.sendBinary(encodeFrame(TAG_UPDATE, u))) this.ownSent += 1;
  }

  _onDocUpdate(update, origin) {
    if (this.closed || this.left) return;
    if (origin !== REMOTE && this.canWrite && !this.disabled) this._sendUpdate(update);
    if (this.saver && origin !== META) this._scheduleSave();
  }

  _onAwareness({ added, updated, removed }, origin) {
    if (origin && typeof origin === 'object' && 'remoteUser' in origin) {
      for (const id of added.concat(updated)) this.owners.set(id, origin.remoteUser);
      for (const id of removed) this.owners.delete(id);
      return;
    }
    if (origin === REMOTE || this.closed || this.left) return;
    const changed = added.concat(updated, removed);
    if (changed.length) this.client.sendBinary(encodeFrame(TAG_AWARENESS, encodeAwarenessUpdate(this.awareness, changed)));
  }

  // Someone joined: let them see our cursor without waiting for a move.
  announce() {
    if (this.closed || !this.awareness.getLocalState()) return;
    this.client.sendBinary(encodeFrame(TAG_AWARENESS, encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
  }

  // A user left the note: drop their cursors now rather than after the
  // awareness timeout.
  forgetUser(userId) {
    const gone = [];
    this.owners.forEach((uid, clientId) => {
      if (uid === userId && clientId !== this.doc.clientID) gone.push(clientId);
    });
    if (gone.length) removeAwarenessStates(this.awareness, gone, REMOTE);
  }

  // The presence list, as the server sent it: [{ id, username, color }].
  setPeople(users) {
    this.people = new Map((users || []).map((u) => [u.id, u]));
  }

  _person(clientId) {
    const p = this.people.get(this.owners.get(clientId));
    return { name: p?.username || 'someone', color: /^#[0-9a-f]{6}$/i.test(p?.color || '') ? p.color : '#89b4fa' };
  }

  _cursorDom(clientId) {
    const { name, color } = this._person(clientId);
    const caret = document.createElement('span');
    caret.className = 'ProseMirror-yjs-cursor';
    caret.style.borderColor = color;
    const label = document.createElement('div');
    label.style.backgroundColor = color;
    label.textContent = name;
    caret.append(label);
    return caret;
  }

  // --- Saving ----------------------------------------------------------------

  _becameSaver() {
    // Handover: the previous saver may have left with text unsaved, and the
    // file may have changed while nobody was saving. Check the file first,
    // then save whatever differs.
    this._checkOutside().finally(() => this._scheduleSave(0));
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        if (this.saver && !this.closed && !this.disabled) this._checkOutside();
      }, OUTSIDE_POLL);
    }
  }

  _stopPoll() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  _cancelSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  _scheduleSave(delay = SAVE_DELAY) {
    if (!this.saver || this.closed || this.disabled) return;
    this._cancelSave();
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this._save(); }, delay);
  }

  // Whether the room holds text the file does not.
  dirty() {
    if (!this.bound || !this.meta.get('hasBase')) return false;
    const md = this.fullMarkdown();
    return md !== null && !this._unchanged(md);
  }

  async _save() {
    if (this.saving) { this.savePending = true; return this.saving; }
    if (!this.saver || this.closed || this.disabled || !this.bound || !this.meta.get('hasBase')) return undefined;
    const md = this.fullMarkdown();
    if (md === null) return undefined;
    const recv = this.lastSeq;
    const own = this.ownSent;
    if (this._unchanged(md)) {
      this._sendSaved(recv, own);
      return undefined;
    }
    const base = this.meta.get('base') || '';
    if (md.trim() === '' && base.trim() !== '') {
      // Same guard as the old autosave: never empty a note by autosave.
      console.warn('mdnest: shared save skipped, refusing to empty a non-empty note');
      return undefined;
    }
    this.saving = (async () => {
      try {
        const res = await saveNote(this.ns, this.path, md, this.meta.get('etag'));
        if (this.closed) return;
        if (res.etag) this.ownEtags.add(res.etag);
        const untouched = this.ownSent === own;
        this._setAgreed(res.etag || null, md, md, false);
        // The meta update is our next own update; it is covered too when
        // nothing was typed here during the PUT.
        this._sendSaved(recv, untouched ? this.ownSent : own);
        this.onEvent({ type: 'saved', text: md, etag: res.etag });
      } catch (e) {
        if (this.closed) return;
        if (e.status === 409) {
          await this._checkOutside();
          this.savePending = true;
        } else if (e.status === 404) {
          this.onEvent({ type: 'missing' });
          this.destroy();
        } else if (e.name === 'PermissionError' || e.status === 403) {
          this.disabled = true;
          this.onEvent(errorEvent('no-write'));
        } else {
          console.error('mdnest: shared save failed, will retry', e);
          setTimeout(() => this._scheduleSave(0), 3000);
        }
      }
    })();
    try { await this.saving; } finally {
      this.saving = null;
      if (this.savePending) { this.savePending = false; this._scheduleSave(0); }
    }
    return undefined;
  }

  // Save now (before leaving the note). Only the saver writes; the others'
  // text is already in the room.
  async flush() {
    this._cancelSave();
    if (this.saver && this.dirty()) await this._save();
    else if (this.saving) await this.saving;
  }

  _onPageHide() {
    if (!this.saver || this.closed || !this.dirty()) return;
    saveNoteOnLeave(this.ns, this.path, this.fullMarkdown(), this.meta.get('etag'));
  }

  // --- Outside changes -------------------------------------------------------

  // App forwards file-changed broadcasts here.
  onFileChanged(msg) {
    if (this.closed || !this.saver) return;
    if (msg.etag && (this.ownEtags.has(msg.etag) || msg.etag === this.meta.get('etag'))) return;
    setTimeout(() => {
      if (msg.etag && msg.etag === this.meta.get('etag')) return; // a room save after all
      this._checkOutside();
    }, OUTSIDE_GRACE);
  }

  async _checkOutside() {
    if (this.checking) { this.recheck = true; return this.checking; }
    if (!this.saver || this.closed || !this.bound || !this.meta.get('hasBase')) return undefined;
    this.checking = (async () => {
      let file;
      try { file = await getNote(this.ns, this.path); } catch (e) {
        if (e.status === 404 || /not found/i.test(e.message || '')) {
          this.onEvent({ type: 'missing' });
          this.destroy();
        }
        return;
      }
      if (this.closed) return;
      const { text, etag } = file;
      if (etag && etag === this.meta.get('etag')) return;
      const base = this.meta.get('base') || '';
      if (text === base) {
        this.doc.transact(() => this.meta.set('etag', etag), META);
        return;
      }
      const ours = this.fullMarkdown();
      const clean = this._unchanged(ours);
      const merged = clean ? text : mergeThreeWay(base, ours, text);
      this._applyFull(merged);
      this._setAgreed(etag, text, this.fullMarkdown(), !clean);
      if (!clean) this._scheduleSave(0);
    })();
    try { await this.checking; } finally {
      this.checking = null;
      if (this.recheck) { this.recheck = false; this._checkOutside(); }
    }
    return undefined;
  }

  // Whether `md` is what the room and the file last agreed on.
  _unchanged(md) {
    if (this.meta.get('dirty')) return false;
    return md === (this.meta.has('baseMd') ? this.meta.get('baseMd') : this.meta.get('base'));
  }

  _setAgreed(etag, base, baseMd, dirty) {
    this.doc.transact(() => {
      this.meta.set('etag', etag);
      if (this.meta.get('base') !== base) this.meta.set('base', base);
      if (baseMd === base) {
        if (this.meta.has('baseMd')) this.meta.delete('baseMd');
      } else if (this.meta.get('baseMd') !== baseMd) {
        this.meta.set('baseMd', baseMd || '');
      }
      if (!this.meta.get('hasBase')) this.meta.set('hasBase', true);
      if (!!this.meta.get('dirty') !== dirty) this.meta.set('dirty', dirty);
    }, META);
  }

  _applyFull(text) {
    const { frontMatter, body } = splitFrontMatter(text);
    this.doc.transact(() => {
      if (this.fm.toString() !== frontMatter) {
        this.fm.delete(0, this.fm.length);
        if (frontMatter) this.fm.insert(0, frontMatter);
      }
    });
    if (this.editor) this.editor.applyBody(body);
  }

  // --- Lifecycle -------------------------------------------------------------

  // Leave the room now (synchronously): take our cursor away, tell the
  // server, and stop using the socket. The document stays, so a pending
  // save can still run (flush) before destroy().
  leave() {
    if (this.left) return;
    try { removeAwarenessStates(this.awareness, [this.doc.clientID], 'local'); } catch { /* ignore */ }
    this.left = true;
    const c = this.client;
    if (c.shared && c.shared.owner === this) {
      c.shared = null;
      if (c.connected && c.ns === this.ns && c.path === this.path) c.sendJSON({ type: 'yjs-leave' });
    }
  }

  destroy() {
    if (this.closed) return;
    this.leave();
    this.closed = true;
    this._cancelSave();
    this._stopPoll();
    window.removeEventListener('pagehide', this._onPageHide);
    this.awareness.destroy();
    this.doc.off('update', this._onDocUpdate);
    this.doc.destroy();
  }
}
