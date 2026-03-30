import { useState, useEffect } from 'react';
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

// Dropdown that shows "/" (entire namespace) plus all directories from the tree
function PathPicker({ namespace, value, onChange }) {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!namespace) { setFolders([]); return; }
    setLoading(true);
    getTree(namespace)
      .then((tree) => {
        const paths = extractFolders(tree.children || [], '');
        setFolders(paths);
      })
      .catch(() => setFolders([]))
      .finally(() => setLoading(false));
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
