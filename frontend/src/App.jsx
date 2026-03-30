import { useState, useEffect, useCallback, useRef } from 'react';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import Editor from './components/Editor.jsx';
import Preview from './components/Preview.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import Settings from './components/Settings.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import PresenceBar from './components/PresenceBar.jsx';
import CollabClient from './collab.js';
import {
  getToken,
  getNote,
  saveNote,
  getTree,
  getNamespaces,
  createNote,
  createFolder,
  deleteNote,
  moveItem,
  fetchConfig,
  fetchMe,
  logout,
  PermissionError,
} from './api.js';
import './App.css';

// URL helpers: store ns and path in hash like #ns/path/to/note.md
function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash) return { ns: null, path: null };
  const slashIdx = hash.indexOf('/');
  if (slashIdx === -1) return { ns: decodeURIComponent(hash), path: null };
  return {
    ns: decodeURIComponent(hash.substring(0, slashIdx)),
    path: decodeURIComponent(hash.substring(slashIdx + 1)) || null,
  };
}

function setHash(ns, path) {
  let hash = '';
  if (ns) {
    hash = encodeURIComponent(ns);
    if (path) hash += '/' + path.split('/').map(encodeURIComponent).join('/');
  }
  window.history.replaceState(null, '', '#' + hash);
}

function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [namespaces, setNamespaces] = useState([]);
  const [selectedNs, setSelectedNs] = useState(null);
  const [tree, setTree] = useState([]);
  const [currentPath, setCurrentPath] = useState(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [saveTimer, setSaveTimer] = useState(null);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [mobileView, setMobileView] = useState('editor');
  const [viewMode, setViewMode] = useState('split');
  const [splitRatio, setSplitRatio] = useState(50);
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0, target: null });
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const contentRef = useRef(content);
  const savedContentRef = useRef(savedContent);
  contentRef.current = content;
  savedContentRef.current = savedContent;

  // Multi-user state
  const [appConfig, setAppConfig] = useState(null); // {authMode, version, liveCollab}
  const [userInfo, setUserInfo] = useState(null); // {id, username, role, grants}
  const isMulti = appConfig?.authMode === 'multi';
  const isAdmin = !isMulti || userInfo?.role === 'admin';

  // Live collaboration state
  const [presenceUsers, setPresenceUsers] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [typingUsers, setTypingUsers] = useState({}); // {userId: username}
  const [conflictBanner, setConflictBanner] = useState(null); // {username, etag}
  const etagRef = useRef(null);
  const collabRef = useRef(null);
  const typingTimers = useRef({}); // {userId: timeoutId}

  // Determine write access for current namespace/path
  const canWrite = useCallback((path) => {
    if (!isMulti) return true;
    if (!userInfo) return false;
    if (userInfo.role === 'admin') return true;
    if (!userInfo.grants || !selectedNs) return false;
    const checkPath = path ? '/' + path : '/';
    for (const g of userInfo.grants) {
      if (g.namespace !== selectedNs) continue;
      if (g.permission !== 'write') continue;
      if (g.path === '/') return true;
      if (checkPath === g.path || checkPath.startsWith(g.path + '/')) return true;
    }
    return false;
  }, [isMulti, userInfo, selectedNs]);

  const canWriteCurrent = canWrite(currentPath);

  // Fetch app config on mount (before auth)
  useEffect(() => {
    fetchConfig().then(setAppConfig).catch(() => setAppConfig({ authMode: 'single', version: '1.0' }));
  }, []);

  // Initialize collab client
  useEffect(() => {
    if (!appConfig?.liveCollab) return;
    const client = new CollabClient((msg) => {
      switch (msg.type) {
        case 'presence':
          setPresenceUsers(msg.users || []);
          break;
        case 'cursor':
          setRemoteCursors((prev) => ({ ...prev, [msg.userId]: { ...msg, type: 'cursor' } }));
          break;
        case 'selection':
          setRemoteCursors((prev) => ({ ...prev, [msg.userId]: { ...msg, type: 'selection' } }));
          break;
        case 'leave':
          setRemoteCursors((prev) => { const n = { ...prev }; delete n[msg.userId]; return n; });
          setTypingUsers((prev) => { const n = { ...prev }; delete n[msg.userId]; return n; });
          setPresenceUsers((prev) => prev.filter((u) => u.id !== msg.userId));
          break;
        case 'content':
          // Mark user as typing
          setTypingUsers((prev) => ({ ...prev, [msg.userId]: msg.username }));
          // Clear typing after 2s of silence
          if (typingTimers.current[msg.userId]) clearTimeout(typingTimers.current[msg.userId]);
          typingTimers.current[msg.userId] = setTimeout(() => {
            setTypingUsers((prev) => { const n = { ...prev }; delete n[msg.userId]; return n; });
          }, 2000);
          // Apply their content live if we have no local unsaved changes
          if (contentRef.current === savedContentRef.current) {
            setContent(msg.content);
            setSavedContent(msg.content);
          }
          break;
        case 'file-changed':
          // Another user saved — update our saved baseline
          etagRef.current = msg.etag;
          if (contentRef.current === savedContentRef.current) {
            // No local unsaved changes — silently accept
            setConflictBanner(null);
          } else {
            setConflictBanner({ username: msg.username, etag: msg.etag });
          }
          break;
      }
    });
    collabRef.current = client;
    return () => { client.disconnect(); collabRef.current = null; };
  }, [appConfig?.liveCollab]);

  // Connect/disconnect collab when note changes
  useEffect(() => {
    if (!collabRef.current || !selectedNs || !currentPath) {
      if (collabRef.current) collabRef.current.disconnect();
      setPresenceUsers([]);
      setRemoteCursors({});
      setConflictBanner(null);
      return;
    }
    collabRef.current.connect(selectedNs, currentPath);
    setPresenceUsers([]);
    setRemoteCursors({});
    setTypingUsers({});
    setConflictBanner(null);
  }, [selectedNs, currentPath]);

  const loadNamespaces = useCallback(async () => {
    try {
      const data = await getNamespaces();
      setNamespaces(data);
      return data;
    } catch (e) {
      console.error('Failed to load namespaces:', e);
      return [];
    }
  }, []);

  const refreshTree = useCallback(async (ns) => {
    const target = ns || selectedNs;
    if (!target) return;
    try {
      const data = await getTree(target);
      setTree(data.children || []);
    } catch (e) {
      console.error('Failed to load file tree:', e);
    }
  }, [selectedNs]);

  // On auth, load namespaces (and user info in multi mode), restore from URL
  useEffect(() => {
    if (!authenticated) return;

    const init = async () => {
      // Fetch user info in multi mode
      if (isMulti) {
        const me = await fetchMe().catch(() => null);
        setUserInfo(me);
      }

      const nsList = await loadNamespaces();
      const { ns: hashNs, path: hashPath } = parseHash();
      let targetNs = null;

      if (hashNs && nsList.includes(hashNs)) {
        targetNs = hashNs;
      } else if (nsList.length > 0) {
        targetNs = nsList[0];
      }

      if (targetNs) {
        setSelectedNs(targetNs);
        if (hashPath && hashNs === targetNs) {
          setCurrentPath(hashPath);
        }
      }
      setInitialized(true);
    };

    init();
  }, [authenticated, loadNamespaces, isMulti]);

  // When namespace changes, load tree and open note from URL if needed
  useEffect(() => {
    if (!authenticated || !selectedNs || !initialized) return;

    refreshTree(selectedNs).then(() => {
      if (currentPath) {
        getNote(selectedNs, currentPath).then(({ text, etag }) => {
          setContent(text);
          setSavedContent(text);
          etagRef.current = etag;
        }).catch(() => {
          setCurrentPath(null);
          setContent('');
          setSavedContent('');
          setHash(selectedNs, null);
        });
      }
    });

    if (!currentPath) {
      setHash(selectedNs, null);
    }
  }, [authenticated, selectedNs, initialized]);

  // Auto-refresh: poll the current note every 30s
  useEffect(() => {
    if (!authenticated || !selectedNs || !currentPath) return;
    const interval = setInterval(async () => {
      try {
        const { text: remote, etag } = await getNote(selectedNs, currentPath);
        if (contentRef.current === savedContentRef.current && remote !== savedContentRef.current) {
          setContent(remote);
          setSavedContent(remote);
          etagRef.current = etag;
          refreshTree(selectedNs);
        }
      } catch (e) {
        // Transient errors — skip silently
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [authenticated, selectedNs, currentPath, refreshTree]);

  // Update URL hash
  useEffect(() => {
    if (selectedNs) {
      setHash(selectedNs, currentPath);
    }
  }, [selectedNs, currentPath]);

  // Handle browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const { ns, path } = parseHash();
      if (ns && ns !== selectedNs) {
        setSelectedNs(ns);
      }
      if (path !== currentPath) {
        if (path && ns) {
          openNoteDirect(ns, path);
        } else {
          setCurrentPath(null);
          setContent('');
          setSavedContent('');
        }
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [selectedNs, currentPath]);

  const openNoteDirect = useCallback(async (ns, path) => {
    try {
      const { text, etag } = await getNote(ns, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
    } catch (e) {
      console.error('Failed to open note:', e);
    }
  }, []);

  const handleSelectNs = useCallback((ns) => {
    setSelectedNs(ns);
    setCurrentPath(null);
    setContent('');
    setSavedContent('');
    setTree([]);
    setHash(ns, null);
  }, []);

  const openNote = useCallback(async (path) => {
    if (!selectedNs) return;
    try {
      const { text, etag } = await getNote(selectedNs, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
      setConflictBanner(null);
      setSidebarVisible(false);
    } catch (e) {
      if (e.name === 'PermissionError') {
        alert('Access denied: you do not have permission to read this file.');
      } else {
        console.error('Failed to open note:', e);
      }
    }
  }, [selectedNs]);

  const handleContentChange = useCallback((newContent) => {
    setContent(newContent);
    setConflictBanner(null);

    // Broadcast content to other users via WebSocket (live typing)
    if (collabRef.current) collabRef.current.sendContent(newContent);

    if (saveTimer) clearTimeout(saveTimer);
    const timer = setTimeout(async () => {
      if (currentPath && selectedNs) {
        try {
          const result = await saveNote(selectedNs, currentPath, newContent, etagRef.current);
          setSavedContent(newContent);
          if (result.etag) etagRef.current = result.etag;
        } catch (e) {
          if (e.status === 409) {
            setConflictBanner({ username: 'another user', etag: e.etag });
          } else if (e.name === 'PermissionError') {
            console.error('Save blocked: no write permission');
          } else {
            console.error('Auto-save failed:', e);
          }
        }
      }
    }, 800);
    setSaveTimer(timer);
  }, [currentPath, selectedNs, saveTimer]);

  // Send cursor position to collab
  const handleCursorChange = useCallback((line, ch) => {
    if (collabRef.current) collabRef.current.sendCursor(line, ch);
  }, []);

  const handleSelectionChange = useCallback((fromLine, fromCh, toLine, toCh) => {
    if (collabRef.current) collabRef.current.sendSelection(fromLine, fromCh, toLine, toCh);
  }, []);

  const handleCheckboxToggle = useCallback(async (lineIndex) => {
    const lines = content.split('\n');
    const line = lines[lineIndex];
    if (!line) return;
    if (line.includes('- [ ]')) {
      lines[lineIndex] = line.replace('- [ ]', '- [x]');
    } else if (line.includes('- [x]')) {
      lines[lineIndex] = line.replace('- [x]', '- [ ]');
    } else {
      return;
    }
    const newContent = lines.join('\n');
    setContent(newContent);
    setSavedContent(newContent);
    if (currentPath && selectedNs) {
      try {
        await saveNote(selectedNs, currentPath, newContent);
      } catch (e) {
        console.error('Checkbox save failed:', e);
      }
    }
  }, [content, currentPath, selectedNs]);

  const handleContextMenu = useCallback((x, y, target) => {
    setCtxMenu({ visible: true, x, y, target });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setCtxMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const getTargetDir = useCallback((target) => {
    if (!target) {
      return '';
    }
    if (target.type === 'folder') {
      const p = target.path || target.name;
      return p.replace(/\/$/, '') + '/';
    }
    const parts = (target.path || '').split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') + '/' : '';
  }, [currentPath]);

  const doCreateNote = useCallback(async (target) => {
    if (!selectedNs) return;
    let name = prompt('Note name (e.g. my-note.md):');
    if (!name) return;
    if (!name.endsWith('.md')) name += '.md';
    const dir = getTargetDir(target);
    const path = dir + name.replace(/^\/+/, '');
    try {
      await createNote(selectedNs, path);
      await refreshTree();
      openNote(path);
    } catch (e) {
      alert('Failed to create note: ' + e.message);
    }
  }, [selectedNs, getTargetDir, refreshTree, openNote]);

  const doCreateFolder = useCallback(async (target) => {
    if (!selectedNs) return;
    const name = prompt('Folder name:');
    if (!name) return;
    const dir = getTargetDir(target);
    const path = dir + name.replace(/^\/+/, '').replace(/\/+$/, '');
    try {
      await createFolder(selectedNs, path);
      await refreshTree();
    } catch (e) {
      alert('Failed to create folder: ' + e.message);
    }
  }, [selectedNs, getTargetDir, refreshTree]);

  const handleContextAction = useCallback(async (action, target) => {
    switch (action) {
      case 'new-note': await doCreateNote(target); break;
      case 'new-folder': await doCreateFolder(target); break;
      case 'delete-file': {
        if (!target || !selectedNs) return;
        if (!confirm(`Delete "${target.name || target.path}"?`)) return;
        try {
          await deleteNote(selectedNs, target.path);
          if (currentPath === target.path) { setCurrentPath(null); setContent(''); setSavedContent(''); }
          await refreshTree();
        } catch (e) { alert('Failed to delete: ' + e.message); }
        break;
      }
      case 'delete-folder': {
        if (!target || !selectedNs) return;
        if (!confirm(`Delete folder "${target.name || target.path}" and all its contents?`)) return;
        try {
          await deleteNote(selectedNs, target.path);
          if (currentPath && currentPath.startsWith(target.path)) { setCurrentPath(null); setContent(''); setSavedContent(''); }
          await refreshTree();
        } catch (e) { alert('Failed to delete folder: ' + e.message); }
        break;
      }
      case 'manage-access': {
        if (isAdmin && isMulti) setShowAdminPanel(true);
        break;
      }
      case 'rename': {
        if (!target || !selectedNs) return;
        const oldName = target.name || target.path.split('/').pop();
        const newName = prompt('Rename to:', oldName);
        if (!newName || newName === oldName) return;
        const parts = target.path.split('/');
        parts.pop();
        const newPath = parts.length > 0 ? parts.join('/') + '/' + newName : newName;
        try {
          await moveItem(selectedNs, target.path, newPath);
          if (currentPath === target.path) {
            setCurrentPath(newPath);
            setHash(selectedNs, newPath);
          } else if (currentPath && currentPath.startsWith(target.path + '/')) {
            const updated = newPath + currentPath.substring(target.path.length);
            setCurrentPath(updated);
            setHash(selectedNs, updated);
          }
          await refreshTree();
        } catch (e) { alert('Failed to rename: ' + e.message); }
        break;
      }
    }
  }, [selectedNs, currentPath, refreshTree, doCreateNote, doCreateFolder]);

  const handleTreeDrop = useCallback(async (fromPath, toFolderPath) => {
    if (!selectedNs) return;
    const fileName = fromPath.split('/').pop();
    const newPath = toFolderPath ? toFolderPath + '/' + fileName : fileName;
    if (fromPath === newPath) return;
    try {
      await moveItem(selectedNs, fromPath, newPath);
      if (currentPath === fromPath) {
        setCurrentPath(newPath);
        setHash(selectedNs, newPath);
      } else if (currentPath && currentPath.startsWith(fromPath + '/')) {
        const updated = newPath + currentPath.substring(fromPath.length);
        setCurrentPath(updated);
        setHash(selectedNs, updated);
      }
      await refreshTree();
    } catch (e) {
      alert('Failed to move: ' + e.message);
    }
  }, [selectedNs, currentPath, refreshTree]);

  const handleRefresh = useCallback(async () => {
    if (!authenticated || !selectedNs) return;
    await refreshTree(selectedNs);
    if (currentPath) {
      try {
        const { text, etag } = await getNote(selectedNs, currentPath);
        setContent(text);
        setSavedContent(text);
        etagRef.current = etag;
        setConflictBanner(null);
      } catch (e) {
        // Note may have been deleted
      }
    }
  }, [authenticated, selectedNs, currentPath, refreshTree]);

  // Reload note content (used by conflict banner)
  const handleReloadNote = useCallback(async () => {
    if (!selectedNs || !currentPath) return;
    try {
      const { text, etag } = await getNote(selectedNs, currentPath);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
      setConflictBanner(null);
    } catch (e) {
      console.error('Failed to reload:', e);
    }
  }, [selectedNs, currentPath]);

  const handleToolbarRename = useCallback(() => {
    if (!currentPath || !selectedNs) return;
    const name = currentPath.split('/').pop();
    handleContextAction('rename', { path: currentPath, name });
  }, [currentPath, selectedNs, handleContextAction]);

  const handleToolbarDelete = useCallback(() => {
    if (!currentPath || !selectedNs) return;
    const name = currentPath.split('/').pop();
    handleContextAction('delete-file', { path: currentPath, name });
  }, [currentPath, selectedNs, handleContextAction]);

  if (!authenticated) {
    return <Login onLogin={() => setAuthenticated(true)} />;
  }

  if (showAdminPanel && isAdmin && isMulti) {
    return <AdminPanel onClose={() => setShowAdminPanel(false)} namespaces={namespaces} />;
  }

  return (
    <div className="app">
      <Sidebar
        tree={tree}
        onSelect={openNote}
        currentPath={currentPath}
        namespaces={namespaces}
        selectedNs={selectedNs}
        onSelectNs={handleSelectNs}
        onContextMenu={handleContextMenu}
        onDrop={canWrite('') ? handleTreeDrop : null}
        visible={sidebarVisible}
        onClose={() => setSidebarVisible(false)}
        userInfo={isMulti ? userInfo : null}
        onLogout={logout}
        onAdminPanel={isAdmin && isMulti ? () => setShowAdminPanel(true) : null}
        onNewNote={canWrite('') ? () => doCreateNote(null) : null}
        onNewFolder={canWrite('') ? () => doCreateFolder(null) : null}
      />
      <div className="main">
        <Toolbar
          currentPath={currentPath}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          onChangePassword={() => setShowChangePassword(true)}
          onRename={canWriteCurrent ? handleToolbarRename : null}
          onDelete={canWriteCurrent ? handleToolbarDelete : null}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onRefresh={handleRefresh}
        />
        {appConfig?.liveCollab && presenceUsers.length > 1 && (
          <PresenceBar users={presenceUsers} currentUserId={userInfo?.id} typingUsers={typingUsers} />
        )}
        {conflictBanner && (
          <div className="conflict-banner">
            This file was modified by {conflictBanner.username}. Your changes may conflict.
            <button onClick={handleReloadNote}>Reload</button>
            <button onClick={() => setConflictBanner(null)}>Dismiss</button>
          </div>
        )}
        <div className="split-view">
          {currentPath ? (
            <>
              {viewMode !== 'preview' && (
                <div
                  className={`editor-wrapper${mobileView === 'editor' ? ' mobile-active' : ''}`}
                  style={viewMode === 'split' ? { flex: `0 0 ${splitRatio}%` } : undefined}
                >
                  <Editor
                    content={content}
                    onChange={canWriteCurrent ? handleContentChange : null}
                    currentPath={currentPath}
                    ns={selectedNs}
                    readOnly={!canWriteCurrent}
                    onCursorChange={appConfig?.liveCollab ? handleCursorChange : null}
                    onSelectionChange={appConfig?.liveCollab ? handleSelectionChange : null}
                    remoteCursors={appConfig?.liveCollab ? remoteCursors : null}
                  />
                </div>
              )}
              {viewMode === 'split' && (
                <div
                  className="split-divider"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const container = e.target.parentElement;
                    const onMove = (ev) => {
                      const rect = container.getBoundingClientRect();
                      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
                      setSplitRatio(Math.min(80, Math.max(20, pct)));
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
              {viewMode !== 'editor' && (
                <div
                  className={`preview-wrapper${mobileView === 'preview' ? ' mobile-active' : ''}`}
                  style={viewMode === 'split' ? { flex: `0 0 ${100 - splitRatio}%` } : undefined}
                >
                  <Preview content={content} currentPath={currentPath} ns={selectedNs} onCheckboxToggle={canWriteCurrent ? handleCheckboxToggle : null} />
                </div>
              )}
              <div className="mobile-view-toggle">
                <button className={mobileView === 'editor' ? 'active' : ''} onClick={() => setMobileView('editor')}>Edit</button>
                <button className={mobileView === 'preview' ? 'active' : ''} onClick={() => setMobileView('preview')}>Preview</button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <p>{namespaces.length === 0 ? 'No namespaces found. Check your mdnest.conf mounts.' : 'Select a note or create one to get started.'}</p>
            </div>
          )}
        </div>
      </div>
      {showChangePassword && (
        <Settings onClose={() => setShowChangePassword(false)} />
      )}
      <ContextMenu
        visible={ctxMenu.visible}
        x={ctxMenu.x}
        y={ctxMenu.y}
        target={ctxMenu.target}
        onAction={handleContextAction}
        onClose={handleCloseContextMenu}
        canWrite={canWrite}
        isAdmin={isAdmin && isMulti}
      />
    </div>
  );
}

export default App;
