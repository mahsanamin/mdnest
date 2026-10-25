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
//
// The room never blocks typing (v4.8.13). The editor is editable from the
// start and saves the normal way (App's autosave) until the room is there.
// Then the session binds to the editor AS IT IS at that moment: an empty room
// is seeded from the editor's own document; a room that already has text is
// joined at once if this tab has nothing of its own, and otherwise once the
// room holds the same text as the editor (the room's saver merges this tab's
// normal saves from the file; merging here as well kept a line twice when
// the room had not caught up yet). When the socket goes
// away, the editor is unbound again and the app takes over saving, starting
// from the room's last save; a later rejoin starts from a fresh document, so
// nothing this tab merged through the file is replayed into the room twice.
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { undo as yUndo, redo as yRedo, prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode, updateYFragment } from 'y-prosemirror';
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
// The one shared editing problem the person is told about: they lost write
// access. Every other problem (a full room, the connection) goes back to the
// normal way of saving, quietly.
const NO_WRITE = { type: 'error', error: 'no-write', message: 'You can no longer save this note.' };
const isHistory = (p) => String(p.key || '').startsWith('history$');
const META = 'meta';

let nextId = 1;

export class SharedSession {
  // prepare(): { base, etag }, the file as the app last loaded or saved it,
  // asked for at the moment the editor joins the room.
  // saveNow(): save the normal way now (a saver waiting to join, below).
  constructor({ client, ns, path, canWrite, user, onEvent, prepare, saveNow }) {
    this.id = nextId++;
    // For LiveEditorCrepe, which must not import this chunk itself.
    this.collabPlugin = collab;
    this.undo = yUndo;
    this.redo = yRedo;
    this.client = client;
    this.ns = ns;
    this.path = path;
    this.canWrite = !!canWrite;
    this.onEvent = onEvent || (() => {});
    this.prepare = prepare || (() => ({ base: '', etag: null }));
    this.saveNow = saveNow || (() => {});
    // The file text this session started from (or that the room had saved
    // when the socket went). A tab still on it, with nothing typed, has
    // nothing the room lacks.
    this.startBase = this.prepare().base;
    this.user = user || { name: 'someone', color: '#89b4fa' };

    this.saver = false;
    this.seed = false;
    this.ready = false;
    this.bound = false;
    this.closed = false;
    // Bumped every time the session lets go of the editor (the socket went).
    // Work that awaited something (a file check, a save, a saver's join)
    // compares it after the await and stops if it changed: applying a file
    // check that started while bound to an editor that is now saving the
    // normal way put the file's old text over the person's typing.
    this.gen = 0;
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
    this._newDoc();
    window.addEventListener('pagehide', this._onPageHide);

    client.shared = {
      owner: this,
      onBinary: (u8) => this._onBinary(u8),
      onJoined: () => this._hello(),
      onClosed: () => this._socketGone(),
    };
    if (client.joinedTo(ns, path)) this._hello();
  }

  // A fresh, empty document: at the start and after the socket went away.
  _newDoc() {
    if (this.doc) {
      this.awareness.off('update', this._onAwareness);
      this.awareness.destroy();
      this.doc.off('update', this._onDocUpdate);
      this.doc.destroy();
    }
    this.doc = new Y.Doc();
    this.fragment = this.doc.getXmlFragment('prosemirror');
    this.fm = this.doc.getText('frontmatter');
    this.meta = this.doc.getMap('meta');
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalStateField('user', this.user);
    this.lastSeq = 0;
    this.ownSent = 0;
    this.helloSent = false;
    this.doc.on('update', this._onDocUpdate);
    this.awareness.on('update', this._onAwareness);
  }

  // --- The editor ------------------------------------------------------------

  // Called by LiveEditorCrepe once Crepe is created with `collabPlugin`
  // .use()d. api: { editor, frontMatter(), setFrontMatter(fm), serialize(),
  // normalize(fullText), seedDoc(), getSelection(), setSelection(sel),
  // applyBody(markdown) }.
  attachEditor(api) {
    this.editor = api;
    this._maybeBind();
  }

  detachEditor() {
    // The editor is going away (another note, Basic): nothing to hand over.
    if (this.bound) {
      this._confirmSaved();
      this._unbindEditor();
    }
    this.bound = false;
    this.editor = null;
  }

  // The whole file for an editor body (the editor never holds front matter).
  withFrontMatter(body) {
    return joinFrontMatter(this.fm.toString(), body);
  }

  setUser(user) {
    this.user = user;
    const cur = this.awareness.getLocalState()?.user;
    if (!cur || cur.id !== user.id || cur.name !== user.name || cur.color !== user.color) {
      this.awareness.setLocalStateField('user', user);
    }
  }

  // The whole file as the room has it now.
  fullMarkdown() {
    if (!this.editor || !this.bound) return null;
    return joinFrontMatter(this.fm.toString(), this.editor.serialize());
  }

  // joined: set by _saverJoin, which already put the merged text in the room.
  _maybeBind(joined = null) {
    if (this.bound || !this.editor || !this.ready || this.closed || this.disabled) return;
    const seeding = this.seed && this.fragment.length === 0;
    if (!seeding && this.fragment.length === 0) return; // wait for the seed
    const ed = this.editor;
    // What the editor holds now, typed on the normal path or not, and what
    // the file held when the app last saved or loaded it.
    const { base, etag } = this.prepare();
    const oursFm = ed.frontMatter();
    const ours = joinFrontMatter(oursFm, ed.serialize());
    const normBase = ed.normalize(base);
    const clean = ours === base || ours === normBase;
    if (!seeding && !joined && !(clean && base === this.startBase)) {
      // This tab has text of its own (typed, or saved the normal way while
      // apart from the room). It keeps saving the normal way, the room's
      // saver merges those saves from the file, and the editor joins once
      // the room holds the same text, so nothing is merged twice. If this
      // tab IS the saver (everyone was away, and it came back first), nobody
      // else will merge the file: it does, before it joins.
      if (this.saver && this.canWrite) {
        this._saverJoin();
        return;
      }
      let room = null;
      try { room = joinFrontMatter(this.fm.toString(), ed.serializeNode(yXmlFragmentToProseMirrorRootNode(this.fragment, ed.schema()))); } catch { room = null; }
      if (room !== ours) {
        this._waitForRoom();
        return;
      }
    }
    this._stopWaiting();
    const sel = ed.getSelection();
    this.binding = true;
    ed.editor.action((ctx) => {
      // Undo is per person through Yjs' undo manager; ProseMirror's own
      // history would undo other people's edits. Kept, to put back when the
      // editor is unbound.
      ctx.update(prosePluginsCtx, (ps) => {
        this.history = ps.filter(isHistory);
        return ps.filter((p) => !isHistory(p));
      });
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
        // The room starts as exactly the document on screen (minus what
        // only the editor adds, see seedDoc), so binding changes nothing
        // the person sees and the caret stays where it is.
        this.doc.transact(() => {
          if (oursFm) this.fm.insert(0, oursFm);
          prosemirrorToYXmlFragment(ed.seedDoc(), this.fragment);
          if (this.fragment.length === 0) {
            // An empty note still needs one block, or nobody else can tell
            // the room was seeded.
            this.fragment.insert(0, [new Y.XmlElement('paragraph')]);
          }
        });
      }
      svc.connect();
    });
    this.binding = false;
    this.bound = true;
    this.seed = false;
    if (seeding) {
      // What "unchanged" serializes to, and whether the room starts with
      // text the file does not have. Told to the server at once, so leaving
      // the note straight away leaves nothing unsaved behind.
      const md = this.fullMarkdown();
      this.doc.transact(() => {
        this._setAgreed(etag, base, clean ? md : normBase, !clean);
      }, META);
      if (clean) this._sendSaved(this.lastSeq, this.ownSent);
      else if (this.saver) this._scheduleSave(0);
    } else if (joined) {
      // The room now holds the file merged in: that file is what the room
      // and the file agree on.
      this.doc.transact(() => this._setAgreed(joined.etag, joined.text, joined.textMd, joined.dirty), META);
      if (joined.dirty) this._scheduleSave(0);
      else this._sendSaved(this.lastSeq, this.ownSent);
    }
    ed.setSelection(sel);
    this.onEvent({ type: 'bound' });
    if (this.saver) this._becameSaver();
  }

  // Updates the editor made on its own since the last save (heading ids, a
  // normalized table) change nothing in the file. Before going, the saver
  // says the room matches the file, so the server does not keep it as
  // unsaved work ("the last person left with unsaved updates").
  _confirmSaved() {
    if (this.bound && this.saver && this.canWrite && !this.left && !this.dirty()) {
      this._sendSaved(this.lastSeq, this.ownSent);
    }
  }

  // The saver, apart, with text of its own. It joins at the first moment all
  // of that text is saved: it reads the file, merges it with the room (the
  // three-way merge every saver does with an outside change), writes the
  // result into the room's document WITHOUT the editor (updateYFragment
  // changes only what differs), and then binds. The room then already holds
  // everything on screen, so binding takes nothing away from the person, and
  // a keystroke cannot land on stale text: the editor is never bound to a
  // room that lacks what it shows.
  async _saverJoin() {
    this._waitForRoom(); // checked again until it binds
    if (this.joiningSaver) return;
    const ed = this.editor;
    const { base } = this.prepare();
    const ours = joinFrontMatter(ed.frontMatter(), ed.serialize());
    if (ours !== base && ours !== ed.normalize(base)) {
      // Not all saved yet (typing, or a save on its way): save the normal
      // way now and look again.
      this.saveNow();
      return;
    }
    this.joiningSaver = true;
    const gen = this.gen;
    let file = null;
    try { file = await getNote(this.ns, this.path); } catch { file = null; }
    this.joiningSaver = false;
    if (!file || this.closed || gen !== this.gen || this.bound || this.disabled || !this.saver || !this.ready || this.editor !== ed) return;
    // Typed meanwhile, or another save landed: the next round.
    if (joinFrontMatter(ed.frontMatter(), ed.serialize()) !== ours || this.prepare().base !== base) return;
    let roomText;
    try {
      roomText = joinFrontMatter(this.fm.toString(), ed.serializeNode(yXmlFragmentToProseMirrorRootNode(this.fragment, ed.schema())));
    } catch { return; }
    const agreed = this.meta.get('hasBase') ? (this.meta.get('base') || '') : file.text;
    const merged = mergeThreeWay(agreed, roomText, file.text);
    // Usually the merge is exactly what is on screen (the file holds this
    // tab's text and the room had nothing else); then the editor's own
    // document goes in, and nothing moves at all.
    const onScreen = merged === ours || ed.normalize(merged) === ours;
    const split = splitFrontMatter(merged);
    const node = onScreen ? ed.seedDoc() : ed.parseDoc(split.body);
    if (!node) return;
    const fmWant = onScreen ? ed.frontMatter() : split.frontMatter;
    this.binding = true;
    try {
      this.doc.transact(() => {
        if (this.fm.toString() !== fmWant) {
          this.fm.delete(0, this.fm.length);
          if (fmWant) this.fm.insert(0, fmWant);
        }
        updateYFragment(this.doc, this.fragment, node, { mapping: new Map(), isOMark: new Map() });
      });
    } finally {
      this.binding = false;
    }
    const fileMd = ed.normalize(file.text);
    this._maybeBind({ etag: file.etag, text: file.text, textMd: fileMd, dirty: merged !== file.text && merged !== fileMd });
  }

  // Check again shortly: the room and the editor converge through the file.
  _waitForRoom() {
    if (!this.waitTimer) this.waitTimer = setInterval(() => this._maybeBind(), 400);
  }

  _stopWaiting() {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
  }

  // Take the editor off the room; it keeps its document and its history.
  _unbindEditor() {
    const ed = this.editor;
    this.bound = false;
    if (!ed) return;
    let sel = null;
    try { sel = ed.getSelection(); } catch { /* the editor is being destroyed */ }
    try {
      ed.editor.action((ctx) => {
        const history = this.history || [];
        if (history.length) ctx.update(prosePluginsCtx, (ps) => ps.concat(history.filter((h) => !ps.includes(h))));
        ctx.get(collabServiceCtx).disconnect();
      });
      // Same document, so the same caret, and the keyboard stays here.
      if (sel) ed.setSelection(sel);
    } catch { /* the editor is being destroyed */ }
    this.history = null;
  }

  // The socket closed or moved off this note. While bound, the editor goes
  // back to saving the normal way, from what the room last saved, and the
  // room's document is dropped: the next join starts from a fresh one.
  _socketGone() {
    if (this.closed) return;
    this.gen += 1;
    const wasBound = this.bound;
    let handover = null;
    if (wasBound) {
      const text = this.fullMarkdown();
      const base = this.meta.get('base');
      this.startBase = typeof base === 'string' ? base : text;
      handover = {
        type: 'unbound',
        base: typeof base === 'string' ? base : text,
        etag: this.meta.get('etag') || null,
        text: text !== null && !this._unchanged(text) ? text : (typeof base === 'string' ? base : text),
      };
      this._unbindEditor();
    }
    this._cancelSave();
    this._stopPoll();
    this._stopWaiting();
    this.bound = false;
    this.ready = false;
    this.seed = false;
    this.saver = false;
    this.owners.clear();
    this._newDoc();
    // Only for the note still open: a socket that moved on to another note
    // means this session is about to be destroyed.
    if (handover && this.client.ns === this.ns && this.client.path === this.path) this.onEvent(handover);
  }

  // --- Wire ------------------------------------------------------------------

  _hello() {
    // Only ever on a socket for this note: the client may still be on the
    // previous note's socket when the session is created.
    if (this.closed || this.left || this.disabled || !this.client.joinedTo(this.ns, this.path)) return;
    if (this.bound || this.helloSent) return;
    this.helloSent = this.client.sendJSON({ type: 'yjs-hello' });
  }

  // Which step a session that has not bound is on, for a support report
  // (the app logs it to the console; it never blocks or tells the person).
  whyUnbound() {
    if (this.bound) return null;
    if (!this.client.connected) return 'no-connection';
    if (!this.client.joinedTo(this.ns, this.path)) return 'no-join';
    if (!this.ready) return this.helloSent ? 'no-reply' : 'no-hello';
    if (!this.editor) return 'no-editor';
    return 'no-seed';
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
        // The room cannot take this tab (too many people, too big, a missing
        // note). Edit the normal way instead, for the rest of this note's
        // visit; the reason goes to the console, not to a notice.
        if (msg.error === 'missing') {
          this.disabled = true;
          this.onEvent({ type: 'missing' });
          break;
        }
        console.warn(`mdnest: shared editing stopped for this note (${msg.error}); saving the normal way`);
        this._socketGone();
        this.disabled = true;
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
    // Local updates come only from the bound editor (or the seed being put
    // in); taking the editor off the room must not send anything.
    if (origin !== REMOTE && this.canWrite && !this.disabled && (this.bound || this.binding)) this._sendUpdate(update);
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

  // anyTab: save even though this tab is not the saver (leaving the note).
  async _save({ anyTab = false } = {}) {
    if (this.saving) { this.savePending = true; return this.saving; }
    if ((!this.saver && !anyTab) || this.closed || this.disabled || !this.bound || !this.meta.get('hasBase')) return undefined;
    const md = this.fullMarkdown();
    if (md === null) return undefined;
    const recv = this.lastSeq;
    const gen = this.gen;
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
        // The save landed; the room it was for is gone if gen moved.
        if (this.closed || gen !== this.gen) return;
        if (res.etag) this.ownEtags.add(res.etag);
        const untouched = this.ownSent === own;
        this._setAgreed(res.etag || null, md, md, false);
        // The meta update is our next own update; it is covered too when
        // nothing was typed here during the PUT.
        this._sendSaved(recv, untouched ? this.ownSent : own);
        this.onEvent({ type: 'saved', text: md, etag: res.etag });
      } catch (e) {
        if (this.closed || gen !== this.gen) return;
        // Not the saver: the saver wrote first (or an outside change did) and
        // merges the file into the room itself. Its text has ours in it.
        if (e.status === 409 && !this.saver) return;
        if (e.status === 409) {
          await this._checkOutside();
          this.savePending = true;
        } else if (e.status === 404) {
          this.onEvent({ type: 'missing' });
          this.destroy();
        } else if (e.name === 'PermissionError' || e.status === 403) {
          this.disabled = true;
          this.onEvent(NO_WRITE);
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

  // Save now (before leaving the note), whether or not this tab is the
  // saver. The room has this tab's text, but when another tab or device held
  // the saver role, the file got it only after that tab's save delay (or
  // never, if that tab could not save): coming back showed the old file and
  // then the room's newer text. A save that races the saver's is refused
  // (409) and dropped here; the saver's text includes ours.
  async flush() {
    this._cancelSave();
    if (this.saving) await this.saving;
    if (this.dirty()) await this._save({ anyTab: true });
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
    const gen = this.gen;
    this.checking = (async () => {
      let file;
      try { file = await getNote(this.ns, this.path); } catch (e) {
        if (e.status === 404 || /not found/i.test(e.message || '')) {
          this.onEvent({ type: 'missing' });
          this.destroy();
        }
        return;
      }
      if (this.closed || gen !== this.gen || !this.bound) return;
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
    // Only into an editor bound to this room's document.
    if (!this.bound) return;
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
      if (c.joinedTo(this.ns, this.path)) {
        // Updates the editor made on its own since the last save (heading
        // ids, a normalized table) change nothing in the file: say the room
        // matches it, so the server does not keep it as unsaved work.
        this._confirmSaved();
        c.sendJSON({ type: 'yjs-leave' });
      }
    }
  }

  destroy() {
    if (this.closed) return;
    this.leave();
    if (this.bound) this._unbindEditor();
    this.bound = false;
    this.closed = true;
    this._cancelSave();
    this._stopPoll();
    this._stopWaiting();
    window.removeEventListener('pagehide', this._onPageHide);
    this.awareness.off('update', this._onAwareness);
    this.awareness.destroy();
    this.doc.off('update', this._onDocUpdate);
    this.doc.destroy();
  }
}
