import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import TreeNode from './TreeNode.jsx';
import { searchNotes, adminSyncNamespace, adminSyncStatus } from '../api.js';

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

function formatSyncTime(dateStr) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return d.toLocaleDateString();
  } catch { return dateStr; }
}

function Sidebar({
  tree,
  treeLoading,
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
  width,
  onResize,
  serverVersion,
  updateAvailableVersion,
  onShowReleaseNotes,
}) {
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState(null); // {isGitRepo, hasRemote, lastCommit, ...}
  const [refreshing, setRefreshing] = useState(false);

  // Manual tree refresh — always-visible escape hatch for cases where the
  // automatic propagation can't reach the client: single mode (no
  // WebSocket at all), multi mode without ENABLE_LIVE_COLLAB, or a
  // collab-enabled session with no file open (the per-file WS is closed
  // until a note is selected, so a `tree-changed` broadcast never arrives).
  // Files created via the `mdnest` CLI hit those exact paths.
  const handleManualRefresh = useCallback(async () => {
    if (refreshing || !onRefreshTree) return;
    setRefreshing(true);
    try {
      await onRefreshTree();
    } finally {
      // Hold the spin briefly so it registers visually even on fast refreshes.
      setTimeout(() => setRefreshing(false), 600);
    }
  }, [refreshing, onRefreshTree]);

  // Fetch sync status when namespace changes
  useEffect(() => {
    if (!selectedNs) { setSyncInfo(null); return; }
    adminSyncStatus(selectedNs).then(setSyncInfo).catch(() => setSyncInfo(null));
  }, [selectedNs]);

  const handleSync = useCallback(async () => {
    if (syncing || !selectedNs) return;
    setSyncing(true);
    try {
      const result = await adminSyncNamespace(selectedNs);
      if (result.lastCommit) {
        setSyncInfo((prev) => prev ? { ...prev, lastCommit: result.lastCommit } : prev);
      }
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

  // "Show full names" toggle. When on, .sidebar-tree gets the
  // .full-names class which lets labels wrap instead of ellipsizing —
  // useful on mobile when you want to scan long names without
  // committing to a tap. Persisted in localStorage so the choice
  // sticks across visits. Default off — clean uniform rhythm.
  const [fullNames, setFullNames] = useState(() => {
    try { return localStorage.getItem('mdnest_tree_full_names') === '1'; }
    catch { return false; }
  });
  const toggleFullNames = useCallback(() => {
    setFullNames((prev) => {
      const next = !prev;
      try { localStorage.setItem('mdnest_tree_full_names', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

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
      <div className={`sidebar${visible ? ' sidebar-open' : ''}`} style={width ? { width: width, minWidth: width } : undefined}>
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
            {/* Manual tree refresh — always visible (desktop + mobile) so
                the user has a touch-friendly way to pick up files created
                outside the UI (CLI, MCP, git-sync) without doing a full
                browser reload. The toolbar's refresh button only appears
                when a file is open; this one is the no-file-open path.
                Distinct two-arrow loop icon so it doesn't get confused
                with the admin-only git-sync button (single circle arrow,
                same glyph as &#8635;) that may render right next to it. */}
            <button
              className={`tree-control-btn${refreshing ? ' spinning' : ''}`}
              onClick={handleManualRefresh}
              disabled={refreshing || !selectedNs}
              title="Refresh tree"
              aria-label="Refresh tree"
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
            {syncInfo && isAdmin && (
              syncInfo.isGitRepo && syncInfo.hasRemote ? (
                <button
                  className={`tree-control-btn sync-btn${syncing ? ' spinning' : ''}`}
                  onClick={handleSync}
                  disabled={syncing}
                  title={syncInfo.lastCommit ? `Last synced: ${formatSyncTime(syncInfo.lastCommit)}\n${syncInfo.remoteUrl || ''}` : 'Git pull & refresh'}
                >&#8635;</button>
              ) : (
                <span className="sync-disabled" title="No git remote configured">&#8861;</span>
              )
            )}
            <button
              className="tree-control-btn"
              onClick={() => { handleExpandAll(); resetExpandAll(); }}
              title="Expand all folders"
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/><line x1="6" y1="4" x2="18" y2="4"/></svg></button>
            <button
              className="tree-control-btn"
              onClick={() => { handleCollapseAll(); resetExpandAll(); }}
              title="Collapse all folders"
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 15 12 9 18 15"/><line x1="6" y1="20" x2="18" y2="20"/></svg></button>
            {/* Toggle to wrap long folder/file names in the tree
                (default off → ellipsize; on → wrap to as many lines as
                needed). Active state shows the icon outlined to make
                the current mode obvious at a glance. */}
            <button
              className={`tree-control-btn${fullNames ? ' active' : ''}`}
              onClick={toggleFullNames}
              title={fullNames ? 'Compact: ellipsize long names' : 'Show full names (wrap long names)'}
              aria-pressed={fullNames}
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg></button>
          </div>
        </div>
        {syncInfo && (
          <div className={`sync-status-bar ${syncInfo.isGitRepo && syncInfo.hasRemote ? 'connected' : 'disconnected'}`}>
            {syncInfo.isGitRepo && syncInfo.hasRemote ? (
              <>
                <span className="sync-status-dot connected" />
                <span className="sync-status-text">
                  {syncInfo.lastCommit ? `Synced ${formatSyncTime(syncInfo.lastCommit)}` : 'Connected'}
                </span>
              </>
            ) : (
              <>
                <span className="sync-status-dot disconnected" />
                <span className="sync-status-text">{syncInfo.isGitRepo ? 'No remote' : 'Not a git repo'}</span>
              </>
            )}
          </div>
        )}
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
          className={`sidebar-tree${fullNames ? ' full-names' : ''}`}
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
          {/* Distinguish "still loading" from "genuinely empty" — on a slow
              connection the tree may take seconds to arrive, and the
              previous "No files yet" copy made it look like the namespace
              had no content. Show a spinner while in flight; only fall
              back to "No files yet" once the load has actually completed. */}
          {!searchQuery.trim() && (!tree || tree.length === 0) && treeLoading && (
            <div className="sidebar-tree-loading">
              <span className="sidebar-spinner" aria-hidden="true" />
              <span>Loading…</span>
            </div>
          )}
          {!searchQuery.trim() && (!tree || tree.length === 0) && !treeLoading && (
            <div className="sidebar-empty">No files yet</div>
          )}
          {/* When the tree IS already populated and a refresh is in
              flight (e.g. after rename/move/sync), show a thin
              indicator at the top instead of clearing the tree.
              Subtle so it doesn't distract during normal use. */}
          {tree && tree.length > 0 && treeLoading && (
            <div className="sidebar-tree-refreshing" aria-hidden="true" />
          )}
        </div>
        {(userInfo || onLogout) && (
          <UserFooter userInfo={userInfo} onLogout={onLogout} onAdminPanel={onAdminPanel} />
        )}
        <div className="sidebar-server-info">
          <span>{window.location.host}</span>
          {serverVersion && <span>v{serverVersion}</span>}
          {updateAvailableVersion && onShowReleaseNotes && (
            <button
              type="button"
              className="sidebar-update-badge"
              onClick={onShowReleaseNotes}
              title={`mdnest v${updateAvailableVersion} is available — click to see what's new`}
            >
              ↑ v{updateAvailableVersion}
            </button>
          )}
        </div>
        {onResize && (
          <div
            className="sidebar-resize-handle"
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startWidth = width || 260;
              const onMove = (ev) => {
                const newWidth = Math.min(600, Math.max(180, startWidth + ev.clientX - startX));
                onResize(newWidth);
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
              };
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          />
        )}
      </div>
    </>
  );
}

function UserFooter({ userInfo, onLogout, onAdminPanel }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const menuRef = useRef(null);

  // Display name picks the first non-empty of: username, email local-part,
  // or "User" — so a freshly-claimed SSO row with username NULL still shows
  // something readable (e.g. "ahsan.amin") instead of the placeholder.
  const displayName = useMemo(() => {
    if (userInfo?.username) return userInfo.username;
    if (userInfo?.email) return userInfo.email.split('@')[0];
    return 'User';
  }, [userInfo]);

  const initials = useMemo(() => {
    return (displayName || '?').slice(0, 2).toUpperCase();
  }, [displayName]);

  // Avatar URL comes from /api/me as avatar_url (set by SSO callback from
  // the IdP's `picture` claim). Falls back to initials if absent or the
  // image fails to load.
  const avatarURL = userInfo?.avatar_url;
  const showImg = avatarURL && !avatarFailed;

  useEffect(() => { setAvatarFailed(false); }, [avatarURL]);

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
        <div className="user-avatar">
          {showImg ? (
            <img
              src={avatarURL}
              alt=""
              onError={() => setAvatarFailed(true)}
              referrerPolicy="no-referrer"
            />
          ) : (
            initials
          )}
        </div>
        <div className="sidebar-user-info">
          <span className="sidebar-username">{displayName}</span>
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
