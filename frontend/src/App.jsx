import { useState, useEffect, useCallback } from 'react';
import Login from './components/Login.jsx';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import Editor from './components/Editor.jsx';
import Preview from './components/Preview.jsx';
import ContextMenu from './components/ContextMenu.jsx';
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
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0, target: null });
  const [initialized, setInitialized] = useState(false);

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

  // On auth, load namespaces and restore state from URL hash
  useEffect(() => {
    if (!authenticated) return;
    loadNamespaces().then((nsList) => {
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
          // Will be opened after tree loads
          setCurrentPath(hashPath);
        }
      }
      setInitialized(true);
    });
  }, [authenticated, loadNamespaces]);

  // When namespace changes, load tree and open note from URL if needed
  useEffect(() => {
    if (!authenticated || !selectedNs || !initialized) return;

    refreshTree(selectedNs).then(() => {
      // If currentPath is set (from URL restore), open it
      if (currentPath) {
        getNote(selectedNs, currentPath).then((text) => {
          setContent(text);
          setSavedContent(text);
        }).catch(() => {
          // File doesn't exist, clear
          setCurrentPath(null);
          setContent('');
          setSavedContent('');
          setHash(selectedNs, null);
        });
      }
    });

    // Update URL when namespace changes (without path if we're switching)
    if (!currentPath) {
      setHash(selectedNs, null);
    }
  }, [authenticated, selectedNs, initialized]);

  // Update URL hash whenever ns or path changes
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
      const text = await getNote(ns, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
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
      const text = await getNote(selectedNs, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
      setSidebarVisible(false);
    } catch (e) {
      console.error('Failed to open note:', e);
    }
  }, [selectedNs]);

  const handleContentChange = useCallback((newContent) => {
    setContent(newContent);
    if (saveTimer) clearTimeout(saveTimer);
    const timer = setTimeout(async () => {
      if (currentPath && selectedNs) {
        try {
          await saveNote(selectedNs, currentPath, newContent);
          setSavedContent(newContent);
        } catch (e) {
          console.error('Auto-save failed:', e);
        }
      }
    }, 800);
    setSaveTimer(timer);
  }, [currentPath, selectedNs, saveTimer]);

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
      // Toolbar buttons with no target → always create at root
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
    }
  }, [selectedNs, currentPath, refreshTree, doCreateNote, doCreateFolder]);

  const handleTreeDrop = useCallback(async (fromPath, toFolderPath) => {
    if (!selectedNs) return;
    const fileName = fromPath.split('/').pop();
    const newPath = toFolderPath ? toFolderPath + '/' + fileName : fileName;
    if (fromPath === newPath) return;
    try {
      await moveItem(selectedNs, fromPath, newPath);
      // Update currentPath if the moved item was open
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

  if (!authenticated) {
    return <Login onLogin={() => setAuthenticated(true)} />;
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
        onDrop={handleTreeDrop}
        visible={sidebarVisible}
        onClose={() => setSidebarVisible(false)}
      />
      <div className="main">
        <Toolbar
          currentPath={currentPath}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          onNewNote={() => doCreateNote(null)}
          onNewFolder={() => doCreateFolder(null)}
        />
        <div className="split-view">
          {currentPath ? (
            <>
              <div className={`editor-wrapper${mobileView === 'editor' ? ' mobile-active' : ''}`}>
                <Editor content={content} onChange={handleContentChange} currentPath={currentPath} ns={selectedNs} />
              </div>
              <div className={`preview-wrapper${mobileView === 'preview' ? ' mobile-active' : ''}`}>
                <Preview content={content} currentPath={currentPath} ns={selectedNs} onCheckboxToggle={handleCheckboxToggle} />
              </div>
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
      <ContextMenu visible={ctxMenu.visible} x={ctxMenu.x} y={ctxMenu.y} target={ctxMenu.target} onAction={handleContextAction} onClose={handleCloseContextMenu} />
    </div>
  );
}

export default App;
