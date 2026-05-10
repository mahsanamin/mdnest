import { useEffect, useMemo, useState } from 'react';
import { getTree, moveItem } from '../api.js';

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

// MoveToModal — touch-friendly destination picker for moving a file or
// folder. Opened from the context menu's "Move to…" action; replaces
// the desktop drag-and-drop affordance on phones (where draggable=false).
//
// Filters out invalid destinations:
//   - The source itself (can't move to where you already are).
//   - The source's current parent (no-op).
//   - Any descendant of the source if the source is a folder (would be
//     a circular move).
//
// On confirm, calls the existing moveItem(ns, from, to) — same endpoint
// drag-and-drop uses — so the rename / collision / permission rules are
// identical across the two entry points.
export default function MoveToModal({ namespace, source, onClose, onMoved }) {
  const [tree, setTree] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getTree(namespace)
      .then((t) => { if (!cancelled) setTree(t); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load tree'); });
    return () => { cancelled = true; };
  }, [namespace]);

  const sourcePath = source?.path || '';
  const sourceParent = useMemo(() => {
    if (!sourcePath) return '/';
    const idx = sourcePath.lastIndexOf('/');
    return idx > 0 ? '/' + sourcePath.substring(0, idx) : '/';
  }, [sourcePath]);

  const destinations = useMemo(() => {
    if (!tree) return [];
    const folders = flattenFolders(tree.children || [], '', 1);
    // Always offer the namespace root as a destination, unless source is
    // already at the root.
    const list = [{ path: '/', name: '/ (root)', depth: 0 }, ...folders];

    return list.filter((dest) => {
      // Same-parent no-op
      if (dest.path === sourceParent) return false;
      // Source itself
      if (dest.path === '/' + sourcePath) return false;
      // Descendant of source (circular for folders)
      if (dest.path.startsWith('/' + sourcePath + '/')) return false;
      return true;
    });
  }, [tree, sourcePath, sourceParent]);

  const handleConfirm = async () => {
    if (!selected) return;
    const fromPath = sourcePath;
    // Destination dir + original filename = new path on disk
    const destDir = selected.path === '/' ? '' : selected.path.replace(/^\//, '');
    const fileName = sourcePath.split('/').pop();
    const toPath = destDir ? `${destDir}/${fileName}` : fileName;

    setBusy(true);
    setError('');
    try {
      await moveItem(namespace, fromPath, toPath);
      onMoved?.(toPath);
    } catch (e) {
      setError(e.message || 'Move failed');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal moveto-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Move to…</h3>
        <div className="moveto-source">
          Moving: <code>{sourcePath || '(root)'}</code>
        </div>

        {error && <div className="moveto-error">{error}</div>}

        {!tree && !error && <div className="moveto-loading">Loading folders…</div>}

        {tree && (
          <div className="moveto-list" role="listbox">
            {destinations.length === 0 && (
              <div className="moveto-empty">No valid destinations.</div>
            )}
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

        <div className="moveto-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={handleConfirm}
            disabled={busy || !selected}
          >
            {busy ? 'Moving…' : 'Move here'}
          </button>
        </div>
      </div>
    </div>
  );
}
