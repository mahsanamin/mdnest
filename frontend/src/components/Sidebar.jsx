import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import TreeNode from './TreeNode.jsx';
import { searchNotes, adminSyncNamespace, adminSyncStatus } from '../api.js';
import { onTabMessage } from '../tab-sync.js';

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

// Build timestamp (ISO-8601 UTC from /api/config) → readable local datetime.
function formatBuildTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}

// Per-namespace expanded-folder memory. The tree's open folders are remembered
// across refresh + namespace switches (so a reload doesn't re-expand the whole
// tree). Stored as a JSON array of folder paths under mdnest_tree_expanded:<ns>.
function loadExpandedPaths(key) {
  if (!key) return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}
function collectFolderPaths(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if ((n.type === 'folder' || n.type === 'directory') && n.path) {
        out.push(n.path);
        walk(n.children);
      }
    }
  };
  walk(Array.isArray(tree) ? tree : tree?.children);
  return out;
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
  onNewDrawing,
  onNewFolder,
  onOpenBoard,
  boardActive,
  pickedFolder,
  onPickFolder,
  onRefreshTree,
  isAdmin,
  width,
  onResize,
  serverVersion,
  serverCommit,
  serverBuildTime,
  updateAvailableVersion,
  onShowReleaseNotes,
  revealNonce,
}) {
  const [syncing, setSyncing] = useState(false);
  const [showVersionInfo, setShowVersionInfo] = useState(false);
  const versionInfoRef = useRef(null);
  // Dismiss the build-details popover on any outside click or Escape — before
  // this you had to click the ⓘ again to close it.
  useEffect(() => {
    if (!showVersionInfo) return;
    const onDown = (e) => {
      if (versionInfoRef.current && !versionInfoRef.current.contains(e.target)) {
        setShowVersionInfo(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') setShowVersionInfo(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showVersionInfo]);
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

  // Fetch sync status when the namespace changes, then poll so a background
  // git-sync that breaks mid-session surfaces without needing a namespace switch.
  useEffect(() => {
    if (!selectedNs) { setSyncInfo(null); return; }
    let cancelled = false;
    const load = () => adminSyncStatus(selectedNs)
      .then((v) => { if (!cancelled) setSyncInfo(v); })
      .catch(() => { if (!cancelled) setSyncInfo(null); });
    load();
    const id = setInterval(load, 60000);
    // Refresh the "Synced x ago" label immediately when another tab of this
    // browser reports a change (git-sync or a file op) for this namespace, so
    // the label doesn't lag behind the other tab until the next 60s poll.
    const offTab = onTabMessage((msg) => {
      if (msg?.type === 'tree-changed' && msg.ns === selectedNs) load();
    });
    return () => { cancelled = true; clearInterval(id); offTab(); };
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
  const expandKey = selectedNs ? `mdnest_tree_expanded:${selectedNs}` : null;
  const [expandedPaths, setExpandedPaths] = useState(() => loadExpandedPaths(expandKey));
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

  // Reload remembered expansion when the namespace changes; persist on change.
  useEffect(() => { setExpandedPaths(loadExpandedPaths(expandKey)); }, [expandKey]);
  useEffect(() => {
    if (!expandKey) return;
    try { localStorage.setItem(expandKey, JSON.stringify([...expandedPaths])); } catch { /* ignore */ }
  }, [expandKey, expandedPaths]);

  // Auto-reveal the open file: add its ancestor folders to the expanded set
  // once (so you can see where you are). Done here rather than force-expanding
  // in TreeNode, so those folders stay collapsible afterwards.
  useEffect(() => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    if (parts.length < 2) return; // file at namespace root — no ancestor folders
    const ancestors = [];
    for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join('/'));
    setExpandedPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const a of ancestors) if (!next.has(a)) { next.add(a); changed = true; }
      return changed ? next : prev;
    });
  }, [currentPath]);

  // Reveal-in-tree: the toolbar's "locate" button bumps `revealNonce`. Expand
  // the open file's ancestor folders (in case they were collapsed), then scroll
  // its row into view and briefly flash it — so the user can jump straight to
  // the current file when the tree is scrolled away or out of sync.
  useEffect(() => {
    if (!revealNonce || !currentPath) return;
    const parts = currentPath.split('/');
    if (parts.length >= 2) {
      const ancestors = [];
      for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join('/'));
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const a of ancestors) if (!next.has(a)) { next.add(a); changed = true; }
        return changed ? next : prev;
      });
    }
    // Let the (possibly newly-expanded) rows render before scrolling to the active one.
    const t = setTimeout(() => {
      const el = treeAreaRef.current?.querySelector('.tree-row.active');
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('reveal-flash');
      setTimeout(() => el.classList.remove('reveal-flash'), 1200);
    }, 80);
    return () => clearTimeout(t);
    // Intentionally keyed only on revealNonce — each button press re-triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce]);

  const toggleExpand = useCallback((path) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);
  const handleExpandAll = () => setExpandedPaths(new Set(collectFolderPaths(tree)));
  const handleCollapseAll = () => setExpandedPaths(new Set());

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

  const [rootDragOver, setRootDragOver] = useState(false);

  // Say where the create buttons will put things. The destination is not
  // otherwise visible, which is what made "+ Note" landing at the root while a
  // folder was open feel arbitrary.
  const createDir = pickedFolder !== null
    ? pickedFolder
    : (currentPath && currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '');
  const createHint = createDir ? `in ${createDir}/` : 'in the namespace root';

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
            <button
              className="tree-control-btn"
              onClick={handleExpandAll}
              title="Expand all folders"
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/><line x1="6" y1="4" x2="18" y2="4"/></svg></button>
            <button
              className="tree-control-btn"
              onClick={handleCollapseAll}
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
          <div className={`sync-status-bar ${syncInfo.daemonState === 'error' ? 'disconnected' : (syncInfo.isGitRepo && syncInfo.hasRemote ? 'connected' : 'disconnected')}`}>
            {syncInfo.daemonState === 'error' ? (
              <>
                {/* Background git-sync is broken (stuck / diverged / push rejected).
                    The last-commit date alone would hide this, so surface a red
                    cross with the daemon's own message and a Retry for admins. */}
                <span
                  className="sync-status-cross"
                  title={`Git sync is broken — ${syncInfo.daemonMessage || 'cannot reach the remote'}.${syncInfo.behind ? ` ${syncInfo.behind} change(s) behind remote.` : ''}${syncInfo.daemonUpdated ? `\nLast checked: ${formatSyncTime(syncInfo.daemonUpdated)}` : ''}`}
                  aria-label="Git sync broken"
                >✕</span>
                <span className="sync-status-text sync-status-error-text">
                  Git sync broken{syncInfo.behind ? ` — ${syncInfo.behind} behind` : ''}
                </span>
                {isAdmin && (
                  <button
                    className={`sync-status-btn${syncing ? ' spinning' : ''}`}
                    onClick={handleSync}
                    disabled={syncing}
                    title="Try to sync now (commit + pull + push)"
                    aria-label="Retry git sync"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
                    <span>Retry</span>
                  </button>
                )}
              </>
            ) : syncInfo.isGitRepo && syncInfo.hasRemote ? (
              <>
                <span className="sync-status-dot connected" />
                <span className="sync-status-text">
                  {syncInfo.lastCommit ? `Synced ${formatSyncTime(syncInfo.lastCommit)}` : 'Connected'}
                </span>
                {/* Git sync button lives next to the "Synced X ago" text
                    so it's contextually grouped with the git-sync metadata
                    rather than floating in the generic tree-control row.
                    Uses a git-branch glyph + "Sync" label — the backend
                    handler does all three of: commit pending changes,
                    pull --ff-only, push. So "Sync" is the truthful name;
                    "Pull" was misleading. Distinct from the generic
                    tree-refresh in the tree-control row above (two-arrow
                    loop icon, no git side-effects). Admin-only — same
                    gate as before. */}
                {isAdmin && (
                  <button
                    className={`sync-status-btn${syncing ? ' spinning' : ''}`}
                    onClick={handleSync}
                    disabled={syncing}
                    title={syncInfo.lastCommit ? `Git sync (commit + pull + push)\nLast synced: ${formatSyncTime(syncInfo.lastCommit)}\n${syncInfo.remoteUrl || ''}` : 'Git sync (commit + pull + push)'}
                    aria-label="Git sync"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
                    <span>Sync</span>
                  </button>
                )}
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
            {onNewNote && <button className="sidebar-action-btn" onClick={onNewNote} title={`New note ${createHint}`}>+ Note</button>}
            {onNewDrawing && <button className="sidebar-action-btn" onClick={onNewDrawing} title={`New drawing ${createHint}`}>+ Drawing</button>}
            {onNewFolder && <button className="sidebar-action-btn" onClick={onNewFolder} title={`New folder ${createHint}`}>+ Folder</button>}
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

        {/* The task board is a namespace-level destination, not a way of
            viewing the open file, so it belongs with the namespace and its
            tree rather than in the toolbar's Basic/Live control — those are
            mutually exclusive editor modes for one note, and mixing the two
            axes in one segmented control made all three buttons read as the
            same kind of choice. */}
        {onOpenBoard && (
          <div className="sidebar-board">
            <button
              className={`sidebar-board-btn${boardActive ? ' active' : ''}`}
              onClick={onOpenBoard}
              title={boardActive ? 'Close the task board and go back to your note' : 'Namespace task board'}
              aria-pressed={!!boardActive}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
              <span>Task Board</span>
            </button>
          </div>
        )}

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
          {/* The namespace root, as a real row.
              Selecting a folder aims "+ Note"/"+ Drawing"/"+ Folder" at it, and
              that stuck: there was no way back to the top level short of
              opening a root file, and no visible drop target for the root
              either — the only one was whatever blank space happened to be left
              under the tree, which is none once the tree fills the panel. This
              row is both: click it to create at the root, drop onto it to move
              something there. */}
          <div
            className={`tree-row tree-root-row${createDir === '' ? ' folder-target' : ''}${rootDragOver ? ' drag-over' : ''}`}
            style={{ '--tree-depth': 0 }}
            onClick={() => onPickFolder && onPickFolder('')}
            title={`${selectedNs || 'Namespace'} root — new items are created here`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setRootDragOver(true); }}
            onDragLeave={() => setRootDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setRootDragOver(false);
              try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                // Already at the root? Nothing to do.
                if (data.path && data.path.includes('/') && onDrop) onDrop(data.path, '');
              } catch (err) { /* ignore */ }
            }}
          >
            <span className="tree-arrow-spacer" />
            <span className="tree-icon-svg folder-open" />
            {/* Labelled "root", not the namespace name: the header already
                shows the namespace two rows above, so repeating it here is
                redundant and makes the same text appear twice in the sidebar.
                The namespace is named in the row's tooltip instead. */}
            <span className="tree-label">root</span>
          </div>
          {Array.isArray(filteredTree) && filteredTree.map((node) => (
            <TreeNode
              key={node.path || node.name}
              node={node}
              onSelect={onSelect}
              currentPath={currentPath}
              depth={0}
              onContextMenu={onContextMenu}
              onDrop={onDrop}
              expandedPaths={expandedPaths}
              onToggleExpand={toggleExpand}
              forceExpand={!!searchQuery.trim()}
              pickedFolder={pickedFolder}
              onPickFolder={onPickFolder}
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
        <div className="sidebar-server-info" ref={versionInfoRef}>
          <span>{window.location.host}</span>
          {serverVersion && (
            <span className="sidebar-version">
              v{serverVersion}
              {serverCommit ? ` · ${serverCommit}` : ''}
              <button
                type="button"
                className={`version-info-btn${updateAvailableVersion ? ' has-update' : ''}`}
                onClick={() => setShowVersionInfo((v) => !v)}
                title={updateAvailableVersion ? `Update available: v${updateAvailableVersion}` : 'Build details'}
                aria-label={updateAvailableVersion ? `Update available: v${updateAvailableVersion}. Show build details` : 'Build details'}
                aria-expanded={showVersionInfo}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </button>
            </span>
          )}
          {showVersionInfo && (
            <div className="version-info-popover" role="dialog" aria-label="Build details">
              <div className="version-info-row"><span>Version</span><strong>v{serverVersion}</strong></div>
              {serverCommit && serverCommit !== 'dev' && (
                <div className="version-info-row">
                  <span>Commit</span>
                  <a href={`https://github.com/mahsanamin/mdnest/commit/${serverCommit}`} target="_blank" rel="noreferrer"><code>{serverCommit}</code></a>
                </div>
              )}
              {serverBuildTime && serverBuildTime !== 'dev' && serverBuildTime !== 'unknown' && (
                <div className="version-info-row"><span>Built</span><strong title={serverBuildTime}>{formatBuildTime(serverBuildTime)}</strong></div>
              )}
              {updateAvailableVersion && onShowReleaseNotes && (
                <button
                  type="button"
                  className="version-info-update"
                  onClick={() => { setShowVersionInfo(false); onShowReleaseNotes(); }}
                >
                  ↑ v{updateAvailableVersion} available — see what’s new
                </button>
              )}
            </div>
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
