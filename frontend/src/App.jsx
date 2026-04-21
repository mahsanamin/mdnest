import { useState, useEffect, useCallback, useRef } from 'react';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import { lazy, Suspense } from 'react';
import Editor from './components/Editor.jsx';
const LiveEditor = lazy(() => import('./components/LiveEditor.jsx'));
import Preview from './components/Preview.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import Settings from './components/Settings.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import PresenceBar from './components/PresenceBar.jsx';
import CommentSidebar from './components/CommentSidebar.jsx';
import ShareDialog from './components/ShareDialog.jsx';
import CollabClient from './collab.js';
import {
  getToken,
  getNote,
  listComments,
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
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [savedContent, setSavedContent] = useState('');
  const saveTimerRef = useRef(null);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [mobileView, setMobileView] = useState(() => {
    const saved = localStorage.getItem('mdnest_mobile_view');
    if (saved) return saved;
    const vm = localStorage.getItem('mdnest_view_mode');
    if (vm === 'preview') return 'preview';
    return 'editor';
  });
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  // Track screen width changes for responsive rendering
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('mdnest_view_mode') || 'editor');
  const [editorMode, setEditorMode] = useState('live');
  const [editorModeReady, setEditorModeReady] = useState(false);

  // Helper: get/set per-file preferences from localStorage
  const getFilePrefs = useCallback((ns, path) => {
    if (!ns || !path) return null;
    try {
      const key = `mdnest_file_prefs:${ns}/${path}`;
      return JSON.parse(localStorage.getItem(key));
    } catch { return null; }
  }, []);

  const setFilePrefs = useCallback((ns, path, prefs) => {
    if (!ns || !path) return;
    const key = `mdnest_file_prefs:${ns}/${path}`;
    const existing = getFilePrefs(ns, path) || {};
    localStorage.setItem(key, JSON.stringify({ ...existing, ...prefs }));
  }, [getFilePrefs]);
  const [splitRatio, setSplitRatio] = useState(50);
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0, target: null });
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [comments, setComments] = useState([]);
  const [showComments, setShowComments] = useState(false);
  const [pendingCommentSelection, setPendingCommentSelection] = useState(null);
  const [highlightedCommentId, setHighlightedCommentId] = useState(null);
  const goToCommentRef = useRef(null);
  const editorWrapperRef = useRef(null);
  const previewWrapperRef = useRef(null);
  const scrollSyncRef = useRef(false);
  const scrollPositions = useRef({}); // {ns/path: scrollPercent}
  const [shareTarget, setShareTarget] = useState(null); // {namespace, path}
  const [initialized, setInitialized] = useState(false);
  const contentRef = useRef(content);
  const savedContentRef = useRef(savedContent);
  const selectedNsRef = useRef(selectedNs);
  const currentPathRef = useRef(currentPath);
  contentRef.current = content;
  savedContentRef.current = savedContent;
  selectedNsRef.current = selectedNs;
  currentPathRef.current = currentPath;

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
  const [updateAvailable, setUpdateAvailable] = useState(null); // {current, latest}
  const [wsStatus, setWsStatus] = useState('disconnected'); // 'connected' | 'connecting' | 'disconnected'
  const etagRef = useRef(null);
  const collabRef = useRef(null);
  const typingTimers = useRef({}); // {userId: timeoutId}
  const localTypingUntil = useRef(0); // timestamp — local user is "typing" until this time
  const pollPathRef = useRef(null); // tracks current file for stale poll detection
  const treeRefreshTimer = useRef(null); // debounce for tree-changed events

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
    fetchConfig().then(setAppConfig).catch(() => setAppConfig({ authMode: 'single' }));
  }, []);

  // Version check: poll /api/config every 60s, compare server version vs build version
  useEffect(() => {
    const buildVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
    if (!buildVersion) return;
    const check = async () => {
      try {
        const cfg = await fetchConfig();
        if (cfg.version && cfg.version !== buildVersion) {
          setUpdateAvailable({ current: buildVersion, latest: cfg.version });
        }
      } catch {}
    };
    const interval = setInterval(check, 60000);
    // Also check once after 5s (catches updates during active sessions)
    const initial = setTimeout(check, 5000);
    return () => { clearInterval(interval); clearTimeout(initial); };
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
          // Apply remote content ONLY if local user is idle (no unsaved changes and not typing)
          if (Date.now() < localTypingUntil.current || (contentRef.current || '').trim() !== (savedContentRef.current || '').trim()) {
            // Local user has edits — don't overwrite. They'll sync via save + file-changed.
            break;
          }
          setContent(msg.content);
          setSavedContent(msg.content);
          break;
        case 'tree-changed':
          // Debounce tree refresh — multiple rapid tree-changed events
          // (e.g. bulk file operations) should only trigger one refresh
          if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current);
          treeRefreshTimer.current = setTimeout(() => {
            if (selectedNsRef.current) refreshTree(selectedNsRef.current);
          }, 1000);
          break;
        case 'access-changed':
          // Debounce — multiple grant changes in quick succession
          if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current);
          treeRefreshTimer.current = setTimeout(() => {
            loadNamespaces();
            fetchMe().then(setUserInfo).catch(() => {});
            if (selectedNsRef.current) refreshTree(selectedNsRef.current);
          }, 1000);
          break;
        case 'file-changed':
          // Another user saved — update etag and reload if no local edits
          etagRef.current = msg.etag;
          if ((contentRef.current || '').trim() === (savedContentRef.current || '').trim()) {
            setConflictBanner(null);
            // Use refs for current namespace/path
            const ns = selectedNsRef.current;
            const path = currentPathRef.current;
            if (ns && path) {
              getNote(ns, path).then(({ text, etag }) => {
                // Verify user hasn't switched files while getNote was in flight
                if (selectedNsRef.current === ns && currentPathRef.current === path) {
                  setContent(text);
                  setSavedContent(text);
                  etagRef.current = etag;
                }
              }).catch(() => {});
            }
          } else {
            setConflictBanner({ username: msg.username, etag: msg.etag });
          }
          break;
      }
    }, setWsStatus);
    collabRef.current = client;
    return () => { client.disconnect(); collabRef.current = null; setWsStatus('disconnected'); };
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
        listComments(selectedNs, currentPath).then(setComments).catch(() => setComments([]));
      }
    });

    if (!currentPath) {
      setHash(selectedNs, null);
    }
  }, [authenticated, selectedNs, initialized]);

  // Auto-refresh: poll the current note every 60s as fallback for external changes
  // (CLI, git-sync). WebSocket file-changed handles real-time updates.
  useEffect(() => {
    if (!authenticated || !selectedNs || !currentPath) return;
    const myPollKey = `${selectedNs}/${currentPath}`;
    pollPathRef.current = myPollKey;

    const interval = setInterval(async () => {
      try {
        const { text: remote, etag } = await getNote(selectedNs, currentPath);

        // STALE CHECK: if user switched files while getNote was in flight, discard
        if (pollPathRef.current !== myPollKey) return;

        if (remote === savedContentRef.current) return; // no change

        if (contentRef.current === savedContentRef.current) {
          // No local unsaved changes — silently update
          setContent(remote);
          setSavedContent(remote);
          etagRef.current = etag;
        } else {
          // User has unsaved changes AND file changed externally — show conflict
          etagRef.current = etag;
          setConflictBanner({ username: 'an external source' });
        }
      } catch (e) {
        // Transient errors — skip silently
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [authenticated, selectedNs, currentPath]);

  // Auto-refresh tree every 15s to pick up new/deleted files from CLI, git, etc.
  // Tree refresh is handled by WebSocket tree-changed events.
  // No polling needed — saves server load with many users.

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

  // Find all scrollable elements in the editor/preview area
  const getScrollables = useCallback(() => {
    const els = [];
    if (editorWrapperRef.current) {
      const ta = editorWrapperRef.current.querySelector('.editor-textarea');
      if (ta) els.push(ta);
      const live = editorWrapperRef.current.querySelector('.live-editor-wrapper');
      if (live) els.push(live);
    }
    if (previewWrapperRef.current) {
      const pv = previewWrapperRef.current.querySelector('.preview-pane');
      if (pv) els.push(pv);
    }
    return els;
  }, []);

  // Save scroll position — debounced, persisted to localStorage via file prefs
  const saveScrollDebounce = useRef(null);
  const saveScrollPos = useCallback(() => {
    if (!selectedNs || !currentPath) return;
    if (saveScrollDebounce.current) clearTimeout(saveScrollDebounce.current);
    saveScrollDebounce.current = setTimeout(() => {
      const els = getScrollables();
      for (const el of els) {
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (maxScroll > 10) {
          const pct = el.scrollTop / maxScroll;
          scrollPositions.current[`${selectedNs}/${currentPath}`] = pct;
          setFilePrefs(selectedNs, currentPath, { scrollPct: pct });
          break; // save from the first scrollable element
        }
      }
    }, 200);
  }, [selectedNs, currentPath, getScrollables, setFilePrefs]);

  // Attach scroll listeners — re-attach when view/editor mode changes
  useEffect(() => {
    if (!selectedNs || !currentPath) return;
    const handler = () => saveScrollPos();
    let timer = setTimeout(() => {
      getScrollables().forEach((el) => {
        el.addEventListener('scroll', handler, { passive: true });
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      getScrollables().forEach((el) => {
        el.removeEventListener('scroll', handler);
      });
    };
  }, [selectedNs, currentPath, viewMode, editorMode, getScrollables, saveScrollPos]);

  // Restore scroll position when opening a document
  const restoreScrollPosition = useCallback((ns, path) => {
    // Try in-memory first (fastest), then localStorage
    const key = `${ns}/${path}`;
    let pct = scrollPositions.current[key];
    if (pct == null) {
      const prefs = getFilePrefs(ns, path);
      pct = prefs?.scrollPct;
    }
    if (pct == null || pct === 0) return;

    let attempts = 0;
    const tryRestore = () => {
      const els = getScrollables();
      let restored = false;
      els.forEach((el) => {
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (maxScroll > 10) {
          el.scrollTop = pct * maxScroll;
          restored = true;
        }
      });
      if (!restored && attempts < 15) {
        attempts++;
        setTimeout(tryRestore, 200);
      }
    };
    setTimeout(tryRestore, 200);
  }, [getScrollables, getFilePrefs]);

  const openNoteDirect = useCallback(async (ns, path) => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    try {
      const { text, etag } = await getNote(ns, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
      restoreScrollPosition(ns, path);
      listComments(ns, path).then(setComments).catch(() => setComments([]));
    } catch (e) {
      console.error('Failed to open note:', e);
    }
  }, [restoreScrollPosition]);

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
    // Clear any pending save timer from the previous file
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    try {
      const { text, etag } = await getNote(selectedNs, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
      setConflictBanner(null);
      setSidebarVisible(false);
      restoreScrollPosition(selectedNs, path);
      // Load comments for this note
      listComments(selectedNs, path).then(setComments).catch(() => setComments([]));
    } catch (e) {
      if (e.name === 'PermissionError') {
        alert('Access denied: you do not have permission to read this file.');
      } else {
        console.error('Failed to open note:', e);
      }
    }
  }, [selectedNs]);

  const refreshComments = useCallback(() => {
    if (selectedNs && currentPath) {
      listComments(selectedNs, currentPath).then(setComments).catch(() => setComments([]));
    }
  }, [selectedNs, currentPath]);

  const handleContentChange = useCallback((newContent) => {
    setContent(newContent);
    setConflictBanner(null);

    // Mark local user as typing — blocks remote content from overwriting
    localTypingUntil.current = Date.now() + 1500;

    // Broadcast content to other users via WebSocket (live typing)
    if (collabRef.current) collabRef.current.sendContent(newContent);

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
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
    saveTimerRef.current = timer;
  }, [currentPath, selectedNs]);

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
      case 'copy-path': {
        if (target && selectedNs) {
          const alias = appConfig?.serverAlias ? `@${appConfig.serverAlias}/` : '';
          const fullPath = `mdnest://${alias}${selectedNs}/${target.path}`;
          const textarea = document.createElement('textarea');
          textarea.value = fullPath;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
        break;
      }
      case 'manage-access': {
        if (selectedNs) {
          const folderPath = target?.path ? '/' + target.path : '/';
          setShareTarget({ namespace: selectedNs, path: folderPath });
        }
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

  // Scroll sync: editor scroll → preview scroll (proportional)
  useEffect(() => {
    if (viewMode !== 'split') return;
    const findScrollable = (wrapper) => {
      if (!wrapper) return null;
      // Find the actual scrollable element inside the wrapper
      const textarea = wrapper.querySelector('.editor-textarea');
      if (textarea) return textarea;
      const liveContent = wrapper.querySelector('.live-editor-wrapper');
      if (liveContent) return liveContent;
      return wrapper;
    };

    const editorEl = findScrollable(editorWrapperRef.current);
    const previewPane = previewWrapperRef.current?.querySelector('.preview-pane');
    if (!editorEl || !previewPane) return;

    const syncEditorToPreview = () => {
      if (scrollSyncRef.current) return;
      scrollSyncRef.current = true;
      const pct = editorEl.scrollTop / (editorEl.scrollHeight - editorEl.clientHeight || 1);
      previewPane.scrollTop = pct * (previewPane.scrollHeight - previewPane.clientHeight);
      requestAnimationFrame(() => { scrollSyncRef.current = false; });
    };

    const syncPreviewToEditor = () => {
      if (scrollSyncRef.current) return;
      scrollSyncRef.current = true;
      const pct = previewPane.scrollTop / (previewPane.scrollHeight - previewPane.clientHeight || 1);
      editorEl.scrollTop = pct * (editorEl.scrollHeight - editorEl.clientHeight);
      requestAnimationFrame(() => { scrollSyncRef.current = false; });
    };

    editorEl.addEventListener('scroll', syncEditorToPreview);
    previewPane.addEventListener('scroll', syncPreviewToEditor);
    return () => {
      editorEl.removeEventListener('scroll', syncEditorToPreview);
      previewPane.removeEventListener('scroll', syncPreviewToEditor);
    };
  }, [viewMode, currentPath, editorMode]);

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
    return <Login onLogin={() => window.location.reload()} />;
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
        onRefreshTree={handleRefresh}
        isAdmin={isAdmin}
        serverVersion={appConfig?.version}
        width={sidebarWidth}
        onResize={setSidebarWidth}
      />
      <div className="main">
        <Toolbar
          currentPath={currentPath}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          onChangePassword={() => setShowChangePassword(true)}
          onRename={canWriteCurrent ? handleToolbarRename : null}
          onDelete={canWriteCurrent ? handleToolbarDelete : null}
          viewMode={viewMode}
          onViewModeChange={(mode) => {
            setViewMode(mode);
            localStorage.setItem('mdnest_view_mode', mode);
            // Restore editor mode from user preference when switching to editor-only
            if (mode === 'editor') {
              const saved = localStorage.getItem('mdnest_editor_mode') || 'live';
              setEditorMode(saved);
            }
            if (selectedNs && currentPath) {
              restoreScrollPosition(selectedNs, currentPath);
            }
          }}
          editorMode={editorMode}
          onEditorModeChange={(mode) => {
            setEditorMode(mode);
            localStorage.setItem('mdnest_editor_mode', mode);
            if (selectedNs && currentPath) {
              restoreScrollPosition(selectedNs, currentPath);
            }
          }}
          onRefresh={handleRefresh}
          commentCount={comments.filter(c => !c.parentId && !c.resolved).length}
          onToggleComments={() => {
            const next = !showComments;
            setShowComments(next);
            // When opening comments, snap the user to Live editor — that's
            // the only surface where highlights render, selection → Comment
            // works, and Go To can scroll to the text.
            if (next) {
              if (viewMode === 'preview') {
                setViewMode('editor');
                localStorage.setItem('mdnest_view_mode', 'editor');
              }
              if (editorMode !== 'live') {
                setEditorMode('live');
                localStorage.setItem('mdnest_editor_mode', 'live');
              }
              if (isMobile && mobileView === 'preview') {
                setMobileView('editor');
                localStorage.setItem('mdnest_mobile_view', 'editor');
              }
            }
          }}
          wsStatus={appConfig?.liveCollab ? wsStatus : null}
        />
        {appConfig?.liveCollab && presenceUsers.length > 1 && (
          <PresenceBar users={presenceUsers} currentUserId={userInfo?.id} typingUsers={typingUsers} />
        )}
        {updateAvailable && (
          <div className="update-banner">
            New version available: <strong>v{updateAvailable.current}</strong> → <strong>v{updateAvailable.latest}</strong>
            <button onClick={() => window.location.reload(true)}>Refresh Now</button>
          </div>
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
              <div className="mobile-view-toggle">
                <button className={mobileView === 'editor' ? 'active' : ''} onClick={() => { setMobileView('editor'); localStorage.setItem('mdnest_mobile_view', 'editor'); }}>Edit</button>
                <button className={mobileView === 'preview' ? 'active' : ''} onClick={() => { setMobileView('preview'); localStorage.setItem('mdnest_mobile_view', 'preview'); }}>Preview</button>
              </div>
              {(isMobile ? mobileView === 'editor' : viewMode !== 'preview') && (
                <div
                  ref={editorWrapperRef}
                  className={`editor-wrapper${mobileView === 'editor' ? ' mobile-active' : ''}`}
                  style={!isMobile && viewMode === 'split' ? { flex: `0 0 ${splitRatio}%` } : undefined}
                >
                  {editorMode === 'live' ? (
                    <Suspense fallback={<div className="editor-loading">Loading live editor...</div>}>
                      <LiveEditor
                        content={content}
                        onChange={canWriteCurrent ? handleContentChange : null}
                        currentPath={currentPath}
                        ns={selectedNs}
                        readOnly={!canWriteCurrent}
                        comments={comments}
                        onComment={(sel) => {
                          setPendingCommentSelection(sel);
                          setShowComments(true);
                        }}
                        onGoToReady={(fn) => { goToCommentRef.current = fn; }}
                        onHighlightClick={(commentId) => {
                          setShowComments(true);
                          setHighlightedCommentId(commentId);
                          if (viewMode === 'preview') {
                            setViewMode('editor');
                            localStorage.setItem('mdnest_view_mode', 'editor');
                          }
                        }}
                      />
                    </Suspense>
                  ) : (
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
                  )}
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
              {(isMobile ? mobileView === 'preview' : viewMode !== 'editor') && (
                <div
                  ref={previewWrapperRef}
                  className={`preview-wrapper${mobileView === 'preview' ? ' mobile-active' : ''}`}
                  style={!isMobile && viewMode === 'split' ? { flex: `0 0 ${100 - splitRatio}%` } : undefined}
                >
                  <Preview content={content} currentPath={currentPath} ns={selectedNs} onCheckboxToggle={canWriteCurrent ? handleCheckboxToggle : null} />
                </div>
              )}
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
      {shareTarget && (
        <ShareDialog
          namespace={shareTarget.namespace}
          path={shareTarget.path}
          onClose={() => setShareTarget(null)}
        />
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
        selectedNs={selectedNs}
      />
      {showComments && currentPath && (
        <CommentSidebar
          comments={comments}
          ns={selectedNs}
          currentPath={currentPath}
          onRefresh={refreshComments}
          onClose={() => { setShowComments(false); setPendingCommentSelection(null); }}
          userInfo={userInfo}
          pendingSelection={pendingCommentSelection}
          onSelectionConsumed={() => setPendingCommentSelection(null)}
          onGoTo={(c) => { if (goToCommentRef.current) goToCommentRef.current(c); }}
          highlightedId={highlightedCommentId}
          onHighlightConsumed={() => setHighlightedCommentId(null)}
        />
      )}
    </div>
  );
}

export default App;
