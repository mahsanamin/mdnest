import { useEffect, useMemo, useRef, useState } from 'react';
import { getTree, getNamespacesDetail, transferItem } from '../api.js';
import {
  baseName, joinPath, isInvalidDestination, describeRefusal, newFolderError, transferSummary, isLargeTransfer,
  filterFolders,
} from '../transfer.js';

// Walks a tree and returns a flat list of {path, depth} for every folder.
// Used as the "where to" list in the move modal.
function flattenFolders(nodes, prefix, depth) {
  const out = [];
  if (!nodes) return out;
  for (const node of nodes) {
    if (node.type === 'folder' || node.type === 'directory') {
      const path = prefix ? prefix + '/' + node.name : node.name;
      out.push({ path: '/' + path, name: node.name, depth });
      out.push(...flattenFolders(node.children, path, depth + 1));
    }
  }
  return out;
}

// How long the picker waits after the last change before asking the server
// whether the destination would work.
const DRY_RUN_DELAY_MS = 250;

// MoveToModal — the destination picker for "Move to…" and "Copy to…", for a
// file or a folder, within the namespace or into another one. Opened from the
// tree's context menu (a long-press on a phone).
//
// "+ New folder" adds a folder to the list without creating anything: the
// transfer creates missing folders on confirm, so cancelling leaves no empty
// folder behind, and the dry run already checks the new path.
//
// For a folder, the dry run's answer says how much will move ("37 files,
// 12 MB"), with a warning when it is large, and the running transfer shows
// how long it has been going. (A transfer is one request — copy, verify, then
// delete the source — so there is no per-file progress to report.)
//
// It never guesses permissions: the namespace list comes from
// /api/namespaces?detail=1 (the current namespace plus every one writable at
// its root), and every choice of namespace, folder and name is checked with a
// dry run of POST /api/transfer before Confirm is enabled. A collision, a
// missing right or an oversized folder therefore shows up while choosing, not
// as a failure after confirming. The real call runs the same checks again.
export default function MoveToModal({ mode = 'move', namespace, source, onClose, onDone }) {
  const sourcePath = source?.path || '';
  const [namespaces, setNamespaces] = useState([namespace]);
  const [destNs, setDestNs] = useState(namespace);
  const [tree, setTree] = useState(null);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState(baseName(sourcePath));
  const [check, setCheck] = useState({ state: 'idle' }); // idle | checking | ok | refused
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Folders typed with "+ New folder" for this namespace: {path, name, parent}.
  const [newFolders, setNewFolders] = useState([]);
  const [adding, setAdding] = useState(null); // {parent, name, error} while typing
  const [elapsed, setElapsed] = useState(0);
  // Folder search: with many folders, scrolling the tree for the right one
  // was the slow part of moving anything.
  const [query, setQuery] = useState('');
  const listRef = useRef(null);
  const checkSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getNamespacesDetail()
      .then((list) => {
        if (cancelled) return;
        // The current namespace stays offered even with only a path-scoped
        // grant (moving inside it worked before); others need write at root.
        const names = list.filter((n) => n.name === namespace || n.canWrite).map((n) => n.name);
        setNamespaces(names.includes(namespace) ? names : [namespace, ...names]);
      })
      .catch(() => { /* older server or offline: same-namespace only */ });
    return () => { cancelled = true; };
  }, [namespace]);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setSelected(null);
    setNewFolders([]);
    setAdding(null);
    setQuery('');
    getTree(destNs)
      .then((t) => { if (!cancelled) setTree(t); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load folders'); });
    return () => { cancelled = true; };
  }, [destNs]);

  const destinations = useMemo(() => {
    if (!tree) return [];
    const list = [{ path: '/', name: '/ (root)', depth: 0 }, ...flattenFolders(tree.children || [], '', 1)];
    // Each new folder sits right under its parent, marked as new.
    for (const nf of newFolders) {
      const at = list.findIndex((d) => d.path === nf.parent);
      if (at < 0) continue;
      list.splice(at + 1, 0, { path: nf.path, name: nf.name, depth: list[at].depth + 1, isNew: true });
    }
    return list.filter((d) => !isInvalidDestination({ sourceNs: namespace, sourcePath, destNs, destFolder: d.path }));
  }, [tree, newFolders, namespace, sourcePath, destNs]);

  const searching = query.trim() !== '';
  const shown = useMemo(() => filterFolders(destinations, query), [destinations, query]);

  // Leaving a search puts the full tree back; keep the chosen folder in view.
  useEffect(() => {
    if (searching) return;
    const el = listRef.current?.querySelector('.moveto-item.selected');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [searching]);

  // The folder names already under a parent, real or new, for the name check.
  const childNames = (parent) => {
    const prefix = parent === '/' ? '/' : parent + '/';
    return destinations
      .filter((d) => d.path !== '/' && d.path.startsWith(prefix) && !d.path.slice(prefix.length).includes('/'))
      .map((d) => d.name);
  };

  const startNewFolder = () => setAdding({ parent: selected?.path || '/', name: '', error: '' });
  const addNewFolder = () => {
    const name = adding.name.trim();
    const err = newFolderError(name, childNames(adding.parent));
    if (err) { setAdding({ ...adding, error: err }); return; }
    const path = adding.parent === '/' ? '/' + name : adding.parent + '/' + name;
    const nf = { path, name, parent: adding.parent };
    setNewFolders((list) => [...list, nf]);
    setSelected({ path, name, isNew: true });
    setAdding(null);
  };

  const trimmedName = name.trim();
  const toPath = selected && trimmedName ? joinPath(selected.path, trimmedName) : '';

  // Dry-run the current choice. A sequence number drops answers that arrive
  // after the user has already picked something else.
  useEffect(() => {
    if (!toPath) { setCheck({ state: 'idle' }); return undefined; }
    const seq = ++checkSeq.current;
    setCheck({ state: 'checking' });
    const timer = setTimeout(async () => {
      try {
        const r = await transferItem(mode, { ns: namespace, path: sourcePath }, { ns: destNs, path: toPath }, { dryRun: true });
        if (seq !== checkSeq.current) return;
        setCheck(r.status === 200 ? { state: 'ok', body: r.body } : { state: 'refused', status: r.status, body: r.body });
      } catch (e) {
        if (seq === checkSeq.current) setCheck({ state: 'refused', status: 0, body: { error: e.message || 'network error' } });
      }
    }, DRY_RUN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [mode, namespace, sourcePath, destNs, toPath]);

  // While a transfer runs, count the seconds so a long one visibly moves.
  useEffect(() => {
    if (!busy) return undefined;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const handleConfirm = async () => {
    if (check.state !== 'ok' || !toPath) return;
    setBusy(true);
    setError('');
    try {
      const r = await transferItem(mode, { ns: namespace, path: sourcePath }, { ns: destNs, path: toPath });
      if (r.status === 200) {
        onDone?.({ mode, fromNs: namespace, fromPath: sourcePath, ns: destNs, path: toPath });
        return;
      }
      setCheck({ state: 'refused', status: r.status, body: r.body });
    } catch (e) {
      setError(e.message || 'Failed');
    }
    setBusy(false);
  };

  const verb = mode === 'copy' ? 'Copy' : 'Move';
  const verbing = mode === 'copy' ? 'Copying' : 'Moving';
  const collision = check.state === 'refused' && check.status === 409;
  const summary = check.state === 'ok' ? transferSummary(check.body) : '';
  const large = check.state === 'ok' && isLargeTransfer(check.body);
  const newFolderPath = selected?.isNew ? selected.path.replace(/^\//, '') : '';

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal moveto-modal" onClick={(e) => e.stopPropagation()} data-testid="transfer-modal">
        <h3>{verb} to…</h3>
        <div className="moveto-source">
          {mode === 'copy' ? 'Copying' : 'Moving'}: <code>{sourcePath}</code>
        </div>

        {namespaces.length > 1 && (
          <label className="moveto-field">
            <span>Namespace</span>
            <select
              value={destNs}
              onChange={(e) => setDestNs(e.target.value)}
              disabled={busy}
              data-testid="transfer-namespace"
            >
              {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}

        {error && <div className="moveto-error">{error}</div>}

        {!tree && !error && <div className="moveto-loading">Loading folders…</div>}

        {tree && (
          <input
            type="search"
            className="moveto-search"
            placeholder="Search folders…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the best match; Esc clears the search first.
              if (e.key === 'Enter' && searching && shown.length > 0) { e.preventDefault(); setSelected(shown[0]); setQuery(''); }
              if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
            }}
            disabled={busy}
            aria-label="Search folders"
            data-testid="transfer-search"
          />
        )}

        {tree && (
          <div className="moveto-list" role="listbox" aria-label="Destination folder" ref={listRef}>
            {destinations.length === 0 && <div className="moveto-empty">No valid destinations.</div>}
            {searching && destinations.length > 0 && shown.length === 0 && (
              <div className="moveto-empty">No folder matches “{query.trim()}”.</div>
            )}
            {shown.map((d) => {
              const isSelected = selected?.path === d.path;
              return (
                <button
                  key={d.path}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`moveto-item${isSelected ? ' selected' : ''}`}
                  style={{ paddingLeft: searching ? '0.75rem' : `${d.depth * 0.75 + 0.75}rem` }}
                  onClick={() => setSelected(d)}
                  disabled={busy}
                  title={d.path}
                >
                  <span className="moveto-icon" aria-hidden="true">📁</span>
                  {/* A search result is shown with its whole path: without its
                      parents above it, a bare name is hard to place. */}
                  {searching ? (
                    <span className="moveto-name moveto-name-path">
                      <span className="moveto-parent">{d.path.slice(1, d.path.length - d.name.length)}</span>
                      <span className="moveto-leaf">{d.name}</span>
                    </span>
                  ) : (
                    <span className="moveto-name">{d.name}</span>
                  )}
                  {d.isNew && <span className="moveto-new-badge">new</span>}
                </button>
              );
            })}
          </div>
        )}

        {tree && !adding && (
          <button type="button" className="moveto-newfolder" onClick={startNewFolder} disabled={busy} data-testid="transfer-new-folder">
            + New folder{selected && selected.path !== '/' ? ` in ${selected.name}` : ''}
          </button>
        )}
        {adding && (
          <div className="moveto-newfolder-row">
            <input
              type="text"
              autoFocus
              placeholder="Folder name"
              value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value, error: '' })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addNewFolder(); }
                if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); }
              }}
              aria-label="New folder name"
              data-testid="transfer-new-folder-name"
            />
            <button type="button" onClick={addNewFolder} data-testid="transfer-new-folder-add">Add</button>
            <button type="button" onClick={() => setAdding(null)} aria-label="Cancel new folder">✕</button>
            {adding.error && <div className="moveto-newfolder-error">{adding.error}</div>}
          </div>
        )}

        <label className="moveto-field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={collision ? 'conflict' : ''}
            disabled={busy}
            data-testid="transfer-name"
          />
        </label>

        <div className={`moveto-check moveto-check-${check.state}`} role="status" data-testid="transfer-check">
          {check.state === 'idle' && (selected ? 'Type a name.' : 'Choose a folder.')}
          {check.state === 'checking' && 'Checking…'}
          {check.state === 'ok' && !busy && (
            <>
              Ready: {destNs !== namespace ? destNs + ':' : ''}{toPath}
              {summary && <> — {verb.toLowerCase()} {summary}</>}
              {newFolderPath && <> · creates the folder {newFolderPath}</>}
            </>
          )}
          {busy && `${verbing}${summary ? ' ' + summary : ''}… ${elapsed}s`}
          {check.state === 'refused' && describeRefusal(check.status, check.body)}
        </div>
        {large && (
          <div className="moveto-check moveto-check-warn" data-testid="transfer-large">
            {busy
              ? 'Large folders take a while. It finishes on the server even if you close this.'
              : `This is a large folder. ${verbing} ${summary} can take a while, depending on its size.`}
          </div>
        )}

        <div className="moveto-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={handleConfirm}
            disabled={busy || check.state !== 'ok'}
            data-testid="transfer-confirm"
          >
            {busy ? `${verb === 'Copy' ? 'Copying' : 'Moving'}…` : `${verb} here`}
          </button>
        </div>
      </div>
    </div>
  );
}
