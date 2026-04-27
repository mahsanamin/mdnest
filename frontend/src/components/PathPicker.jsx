import { useState, useEffect, useRef } from 'react';
import { getTree } from '../api.js';

// Extracts all folder paths from a tree recursively, up to maxDepth.
// "/" is depth 0; "/foo" is depth 1; "/foo/bar" is depth 2. Pass <= 0
// for no limit (the previous behavior).
function extractFolders(nodes, prefix, depth, maxDepth) {
  const folders = [];
  if (!nodes) return folders;
  // depth here = depth of items we're about to push. With maxDepth=2
  // we want "/foo" (1) and "/foo/bar" (2) but NOT "/foo/bar/baz" (3),
  // so skip only when strictly greater.
  if (maxDepth > 0 && depth > maxDepth) return folders;
  for (const node of nodes) {
    if (node.type === 'folder') {
      const path = prefix ? prefix + '/' + node.name : node.name;
      folders.push('/' + path);
      folders.push(...extractFolders(node.children, path, depth + 1, maxDepth));
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

// Dropdown that shows "/" (entire namespace) plus all directories from
// the tree, up to maxDepth (e.g. 3 means "/foo/bar/baz" is shown but
// "/foo/bar/baz/qux" isn't). Pass 0 or omit for no limit.
function PathPicker({ namespace, value, onChange, maxDepth }) {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const limit = maxDepth > 0 ? maxDepth : 0;

  useEffect(() => {
    if (!namespace) { setFolders([]); return; }
    let cancelled = false;
    setLoading(true);
    getCachedTree(namespace)
      .then((tree) => {
        if (!cancelled) {
          const paths = extractFolders(tree.children || [], '', 1, limit);
          setFolders(paths);
        }
      })
      .catch(() => { if (!cancelled) setFolders([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [namespace, limit]);

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
