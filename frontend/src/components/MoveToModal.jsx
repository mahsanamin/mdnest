import { useEffect, useMemo, useRef, useState } from 'react';
import { getTree, getNamespacesDetail, transferItem } from '../api.js';
import { baseName, joinPath, isInvalidDestination, describeRefusal } from '../transfer.js';

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
    getTree(destNs)
      .then((t) => { if (!cancelled) setTree(t); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load folders'); });
    return () => { cancelled = true; };
  }, [destNs]);

  const destinations = useMemo(() => {
    if (!tree) return [];
    const list = [{ path: '/', name: '/ (root)', depth: 0 }, ...flattenFolders(tree.children || [], '', 1)];
    return list.filter((d) => !isInvalidDestination({ sourceNs: namespace, sourcePath, destNs, destFolder: d.path }));
  }, [tree, namespace, sourcePath, destNs]);

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
        setCheck(r.status === 200 ? { state: 'ok' } : { state: 'refused', status: r.status, body: r.body });
      } catch (e) {
        if (seq === checkSeq.current) setCheck({ state: 'refused', status: 0, body: { error: e.message || 'network error' } });
      }
    }, DRY_RUN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [mode, namespace, sourcePath, destNs, toPath]);

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
  const collision = check.state === 'refused' && check.status === 409;

  return (
    <div className="modal-backdrop" onClick={onClose}>
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
          <div className="moveto-list" role="listbox" aria-label="Destination folder">
            {destinations.length === 0 && <div className="moveto-empty">No valid destinations.</div>}
            {destinations.map((d) => {
              const isSelected = selected?.path === d.path;
              return (
                <button
                  key={d.path}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`moveto-item${isSelected ? ' selected' : ''}`}
                  style={{ paddingLeft: `${d.depth * 0.75 + 0.75}rem` }}
                  onClick={() => setSelected(d)}
                  disabled={busy}
                >
                  <span className="moveto-icon" aria-hidden="true">📁</span>
                  <span className="moveto-name">{d.name}</span>
                </button>
              );
            })}
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
          {check.state === 'ok' && `Ready: ${destNs !== namespace ? destNs + ':' : ''}${toPath}`}
          {check.state === 'refused' && describeRefusal(check.status, check.body)}
        </div>

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
