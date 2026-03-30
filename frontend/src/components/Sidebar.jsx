import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import TreeNode from './TreeNode.jsx';
import { searchNotes, adminSyncNamespace } from '../api.js';

// Filter tree nodes by filename match (case-insensitive)
function filterTree(nodes, query) {
  if (!query || !nodes) return nodes;
  const q = query.toLowerCase();
  const filtered = [];
  for (const node of nodes) {
    if (node.type === 'folder') {
      const childMatches = filterTree(node.children, query);
      const nameMatch = node.name.toLowerCase().includes(q);
      if (nameMatch || (childMatches && childMatches.length > 0)) {
        filtered.push({ ...node, children: childMatches || [] });
      }
    } else {
      if (node.name.toLowerCase().includes(q) || (node.path && node.path.toLowerCase().includes(q))) {
        filtered.push(node);
      }
    }
  }
  return filtered;
}

function Sidebar({
  tree,
  onSelect,
  currentPath,
  namespaces,
  selectedNs,
  onSelectNs,
  onContextMenu,
  onDrop,
  visible,
  onClose,
  userInfo,
  onLogout,
  onAdminPanel,
  onNewNote,
  onNewFolder,
  onRefreshTree,
  isAdmin,
}) {
  const [syncing, setSyncing] = useState(false);

  const handleSync = useCallback(async () => {
    if (syncing || !selectedNs) return;
    setSyncing(true);
    try {
      await adminSyncNamespace(selectedNs);
      if (onRefreshTree) await onRefreshTree();
    } catch (e) {
      console.error('Sync failed:', e);
    } finally {
      setSyncing(false);
    }
  }, [syncing, selectedNs, onRefreshTree]);
  const treeAreaRef = useRef(null);
  const longPressTimer = useRef(null);
  const touchMoved = useRef(false);
  const [expandAll, setExpandAll] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [contentResults, setContentResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef(null);

  const handleExpandAll = () => setExpandAll(true);
  const handleCollapseAll = () => setExpandAll(false);
  const resetExpandAll = () => setTimeout(() => setExpandAll(null), 50);

  // Content search with debounce — triggers after 400ms of typing
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);

    const q = searchQuery.trim();
    if (!q || q.length < 2 || !selectedNs) {
      setContentResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchNotes(selectedNs, q);
        setContentResults(results);
      } catch (e) {
        console.error('Search failed:', e);
        setContentResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery, selectedNs]);

  // Clear search when namespace changes
  useEffect(() => {
    setSearchQuery('');
    setContentResults(null);
  }, [selectedNs]);

  const filteredTree = searchQuery.trim()
    ? filterTree(tree, searchQuery.trim())
    : tree;

  const handleEmptyContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) onContextMenu(e.clientX, e.clientY, null);
  }, [onContextMenu]);

  const handleEmptyTouchStart = useCallback((e) => {
    touchMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!touchMoved.current && onContextMenu) {
        const touch = e.touches[0];
        onContextMenu(touch.clientX, touch.clientY, null);
      }
    }, 500);
  }, [onContextMenu]);

  const handleEmptyTouchEnd = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  const handleEmptyTouchMove = useCallback(() => {
    touchMoved.current = true;
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  const showContentResults = contentResults && contentResults.length > 0 && searchQuery.trim().length >= 2;

  return (
    <>
      {visible && <div className="sidebar-backdrop" onClick={onClose} />}
      <div className={`sidebar${visible ? ' sidebar-open' : ''}`}>
        <div className="sidebar-header">
          {namespaces.length > 1 ? (
            <select
              className="ns-select"
              value={selectedNs || ''}
              onChange={(e) => onSelectNs(e.target.value)}
            >
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
          ) : (
            <span className="ns-label">{selectedNs || 'mdnest'}</span>
          )}
          <div className="sidebar-tree-controls">
            {isAdmin && (
              <button
                className={`tree-control-btn${syncing ? ' spinning' : ''}`}
                onClick={handleSync}
                disabled={syncing}
                title="Git pull & refresh"
              >&#8635;</button>
            )}
            <button
              className="tree-control-btn"
              onClick={() => { handleExpandAll(); resetExpandAll(); }}
              title="Expand all"
            >&#8862;</button>
            <button
              className="tree-control-btn"
              onClick={() => { handleCollapseAll(); resetExpandAll(); }}
              title="Collapse all"
            >&#8863;</button>
          </div>
        </div>
        <div className="sidebar-search">
          <input
            type="text"
            className="search-input"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery('')}>x</button>
          )}
        </div>
        {(onNewNote || onNewFolder) && (
          <div className="sidebar-actions">
            {onNewNote && <button className="sidebar-action-btn" onClick={onNewNote}>+ Note</button>}
            {onNewFolder && <button className="sidebar-action-btn" onClick={onNewFolder}>+ Folder</button>}
          </div>
        )}

        {showContentResults && (
          <div className="search-results">
            <div className="search-results-header">
              Content matches ({contentResults.length})
            </div>
            {contentResults.map((r, i) => (
              <div
                key={`${r.path}-${r.line}-${i}`}
                className={`search-result-item${currentPath === r.path ? ' active' : ''}`}
                onClick={() => { onSelect(r.path); setSearchQuery(''); }}
              >
                <div className="search-result-path">{r.path}:{r.line}</div>
                <div className="search-result-snippet">{r.snippet}</div>
              </div>
            ))}
          </div>
        )}

        {searching && <div className="search-status">Searching...</div>}

        <div
          className="sidebar-tree"
          ref={treeAreaRef}
          onContextMenu={handleEmptyContextMenu}
          onTouchStart={handleEmptyTouchStart}
          onTouchEnd={handleEmptyTouchEnd}
          onTouchMove={handleEmptyTouchMove}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => {
            e.preventDefault();
            try {
              const data = JSON.parse(e.dataTransfer.getData('text/plain'));
              if (data.path && onDrop) onDrop(data.path, '');
            } catch (err) { /* ignore */ }
          }}
        >
          {Array.isArray(filteredTree) && filteredTree.map((node) => (
            <TreeNode
              key={node.path || node.name}
              node={node}
              onSelect={onSelect}
              currentPath={currentPath}
              depth={0}
              onContextMenu={onContextMenu}
              onDrop={onDrop}
              expandAll={searchQuery.trim() ? true : expandAll}
            />
          ))}
          {searchQuery.trim() && filteredTree.length === 0 && !showContentResults && !searching && (
            <div className="sidebar-empty">No matches</div>
          )}
          {!searchQuery.trim() && (!tree || tree.length === 0) && (
            <div className="sidebar-empty">No files yet</div>
          )}
        </div>
        {(userInfo || onLogout) && (
          <UserFooter userInfo={userInfo} onLogout={onLogout} onAdminPanel={onAdminPanel} />
        )}
      </div>
    </>
  );
}

function UserFooter({ userInfo, onLogout, onAdminPanel }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const initials = useMemo(() => {
    if (!userInfo?.username) return '?';
    return userInfo.username.slice(0, 2).toUpperCase();
  }, [userInfo]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  return (
    <div className="sidebar-footer" ref={menuRef}>
      <div className="sidebar-user-row" onClick={() => setMenuOpen(!menuOpen)}>
        <div className="user-avatar">{initials}</div>
        <div className="sidebar-user-info">
          <span className="sidebar-username">{userInfo?.username || 'User'}</span>
          <span className="sidebar-role">{userInfo?.role || ''}</span>
        </div>
      </div>
      {menuOpen && (
        <div className="user-menu">
          {onAdminPanel && (
            <div className="user-menu-item" onClick={() => { setMenuOpen(false); onAdminPanel(); }}>
              <span className="user-menu-icon">&#9881;</span>
              Manage Users & Access
            </div>
          )}
          {onLogout && (
            <div className="user-menu-item" onClick={() => { setMenuOpen(false); onLogout(); }}>
              <span className="user-menu-icon">&#8618;</span>
              Sign Out
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Sidebar;
