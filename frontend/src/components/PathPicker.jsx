import { useState, useEffect, useRef } from 'react';
import { getTree } from '../api.js';

// Extracts all folder paths from a tree recursively
function extractFolders(nodes, prefix) {
  const folders = [];
  if (!nodes) return folders;
  for (const node of nodes) {
    if (node.type === 'folder') {
      const path = prefix ? prefix + '/' + node.name : node.name;
      folders.push('/' + path);
      folders.push(...extractFolders(node.children, path));
    }
  }
  return folders;
}

// In-memory cache for tree results — shared across all PathPicker instances.
// Prevents N simultaneous getTree calls when N users are expanded.
const treeCache = {};
const treeCacheTime = {};
const CACHE_TTL = 30000; // 30 seconds

async function getCachedTree(namespace) {
  const now = Date.now();
  if (treeCache[namespace] && treeCacheTime[namespace] && (now - treeCacheTime[namespace]) < CACHE_TTL) {
    return treeCache[namespace];
  }
  const tree = await getTree(namespace);
  treeCache[namespace] = tree;
  treeCacheTime[namespace] = now;
  return tree;
}

// Dropdown that shows "/" (entire namespace) plus all directories from the tree
function PathPicker({ namespace, value, onChange }) {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!namespace) { setFolders([]); return; }
    let cancelled = false;
    setLoading(true);
    getCachedTree(namespace)
      .then((tree) => {
        if (!cancelled) {
          const paths = extractFolders(tree.children || [], '');
          setFolders(paths);
        }
      })
      .catch(() => { if (!cancelled) setFolders([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [namespace]);

  return (
    <select className="path-picker" value={value} onChange={(e) => onChange(e.target.value)} disabled={!namespace || loading}>
      <option value="/">/ (entire namespace)</option>
      {folders.map((f) => (
        <option key={f} value={f}>{f}</option>
      ))}
    </select>
  );
}

export default PathPicker;
