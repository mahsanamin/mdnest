import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { parseRoute, formatRoute } from './hashRoute';
import { chatPathFor, isChatDoc } from './chat.js';
import Login from './components/Login.jsx';
import LoginFirebase from './components/LoginFirebase.jsx';
import LoginSSO from './components/LoginSSO.jsx';
import LoginDev from './components/LoginDev.jsx';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import { lazy, Suspense } from 'react';
import Editor from './components/Editor.jsx';
import EditorErrorBoundary from './components/EditorErrorBoundary.jsx';
import ChunkErrorBoundary from './components/ChunkErrorBoundary.jsx';
import { loadWithRetry } from './lazyWithRetry.js';
import { createPresenceHold } from './presence-hold.js';
// Live (rich) editor — Crepe-based since v3.10.0. Lazy-loaded so the
// ~217 KB-gzipped chunk only downloads when the user actually opens
// Live mode.
const LiveEditor = lazy(() => loadWithRetry(() => import('./components/LiveEditorCrepe.jsx')));
// Lazy like the Live editor: the board pulls in @dnd-kit and its own CSS, and
// it is off by default (ENABLE_TASK_BOARD), so an install that doesn't use it
// must not carry the chunk on first paint.
const TaskBoard = lazy(() => loadWithRetry(() => import('./components/TaskBoard.jsx')));
// Lazy Marp slide-deck renderer: pulls in the Marp engine, off by default
// (ENABLE_MARP), so an install that doesn't use it never carries the chunk.
const MarpDeck = lazy(() => loadWithRetry(() => import('./components/MarpDeck.jsx')));
// Lazy Excalidraw drawing editor: pulls in the (large) Excalidraw bundle, off
// by default (ENABLE_EXCALIDRAW), so notes-only installs never carry the chunk.
const ExcalidrawEditor = lazy(() => loadWithRetry(() => import('./components/ExcalidrawEditor.jsx')));
// Lazy chats view, off by default (ENABLE_CHAT): notes-only installs never
// download it.
const ChatView = lazy(() => loadWithRetry(() => import('./components/ChatView.jsx')));
import Preview from './components/Preview.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import Settings from './components/Settings.jsx';
import AdminPanel from './components/AdminPanel.jsx';
import PresenceBar from './components/PresenceBar.jsx';
import CommentSidebar from './components/CommentSidebar.jsx';
import StickiesPanel from './components/StickiesPanel.jsx';
import StickiesBoard from './components/StickiesBoard.jsx';
import ShareDialog from './components/ShareDialog.jsx';
import HistoryModal from './components/HistoryModal.jsx';
import AttributionModal from './components/AttributionModal.jsx';
import MoveToModal from './components/MoveToModal.jsx';
import PasteModal from './components/PasteModal.jsx';
import { copyPlainText } from './mermaid-text.js';
import { mdnestUri } from './mdnestUri.js';
import {
  baseName, buildClipboardPayload, describeRefusal, filenameFromDisposition, formatBytes,
  localLinks, CLIPBOARD_MAX_BYTES,
} from './transfer.js';
import ReleaseNotesModal from './components/ReleaseNotesModal.jsx';
import CollabClient from './collab.js';
import { normalizeBoard } from './stickies.js';
import { isMarpDoc, effectiveEditorMode } from './marp.js';
import { isExcalidrawDoc } from './excalidraw.js';
import { TREE_POLL_MS, shouldPollTree } from './tree-refresh.js';
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
  downloadItem,
  fetchConfig,
  fetchMe,
  fetchPreferences,
  savePreferences,
  fetchStickies,
  saveStickies,
  logout as apiLogout,
  PermissionError, convertToChat } from './api.js';
import { buildPathIndex } from './wikilink.js';
import { createEchoGate } from './echo-gate.js';
import { broadcastTabMessage, onTabMessage } from './tab-sync.js';
import { initFirebase, signOutFirebase } from './firebase-config.js';
import {
  resolveTheme,
  applyTheme,
  osPrefersDark,
  cacheTheme,
  isTheme,
} from './theme.js';
import './App.css';

// Top-level logout. In Firebase mode we also clear the local Google session
// so the Google account chooser shows up on next sign-in. Does NOT revoke
// the user's Google account globally.
function logout() {
  signOutFirebase().finally(apiLogout);
}

// If we arrived here from /api/auth/sso/callback the JWT is sitting in the
// URL fragment as #sso_token=<jwt>, and errors as #sso_error=<code>.
// Reads once on page load, strips the hash, and returns any error code for
// the LoginSSO component to render. Lazy useState initialiser calls it
// exactly once per mount so it doesn't race with React's normal hash
// handling used for note navigation.
function consumeSSOHashOnLoad() {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash || '';
  // Find the SSO marker anywhere in the fragment, not just at the start.
  // URLs only allow ONE fragment, so if the user had a stale note hash like
  // "#finops" before logout, the SSO callback redirect can end up producing
  // "#finops#sso_token=..." (the second "#" gets folded into the fragment
  // string). A naive startsWith would miss it and the user would get stuck
  // on the login screen. The backend now strips fragments from the SSO
  // "from" path so this shouldn't happen anymore — but be defensive.
  const findValue = (marker) => {
    const idx = h.indexOf(marker);
    if (idx < 0) return null;
    const tail = h.slice(idx + marker.length);
    const amp = tail.indexOf('&');
    return amp >= 0 ? tail.slice(0, amp) : tail;
  };

  const tokenRaw = findValue('sso_token=');
  if (tokenRaw !== null) {
    let token = '';
    try { token = decodeURIComponent(tokenRaw); } catch {}
    if (token) {
      try { localStorage.setItem('mdnest_token', token); } catch {}
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return null;
  }

  const errRaw = findValue('sso_error=');
  if (errRaw !== null) {
    let code = '';
    try { code = decodeURIComponent(errRaw); } catch {}
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return code;
  }
  return null;
}

// URL helpers — the route shapes live in hashRoute.js.
function parseHash() {
  return parseRoute(window.location.hash);
}

function setHash(ns, path, stickiesBoard, taskBoard) {
  window.history.replaceState(null, '', formatRoute({ ns, path, stickies: stickiesBoard, board: taskBoard }));
}

// decodeJwtSub returns the `sub` claim of the JWT (the username), without
// verifying the signature. Used in single-user mode where there's no
// /api/me endpoint to fetch user info from — we just need the display
// name for the sidebar, and the JWT already carries it.
function decodeJwtSub(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1])).sub || null;
  } catch {
    return null;
  }
}

function App() {
  const [ssoError, setSsoError] = useState(() => consumeSSOHashOnLoad());
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [namespaces, setNamespaces] = useState([]);
  const [selectedNs, setSelectedNs] = useState(null);
  const [tree, setTree] = useState([]);
  // True while a getTree() request is in flight. Surfaced in the sidebar
  // so slow connections show a "Loading…" hint instead of the
  // "No files yet" empty-state copy (which made it look like the
  // namespace itself was empty mid-fetch).
  const [treeLoading, setTreeLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState(null);
  // null = no note loaded yet (initial mount, after closing a note, or while
  // a getNote() is in flight). The editor components key off this — they
  // only mount when content is a real string, so the "empty during async
  // load" state never enters Milkdown's undo stack as a reachable history
  // entry. Pre-v3.6.1 this defaulted to '' and pressing Cmd+Z could walk
  // the undo stack into that empty state, wiping real content.
  const [content, setContent] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [commentWidth, setCommentWidth] = useState(() => {
    const v = parseInt(localStorage.getItem('mdnest_comment_width'), 10);
    return Number.isFinite(v) ? Math.min(760, Math.max(260, v)) : 340;
  });
  const [savedContent, setSavedContent] = useState('');
  const saveTimerRef = useRef(null);
  // The queued autosave itself, so navigating away can RUN it instead of
  // dropping it. Cleared as soon as it executes.
  const pendingSaveRef = useRef(null);
  // Saves run one at a time. Two overlapping PUTs carried the same If-Match
  // etag, so on a slow link every second save came back 409: a "modified by
  // another user" banner with nobody else there, and when the last save was
  // the rejected one the final words never reached the server. A save now
  // waits for the one in flight (and so sends the etag it returned); a queued
  // save that a newer one has superseded is skipped, since the newer one
  // carries all of the text.
  const saveChainRef = useRef(Promise.resolve());
  const saveSeqRef = useRef(0);
  // An editor that debounces internally (the drawing canvas) registers a
  // callback here so its unsaved scene can be drained before we navigate.
  const editorFlushRef = useRef(null);
  // Called by every note loader with the text it just loaded. Assigned after
  // enterChats exists (further down) so the loaders, defined earlier, can
  // reach it without depending on it.
  const noteLoadedRef = useRef(null);
  const registerEditorFlush = useCallback((fn) => { editorFlushRef.current = fn; }, []);
  // Run a queued autosave now rather than discarding it.
  //
  // Opening another note used to just clearTimeout() the previous file's
  // pending save, so every edit made inside the debounce window was silently
  // lost. Drawings hit this on almost every switch: the canvas debounces its
  // own changes for 500ms before calling onChange, so the app-level timer had
  // barely started when the click landed on the next file.
  //
  // Callers must flush BEFORE loading the next note: etagRef is shared, so a
  // save that ran afterwards would send the new file's etag with the old
  // file's content.
  const flushPendingSave = useCallback(async () => {
    // First let the active editor hand over anything it is still debouncing.
    // It calls handleContentChange synchronously, which queues the save we
    // then run below — so this has to come first.
    if (editorFlushRef.current) editorFlushRef.current();
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) await pending();
  }, []);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  // Bumped by the toolbar "reveal in tree" button; Sidebar watches it to expand
  // ancestors, scroll the active row into view, and flash it.
  const [revealNonce, setRevealNonce] = useState(0);
  const revealInTree = useCallback(() => {
    setSidebarVisible(true); // ensure the tree is on-screen (mobile overlay)
    setRevealNonce((n) => n + 1);
  }, []);
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
  // When the Live editor throws on a specific file, remember that path
  // so the post-fallback banner can name it. Cleared on file change.
  const [liveCrashedFor, setLiveCrashedFor] = useState(null);

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

  // Per-namespace "last opened file" memory. When the user switches
  // namespaces and switches back, we restore whatever file they had open
  // in that namespace (with scroll position via the per-file prefs above).
  // A stale entry (file got deleted/moved on disk) is cleared by the
  // note-loading effect's catch handler, so the worst case is one failed
  // load instead of a permanent broken state.
  const getLastPath = useCallback((ns) => {
    if (!ns) return null;
    try { return localStorage.getItem(`mdnest_last_path:${ns}`) || null; } catch { return null; }
  }, []);

  const setLastPath = useCallback((ns, path) => {
    if (!ns) return;
    try {
      if (path) localStorage.setItem(`mdnest_last_path:${ns}`, path);
      else localStorage.removeItem(`mdnest_last_path:${ns}`);
    } catch { /* localStorage unavailable / quota exceeded */ }
  }, []);
  const [splitRatio, setSplitRatio] = useState(50);
  const [ctxMenu, setCtxMenu] = useState({ visible: false, x: 0, y: 0, target: null });
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [comments, setComments] = useState([]);
  const [showComments, setShowComments] = useState(false);
  // Personal sticky board. Not per-note and not per-namespace, so it lives at
  // the top of the app and is loaded once per session.
  const [stickies, setStickies] = useState([]);
  // 'closed' | 'panel' | 'board'. Three states rather than two booleans: the
  // drawer and the full-screen board are two views of one thing, and a pair of
  // flags makes "both open at once" representable when it never is.
  const [stickiesView, setStickiesView] = useState(() => (
    // The DRAWER's open/closed state is remembered per browser, the way the
    // view mode and the sidebar width already are. It is not in the URL —
    // only the full-screen board gets a route, because the drawer sits on top
    // of a note and a shared link should not force someone's stickies open.
    // But it is a panel the user chose to have open, and a refresh throwing it
    // away is the same annoyance as a refresh forgetting Basic vs Live.
    localStorage.getItem('mdnest_stickies_open') === '1' ? 'panel' : 'closed'
  ));
  const [stickySaveState, setStickySaveState] = useState('idle'); // idle | saving | error
  // 'loading' | 'ready' | 'error'. Load state is tracked, not collapsed into
  // an empty array: the board is written back WHOLE, so "we could not read
  // your board" must never be allowed to look like "your board is empty".
  const [stickiesLoad, setStickiesLoad] = useState('loading');
  const stickySaveTimerRef = useRef(null);
  const stickyLatestRef = useRef([]);
  // Mirrored in a ref because the save path is a callback that would otherwise
  // close over a stale value.
  const stickiesLoadRef = useRef('loading');
  const [showTaskBoard, setShowTaskBoard] = useState(false);
  // The chats view replaces the editor area like the board does. openChat is
  // the conversation shown in it ({ns, path} | null) — chats span namespaces,
  // so it is independent of the note open underneath.
  const [chatsOpen, setChatsOpen] = useState(false);
  const [openChat, setOpenChat] = useState(null);
  // Chat mode is a place you visit and come back from. chatsReturnTo is the
  // view you came from ('editor' | 'board'), so the one Back button lands you
  // exactly there. chatNs is the workspace the chat LIST shows; it is
  // deliberately separate from selectedNs, so browsing another workspace's
  // chats does not swap the workspace (and note) you return to.
  const [chatsReturnTo, setChatsReturnTo] = useState('editor');
  // Set when chat mode was entered by NAVIGATING to a chat note (tree click,
  // address bar): by then the note underneath is the chat itself, so Back
  // must reopen the note you were on before, not the chat's raw markdown.
  const [chatsReturnNote, setChatsReturnNote] = useState(null);
  const chatRedirectFrom = useRef(null);
  const [chatNs, setChatNs] = useState(null);
  // Set to `${ns}/${path}` when the user NAVIGATES to a note (tree click,
  // address bar). If that note turns out to be a chat, it opens in the chat
  // view instead of the editor, so a chat always opens as a chat. "Open the
  // note" from inside a chat does not set it, which is how you still reach
  // the raw markdown on purpose.
  const chatRedirectFor = useRef(null);
  // Bumped by the toolbar Refresh so the task board reloads its tasks too
  // (the board isn't part of the note/tree refresh path).
  const [boardRefreshNonce, setBoardRefreshNonce] = useState(0);
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
  const [userInfo, setUserInfo] = useState(null); // {id, username, role, grants, is_super_admin, admin_namespaces}
  const isMulti = appConfig?.authMode === 'multi';
  // v3.5.0 role hierarchy: superadmin (global), admin (namespace-scoped),
  // collaborator (grants-only). isSuperAdmin gates global-only UI
  // (delete user, role toggle, reset 2FA); adminNamespaces is the list
  // of namespaces this user can manage; isAnyAdmin is the predicate for
  // showing the admin panel button at all. Single-user mode is treated
  // as full superadmin.
  const isSuperAdmin = !isMulti || !!userInfo?.is_super_admin;
  const adminNamespaces = userInfo?.admin_namespaces || [];
  const isAnyAdmin = isSuperAdmin || adminNamespaces.length > 0;
  const isAdmin = isAnyAdmin;
  // Comments need real user identity AND the WebSocket hub (so other clients
  // see new/resolved comments without a manual refresh), so gate on liveCollab
  // — which itself is only true when multi mode is on.
  const commentsEnabled = !!appConfig?.liveCollab;
  // ENABLE_TASK_BOARD on the backend. When off, /api/tasks and /api/board are
  // not registered at all, so the button must not be offered.
  const taskBoardEnabled = !!appConfig?.taskBoard;
  const chatEnabled = !!appConfig?.chat;

  // "Basic" on a drawing shows the file's markdown source rather than the
  // canvas. Per-note and not persisted: a drawing should open as a drawing, so
  // this resets whenever the open note changes (see the effect below).
  const [drawingSource, setDrawingSource] = useState(false);

  // ENABLE_MARP on the backend. When on, a note whose frontmatter says
  // `marp: true` is shown as a slide deck in the Live view instead of the editor.
  const marpEnabled = !!appConfig?.marp;
  const marpActive = marpEnabled && isMarpDoc(content);
  // Marp decks must never go through the Live/WYSIWYG editor — it reformats the
  // markdown and corrupts the frontmatter and slide breaks. Force Basic (raw)
  // editing for them, regardless of the user's editor-mode preference. A
  // drawing opened as source is raw scene JSON and carries the same hazard.
  // A chat note is frontmatter-tagged like a Marp deck, and the Live editor
  // destroys that frontmatter on autosave (`---` -> `***` + a setext
  // heading), which silently turns the chat back into a plain note. So when
  // one is opened as a note, it is locked to Basic exactly like Marp.
  const chatNoteActive = chatEnabled && isChatDoc(content);
  const editorModeForNote = effectiveEditorMode(editorMode, marpActive || drawingSource || chatNoteActive);
  // `.excalidraw.md` files open in the drawing editor (opt-in ENABLE_EXCALIDRAW),
  // bypassing the text editor/preview entirely.
  const excalidrawEnabled = !!appConfig?.excalidraw;
  // A .excalidraw.md is a real markdown file, so "Basic" has to mean something
  // on it: it shows the underlying source (the scene JSON plus the mirrored
  // text elements) instead of the canvas. Previously the canvas short-circuited
  // the whole editor branch and the Basic/Live buttons were simply inert.
  const isDrawingDoc = excalidrawEnabled && isExcalidrawDoc(currentPath);
  const excalidrawActive = isDrawingDoc && !drawingSource;
  // Editor scroll ratio (0..1), mirrored to the Marp deck's current slide in
  // split view. The deck is paginated (not scrollable), so unlike the plain
  // Preview it can't share a scrollTop — we map the ratio to a slide instead.
  const [marpScrollPct, setMarpScrollPct] = useState(0);

  // Live collaboration state
  const [presenceUsers, setPresenceUsers] = useState([]);
  // Presence is held for a few seconds before a departure is believed, so a
  // reconnect or a snapshot racing a join doesn't flicker someone out and
  // straight back in. See presence-hold.js.
  const presenceHold = useRef(null);
  if (!presenceHold.current) presenceHold.current = createPresenceHold();
  const presenceTimer = useRef(null);
  const applyPresence = useCallback(() => {
    setPresenceUsers(presenceHold.current.visible());
    if (presenceTimer.current) { clearTimeout(presenceTimer.current); presenceTimer.current = null; }
    const next = presenceHold.current.msUntilNextChange();
    // One timer, set to the earliest expiry — no polling.
    if (next !== null) {
      presenceTimer.current = setTimeout(() => {
        presenceTimer.current = null;
        setPresenceUsers(presenceHold.current.visible());
      }, next + 50);
    }
  }, []);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [typingUsers, setTypingUsers] = useState({}); // {userId: username}
  const [conflictBanner, setConflictBanner] = useState(null); // {username, etag}
  // Bumped only on remote-driven reloads (another user's save/restore, or an
  // explicit Reload). The Excalidraw editor is keyed on it so its canvas remounts
  // with the fresh scene — otherwise a drawing would keep the stale scene and
  // the next stroke would silently overwrite the remote change (LWW).
  const [drawingReloadKey, setDrawingReloadKey] = useState(0);

  // Where the sidebar's "+ Note" / "+ Drawing" / "+ Folder" buttons create.
  // Clicking a folder aims them at it; otherwise they follow the open note's
  // folder, and fall back to the namespace root. They used to always create at
  // the root, so with a folder open in front of you the new file appeared
  // outside it.
  const [pickedFolder, setPickedFolder] = useState(null);

  // Source view is a per-file choice, not a preference: a drawing always opens
  // as a drawing, even if the last one was left showing its markdown.
  useEffect(() => { setDrawingSource(false); }, [selectedNs, currentPath]);
  useEffect(() => { setPickedFolder(null); }, [selectedNs]);
  // restoreBanner is shown when another user used the History modal to
  // restore an older version of the current file. It's deliberately a
  // separate state from conflictBanner because a restore is an
  // intentional action by another user, not a conflict — the UX is an
  // info banner, not a warning banner.
  const [restoreBanner, setRestoreBanner] = useState(null); // {username, ref, etag}
  // historyModal is { ns, path } when the History modal is open, null otherwise.
  const [historyModal, setHistoryModal] = useState(null);
  // attributionModal is { ns, path } when the Authors modal is open, null otherwise.
  const [attributionModal, setAttributionModal] = useState(null);
  // moveModal is { ns, target } when the Move-to picker is open. The
  // picker replaces drag-and-drop on touch devices (where draggable is
  // false on tree rows) and is also available from the context menu on
  // desktop as a more accessible alternative to dragging.
  const [moveModal, setMoveModal] = useState(null);
  // "Paste here" target: {ns, folder}.
  const [pasteModal, setPasteModal] = useState(null);
  // One status line at the bottom for downloads and clipboard copies:
  // {kind: 'running'|'ok'|'error'|'info', text, cancel?, action?: {label, run}}.
  const [notice, setNotice] = useState(null);
  // A save that found its note gone (moved or deleted elsewhere): {ns, path}.
  const [missingNote, setMissingNote] = useState(null);
  const [updateAvailable, setUpdateAvailable] = useState(null); // {current, latest}
  // Click feedback for the "Refresh Now" button — without this, clicking
  // can feel like nothing happened because the new bundle download +
  // parse takes a few seconds and the button stays visually idle the
  // entire time, leading users to re-click or kill the tab.
  const [refreshing, setRefreshing] = useState(false);
  // Server-side update notice — surfaces a newer mdnest GitHub release.
  // Distinct from `updateAvailable` (that one means "your browser bundle is
  // older than the running server, refresh the tab"). dismissedReleaseVer
  // hides the badge after the user has acknowledged a specific version.
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [dismissedReleaseVer, setDismissedReleaseVer] = useState(() => localStorage.getItem('mdnest_dismissed_release_version') || '');
  const [wsStatus, setWsStatus] = useState('disconnected'); // 'connected' | 'connecting' | 'disconnected'
  const etagRef = useRef(null);
  // Echo gate: recognizes the file-changed echoes of this tab's own saves so
  // they never raise a self-conflict banner. The backend broadcasts BEFORE it
  // writes the PUT response, so the echo usually beats the response that
  // carries the new etag — the gate defers broadcasts that arrive while a
  // save is in flight and re-checks them once the save settles (issue #82).
  // A same-user write from another source (CLI/MCP) carries an etag this tab
  // never produced and still propagates. Pure module: echo-gate.js.
  const echoGate = useRef(createEchoGate()).current;
  const collabRef = useRef(null);
  const typingTimers = useRef({}); // {userId: timeoutId}
  const localTypingUntil = useRef(0); // timestamp — local user is "typing" until this time
  const pollPathRef = useRef(null); // tracks current file for stale poll detection
  const treeRefreshTimer = useRef(null); // debounce for tree-changed events

  // Determine write access for current namespace/path
  const canWrite = useCallback((path) => {
    if (!isMulti) return true;
    if (!userInfo) return false;
    // Superadmin bypasses everywhere; namespace-admin of the selected ns
    // bypasses for that ns. Beyond that, fall through to the explicit
    // grants — namespace admins also get an auto-grant on '/' so this
    // is belt+suspenders.
    if (userInfo.is_super_admin) return true;
    if (userInfo.role === 'admin' && selectedNs && (userInfo.admin_namespaces || []).includes(selectedNs)) return true;
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

  // Fetch app config on mount (before auth). If the server is in Firebase
  // mode, the embedded firebaseWebConfig lets us init the Firebase SDK
  // before the user clicks "Sign in with Google".
  useEffect(() => {
    fetchConfig()
      .then((cfg) => {
        setAppConfig(cfg);
        if (cfg?.userProvider === 'firebase' && cfg?.firebaseWebConfig) {
          initFirebase(cfg.firebaseWebConfig);
        }
      })
      .catch(() => setAppConfig({ authMode: 'single' }));
  }, []);

  // --- Theme -----------------------------------------------------------
  // themePreference is what the USER chose ('auto' | 'dark' | 'light');
  // resolvedTheme is what is actually painted. They differ under 'auto'.
  const [themePreference, setThemePreference] = useState('auto');
  const [prefersDark, setPrefersDark] = useState(() => osPrefersDark());

  // Follow the OS while the preference is 'auto'. Without this listener a
  // user who flips their system theme mid-session sits on the stale one until
  // a reload — which is exactly the case 'auto' exists to serve.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setPrefersDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // The stored preference lives on the server, so it can only be read once
  // there is a session. Until then the boot script's cached guess stands.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    fetchPreferences().then((prefs) => {
      if (cancelled) return;
      if (isTheme(prefs?.theme)) setThemePreference(prefs.theme);
      setPrefsLoaded(true);
    });
    return () => { cancelled = true; };
  }, [authenticated]);

  const resolvedTheme = resolveTheme({
    userPreference: themePreference,
    serverDefault: appConfig?.defaultTheme,
    prefersDark,
  });

  // Paint, and remember for the next first paint.
  //
  // The guard matters more than it looks. Until the answers arrive,
  // themePreference is a placeholder 'auto' and appConfig is null, so
  // resolveTheme returns whatever the OS says — which for a user whose stored
  // preference disagrees with their OS is the WRONG theme. Painting it would
  // overwrite the correct colour the boot script already put on screen and
  // reintroduce exactly the flash that script exists to prevent, only now
  // between two of our own paints. So wait for /api/config, and when there is
  // a session, for /api/preferences too.
  const themeReady = !!appConfig && (!authenticated || prefsLoaded);
  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolvedTheme);
    cacheTheme(resolvedTheme);
  }, [themeReady, resolvedTheme]);

  // Apply immediately, persist in the background. A theme change must feel
  // instant; if the write fails the screen is still correct for this session
  // and the next load falls back to the stored value.
  const changeTheme = useCallback((next) => {
    if (!isTheme(next)) return;
    setThemePreference(next);
    savePreferences({ theme: next }).catch(() => {});
  }, []);

  // --- Sticky board -------------------------------------------------------
  //
  // Loaded once per session, saved on a 500 ms debounce — the same shape as
  // the note autosave, and for the same reason: every keystroke in a card is
  // a board change, and a PUT per keystroke is absurd.
  //
  // stickyLatestRef holds what the timer will send. Reading it at fire time
  // rather than closing over the array means a burst of edits coalesces into
  // one PUT carrying the LAST state, not the state as of the first keystroke.
  const setLoadState = useCallback((v) => {
    stickiesLoadRef.current = v;
    setStickiesLoad(v);
  }, []);

  const loadStickies = useCallback(() => {
    setLoadState('loading');
    return fetchStickies()
      .then((cards) => {
        const board = normalizeBoard(cards);
        stickyLatestRef.current = board;
        setStickies(board);
        setLoadState('ready');
      })
      .catch(() => setLoadState('error'));
  }, [setLoadState]);

  useEffect(() => {
    if (!authenticated) return;
    loadStickies();
  }, [authenticated, loadStickies]);

  const updateStickies = useCallback((next) => {
    // Belt and braces: the panel renders a retry pane rather than cards when
    // the load failed, so there is nothing to edit — but a save that could
    // fire here would overwrite a board we never managed to read.
    if (stickiesLoadRef.current !== 'ready') return;
    setStickies(next);
    stickyLatestRef.current = next;
    setStickySaveState('saving');
    if (stickySaveTimerRef.current) clearTimeout(stickySaveTimerRef.current);
    stickySaveTimerRef.current = setTimeout(() => {
      stickySaveTimerRef.current = null;
      const sending = stickyLatestRef.current;
      saveStickies(sending)
        .then(() => {
          // Only clear the indicator if nothing was typed while this PUT was
          // in flight — otherwise "Saving…" would blink off while a newer
          // board is still unsaved.
          if (stickyLatestRef.current === sending) setStickySaveState('idle');
        })
        .catch(() => setStickySaveState('error'));
    }, 500);
  }, []);

  // A pending board save must survive the tab closing. This is the one thing
  // in mdnest whose content exists nowhere else — no file, no git remote — so
  // losing the last 500 ms of typing has no recovery path. keepalive lets the
  // request outlive the page; a normal fetch here is cancelled on unload.
  useEffect(() => {
    const flush = () => {
      if (stickiesLoadRef.current !== 'ready') return;
      if (!stickySaveTimerRef.current) return;
      clearTimeout(stickySaveTimerRef.current);
      stickySaveTimerRef.current = null;
      const token = localStorage.getItem('mdnest_token');
      if (!token) return;
      fetch('/api/stickies', {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stickies: stickyLatestRef.current }),
      }).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // The toolbar button flips between the two concrete themes. Choosing
  // 'auto' is available in Settings — a single button cannot express three
  // states without becoming a menu, and the common action is "not this one".
  const toggleTheme = useCallback(() => {
    changeTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [changeTheme, resolvedTheme]);

  // Browser tab title: include the server alias so multiple mdnest tabs
  // (different servers) are visually distinguishable. Falls back to the
  // plain "mdnest" title when no SERVER_ALIAS is configured on the
  // server — same as the static <title> in index.html.
  useEffect(() => {
    const alias = appConfig?.serverAlias;
    document.title = alias ? `mdnest (${alias})` : 'mdnest';
  }, [appConfig?.serverAlias]);

  // Version check: poll /api/config every 60s, compare server version vs build version.
  // Same poll keeps `appConfig.latestRelease` fresh — without this update,
  // long-running tabs would never see the "new GitHub release available"
  // banner (the backend's poller refreshes its cache every hour, but the
  // frontend only ever fetched appConfig once on mount). To avoid useless
  // re-renders we only call setAppConfig when latestRelease.version
  // actually changed; the other fields (authMode, liveCollab, …) are
  // immutable at runtime.
  useEffect(() => {
    const buildVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
    if (!buildVersion) return;
    const check = async () => {
      try {
        const cfg = await fetchConfig();
        if (cfg.version && cfg.version !== buildVersion) {
          setUpdateAvailable({ current: buildVersion, latest: cfg.version });
        }
        setAppConfig((prev) => {
          if (prev?.latestRelease?.version === cfg?.latestRelease?.version) return prev;
          return cfg;
        });
      } catch {}
    };
    const interval = setInterval(check, 60000);
    // Also check once after 5s (catches updates during active sessions)
    const initial = setTimeout(check, 5000);
    return () => { clearInterval(interval); clearTimeout(initial); };
  }, []);

  // Handle a file-changed broadcast. Extracted from the collab switch so the
  // echo gate can replay deferred messages through the exact same logic once
  // an in-flight save settles. The gate makes the handler idempotent for our
  // own saves, as the backend broadcast assumes: acting on our own echo would
  // pop a spurious self-conflict banner while autosave is mid-flight
  // (isClean=false), and on the clean path re-fetch and reset the editor
  // selection (the cursor "jumps").
  const handleFileChanged = useCallback((msg) => {
    if (echoGate.check(msg, etagRef.current) !== 'process') return;
    // Another user saved (or restored) — update etag and reload if
    // no local edits. Restores get a separate "info" banner instead
    // of the yellow conflict banner; same auto-reload-when-clean
    // path otherwise.
    etagRef.current = msg.etag;
    const isRestore = msg.reason === 'restored';
    const isClean = (contentRef.current || '').trim() === (savedContentRef.current || '').trim();
    if (isClean) {
      setConflictBanner(null);
      const ns = selectedNsRef.current;
      const path = currentPathRef.current;
      if (ns && path) {
        getNote(ns, path).then(({ text, etag }) => {
          if (selectedNsRef.current === ns && currentPathRef.current === path) {
            setContent(text);
            setSavedContent(text);
            etagRef.current = etag;
            // Remount the drawing canvas so it shows the remote scene, not the
            // stale one it was mounted with.
            setDrawingReloadKey((k) => k + 1);
            if (isRestore) {
              // Show a brief info banner so the user knows their
              // content updated because of an explicit restore by
              // someone else, not a normal save.
              setRestoreBanner({ username: msg.username, ref: msg.restoreFromRef });
            }
          }
        }).catch(() => {});
      }
    } else if (isRestore) {
      setRestoreBanner({ username: msg.username, ref: msg.restoreFromRef, etag: msg.etag });
    } else {
      setConflictBanner({ username: msg.username, etag: msg.etag });
    }
  }, []);

  // Initialize collab client
  useEffect(() => {
    if (!appConfig?.liveCollab) return;
    const client = new CollabClient((msg) => {
      switch (msg.type) {
        case 'presence':
          presenceHold.current.setAll(msg.users || []);
          applyPresence();
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
          presenceHold.current.remove(msg.userId);
          applyPresence();
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
            if (selectedNsRef.current) refreshTree(selectedNsRef.current, { soft: true });
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
          handleFileChanged(msg);
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
      presenceHold.current.reset();
      setPresenceUsers([]);
      setRemoteCursors({});
      setConflictBanner(null);
      echoGate.reset();
      return;
    }
    collabRef.current.connect(selectedNs, currentPath);
    presenceHold.current.reset();
    setPresenceUsers([]);
    setRemoteCursors({});
    setTypingUsers({});
    setConflictBanner(null);
    // Broadcasts deferred during an in-flight save targeted the previous
    // note — drop them rather than replaying them against this one.
    echoGate.reset();
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

  // Path index for resolving [[wikilinks]] against the current tree,
  // shared by the preview renderer and the Live editor click handler.
  const wikiIndex = useMemo(() => buildPathIndex(tree), [tree]);

  // `opts.broadcast` — set by handlers that represent a change THIS tab made
  // (create/delete/move/upload, git-sync, manual Refresh). It posts a
  // BroadcastChannel message so other same-browser tabs refresh their tree
  // instantly instead of waiting for the poll. Background refreshes (poll,
  // init, WebSocket, and the cross-tab listener below) omit it, so a received
  // broadcast never triggers another broadcast — no echo loop.
  //
  // `opts.soft` — skip the loading state. The sidebar renders a thin indicator
  // bar whenever `treeLoading` is set, which is right for a refresh the user
  // asked for but is pure visual noise on a timer. Anything automatic and
  // unprompted passes soft, so the tree just quietly gains the new file.
  const refreshTree = useCallback(async (ns, opts) => {
    const target = ns || selectedNs;
    if (!target) return;
    if (!opts?.soft) setTreeLoading(true);
    try {
      const data = await getTree(target);
      setTree(data.children || []);
      if (opts?.broadcast) broadcastTabMessage({ type: 'tree-changed', ns: target });
    } catch (e) {
      console.error('Failed to load file tree:', e);
    } finally {
      if (!opts?.soft) setTreeLoading(false);
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
      } else {
        // Single mode has no /api/me endpoint, but the JWT's `sub` claim is
        // MDNEST_USER from mdnest.conf — read it client-side so the sidebar
        // shows the configured name instead of the "User" fallback. The
        // single-mode user implicitly owns everything, so role flags match
        // a superadmin for UI-gating purposes.
        const username = decodeJwtSub(getToken());
        setUserInfo(
          username
            ? { username, role: 'admin', is_super_admin: true, admin_namespaces: [], grants: [] }
            : null
        );
      }

      const nsList = await loadNamespaces();
      const { ns: hashNs, path: hashPath, stickies: hashStickies, board: hashBoard, chats: hashChats, chat: hashChat } = parseHash();
      // Opened (or refreshed) on the chats view, possibly with one chat open.
      if (hashChats) {
        setChatsOpen(true);
        setOpenChat(hashChat || null);
        setChatNs(hashChat ? hashChat.ns : null);
      }
      // Opened (or refreshed) on the task board: reopen it over the same
      // namespace and note.
      if (hashBoard) setShowTaskBoard(true);
      // Opened straight onto the board. The namespace and last file are still
      // restored underneath, so closing the board lands somewhere sensible
      // rather than on an empty editor.
      if (hashStickies) setStickiesView('board');
      let targetNs = null;
      // A chat link names its chat's namespace; open that workspace so the
      // (namespace-scoped) chat list matches the chat on screen.
      const linkedNs = hashNs || (hashChats && hashChat ? hashChat.ns : null);

      if (linkedNs && nsList.includes(linkedNs)) {
        targetNs = linkedNs;
      } else if (nsList.length > 0) {
        targetNs = nsList[0];
      }

      if (targetNs) {
        setSelectedNs(targetNs);
        if (hashPath && hashNs === targetNs) {
          // URL hash wins over saved last-path (it's the explicit choice
          // when a user shares/bookmarks a URL).
          setCurrentPath(hashPath);
        } else {
          // No hash → restore the last file the user had open in this
          // namespace, if any. The note-loading effect below will fetch
          // its content and the file-prefs scroll restore kicks in via
          // restoreScrollPosition.
          const last = getLastPath(targetNs);
          if (last) {
            setCurrentPath(last);
            // Not while the board route is what brought us here — writing the
            // note hash would overwrite the very URL being restored.
            if (!hashStickies && !hashChats) setHash(targetNs, last);
          }
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
          // Scroll-restore the file the user had last open in this
          // namespace. The per-file prefs (mdnest_file_prefs:<ns>/<path>)
          // hold the scrollPct from when they were last reading.
          restoreScrollPosition(selectedNs, currentPath);
          noteLoadedRef.current?.(selectedNs, currentPath, text);
        }).catch(() => {
          chatRedirectFor.current = null;
          // The saved/hash-pointed file is gone (deleted on disk, renamed
          // by another client). Clear so the user gets a clean slate, and
          // forget the stale last-path so the next ns switch doesn't try
          // it again.
          setCurrentPath(null);
          setContent(null);
          setSavedContent('');
          setHash(selectedNs, null);
          setLastPath(selectedNs, null);
        });
        if (commentsEnabled) {
          listComments(selectedNs, currentPath).then(setComments).catch(() => setComments([]));
        }
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

  // Soft auto-refresh of the tree, ALWAYS — including when the live-collab
  // websocket is connected. The policy (and why the websocket is deliberately
  // not part of it) lives in tree-refresh.js. `soft` keeps it invisible: no
  // spinner, no indicator bar, the tree just quietly gains the new file.
  useEffect(() => {
    if (!authenticated || !selectedNs) return;
    const interval = setInterval(() => {
      const ns = selectedNsRef.current;
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (!shouldPollTree({ authenticated, namespace: ns, hidden })) return;
      refreshTree(ns, { soft: true }).catch(() => {});
    }, TREE_POLL_MS);
    return () => clearInterval(interval);
  }, [authenticated, selectedNs, refreshTree]);

  // Instant cross-tab sync: another tab of this browser broadcasts
  // `tree-changed` after a create/delete/move/upload or a git-sync (see
  // refreshTree's `broadcast` option). Refresh our tree right away so both tabs
  // agree without the 60s poll or a manual Refresh — the single-mode fix for
  // "added a file in one tab, the other didn't show it until I hit Refresh".
  // We pass an explicit ns (no broadcast flag), so reacting never re-broadcasts.
  useEffect(() => {
    if (!authenticated) return;
    return onTabMessage((msg) => {
      if (msg?.type !== 'tree-changed') return;
      if (msg.ns !== selectedNsRef.current) return;
      if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current);
      treeRefreshTimer.current = setTimeout(() => {
        const ns = selectedNsRef.current;
        if (ns) refreshTree(ns, { soft: true }).catch(() => {});
      }, 250);
    });
  }, [authenticated, refreshTree]);

  // Refresh the tree the moment a backgrounded tab becomes visible again,
  // instead of waiting for the next poll tick (the poll skips hidden tabs).
  // Catches changes made while the tab was in the background — by another tab,
  // the CLI/MCP, or git-sync. Explicit ns → no broadcast.
  useEffect(() => {
    if (!authenticated) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ns = selectedNsRef.current;
      if (ns) refreshTree(ns, { soft: true }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [authenticated, refreshTree]);

  // Remember the drawer, not the board: the board has a URL, and restoring it
  // from storage as well would let a stale flag fight the address bar.
  useEffect(() => {
    if (stickiesView === 'board') return;
    localStorage.setItem('mdnest_stickies_open', stickiesView === 'panel' ? '1' : '0');
  }, [stickiesView]);

  // Set while a navigation that came FROM the address bar (back/forward, a
  // pasted link) is still loading its note. The URL already says what the
  // user asked for; writing it from state in the meantime would record the
  // half-finished state — e.g. the board switched on but the note not loaded
  // yet, which turned a pasted #!board/ns/note into #!board/ns.
  const hashNavPending = useRef(false);

  // Update URL hash
  useEffect(() => {
    if (hashNavPending.current) return;
    if (stickiesView === 'board') {
      setHash(null, null, true);
      return;
    }
    // Same rule as the board: until config loads, keep a chats deep link.
    if (chatsOpen && (!appConfig || chatEnabled)) {
      window.history.replaceState(null, '', formatRoute({ chats: true, chat: openChat }));
      return;
    }
    if (selectedNs) {
      // Until the config has loaded we can't know whether the board is
      // enabled; keep the board route rather than rewriting a deep link away.
      setHash(selectedNs, currentPath, false, showTaskBoard && (!appConfig || taskBoardEnabled));
    }
  }, [selectedNs, currentPath, stickiesView, showTaskBoard, appConfig, taskBoardEnabled, chatsOpen, openChat, chatEnabled]);

  // Handle browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const { ns, path, stickies, board, chats, chat } = parseHash();
      if (stickies) {
        setStickiesView('board');
        return; // the board route says nothing about which note is open
      }
      if (chats) {
        setShowTaskBoard(false);
        setChatsReturnTo('editor');
        setChatsOpen(true);
        setOpenChat(chat || null);
        if (chat) setChatNs(chat.ns);
        return; // the chats route names a chat, not the note underneath
      }
      setChatsOpen(false);
      setStickiesView((v) => (v === 'board' ? 'closed' : v));
      setShowTaskBoard(board);
      if (ns && ns !== selectedNs) {
        setSelectedNs(ns);
      }
      if (path !== currentPath) {
        if (path && ns) {
          chatRedirectFor.current = `${ns}/${path}`;
          hashNavPending.current = true;
          openNoteDirect(ns, path).finally(() => { hashNavPending.current = false; });
        } else {
          setCurrentPath(null);
          setContent(null);
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
    // Board stays open across note navigation so the chosen view persists; the
    // board's own "open source note" action closes it explicitly.
    // Write out the file we're leaving before loading the next one — see
    // flushPendingSave. Must happen before getNote(), which replaces etagRef.
    await flushPendingSave();
    try {
      const { text, etag } = await getNote(ns, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
      restoreScrollPosition(ns, path);
      if (commentsEnabled) {
        listComments(ns, path).then(setComments).catch(() => setComments([]));
      }
      noteLoadedRef.current?.(ns, path, text);
    } catch (e) {
      chatRedirectFor.current = null;
      console.error('Failed to open note:', e);
    }
  }, [restoreScrollPosition, commentsEnabled, flushPendingSave]);

  const handleSelectNs = useCallback((ns) => {
    // Keep the task board open when switching workspace so the chosen view is
    // preserved — it re-scopes to the new namespace. Note navigation keeps it
    // open too (see openNote/openNoteDirect).
    // Flush before any state changes so the queued save still lands on the
    // file the user was actually editing.
    flushPendingSave();
    setSelectedNs(ns);
    // Restore the last file the user had open in the namespace they're
    // switching TO. If they've never opened anything there (or whatever
    // they had is gone), fall back to the previous behavior — empty
    // selection, no hash. The note-loading effect picks up the new
    // currentPath and fetches its content + comments + scroll position.
    const last = getLastPath(ns);
    if (last) {
      setCurrentPath(last);
      // Wipe stale content so the editor doesn't briefly show the
      // previous namespace's note before the new content arrives.
      setContent(null);
      setSavedContent('');
      setHash(ns, last);
    } else {
      setCurrentPath(null);
      setContent(null);
      setSavedContent('');
      setHash(ns, null);
    }
    setTree([]);
  }, [getLastPath, flushPendingSave]);

  const openNote = useCallback(async (path) => {
    if (!selectedNs) return;
    // Board stays open across note navigation so the chosen view persists; the
    // board's own "open source note" action closes it explicitly.
    // Write out the previous file's pending edits instead of dropping them.
    // Must happen before getNote(), which replaces the shared etagRef.
    await flushPendingSave();
    try {
      const { text, etag } = await getNote(selectedNs, path);
      setCurrentPath(path);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
      setConflictBanner(null);
      setSidebarVisible(false);
      restoreScrollPosition(selectedNs, path);
      // Record this as the last-opened file for the current namespace
      // so a future namespace switch can come back to it.
      setLastPath(selectedNs, path);
      // Load comments for this note (only when comments feature is enabled)
      if (commentsEnabled) {
        listComments(selectedNs, path).then(setComments).catch(() => setComments([]));
      }
      noteLoadedRef.current?.(selectedNs, path, text);
    } catch (e) {
      chatRedirectFor.current = null;
      if (e.name === 'PermissionError') {
        alert('Access denied: you do not have permission to read this file.');
      } else {
        console.error('Failed to open note:', e);
      }
    }
  }, [selectedNs, restoreScrollPosition, commentsEnabled, setLastPath, flushPendingSave]);

  // Stable identity on purpose: this is handed to every task card, which is
  // memoised. An inline arrow here would be a new function on every App
  // render, so every card would re-render and the memo would buy nothing.
  const openNoteFromBoard = useCallback((p) => { setShowTaskBoard(false); openNote(p); }, [openNote]);

  // Delete a chat = delete its note (the note IS the chat). Confirmed first,
  // naming the note, because it removes every message too. Clears whatever
  // still points at the note (the open file, the namespace's last-opened
  // memory, the tree) exactly like deleting the file from the tree does.
  const deleteChat = useCallback(async (ns, path, title) => {
    if (!window.confirm(`Delete the chat "${title || path}"?\n\nThis deletes the note ${ns}/${path} and every message in it.`)) return false;
    await deleteNote(ns, path);
    if (ns === selectedNs && currentPath === path) { setCurrentPath(null); setContent(null); setSavedContent(''); }
    if (getLastPath(ns) === path) setLastPath(ns, null);
    if (ns === selectedNs) await refreshTree(undefined, { broadcast: true });
    // Close the room only if it is the chat that went: deleting another one
    // from the list's right-click menu must leave the open chat alone.
    setOpenChat((cur) => (cur && cur.ns === ns && cur.path === path ? null : cur));
    return true;
  }, [selectedNs, currentPath, getLastPath, setLastPath, refreshTree]);

  // "Open the note behind this chat": leave the chats view and open the file,
  // switching namespace when the chat lives in another one.
  // Open a note that may live in another workspace. Switching workspace and
  // THEN loading raced the namespace effect, which reloads the OLD path in
  // the new workspace and, on a miss, clears the editor, so the note just
  // opened vanished. Like handleSelectNs: set workspace and path in one
  // batch and let that effect load it.
  const openNoteIn = useCallback((ns, p) => {
    if (ns === selectedNs) { openNoteDirect(ns, p); return; }
    flushPendingSave();
    setSelectedNs(ns);
    setCurrentPath(p);
    setContent(null);
    setSavedContent('');
    setLastPath(ns, p);
  }, [selectedNs, openNoteDirect, flushPendingSave, setLastPath]);
  const openNoteFromChat = useCallback((ns, p) => {
    setChatsOpen(false);
    openNoteIn(ns, p);
  }, [openNoteIn]);
  // Every way into chat mode goes through enterChats, so Back always knows
  // where it came from.
  // returnNote: the note to reopen on Back ({ns, path}), 'none' when the
  // only note underneath is the chat itself, or undefined to keep the
  // current one.
  const enterChats = useCallback((chat, returnNote) => {
    // The editor is about to be swapped out. Its pending edits (and a
    // drawing's 500ms debounce, which its unmount would cancel) must be
    // written now: a queued save is flushed on navigation, never dropped.
    flushPendingSave();
    // Comments belong to the note, which chat mode is hiding.
    setShowComments(false);
    setChatsReturnTo(showTaskBoard ? 'board' : 'editor');
    setChatsReturnNote(returnNote === undefined ? null : returnNote);
    setShowTaskBoard(false);
    setChatNs(chat?.ns || selectedNs);
    setOpenChat(chat || null);
    setChatsOpen(true);
  }, [showTaskBoard, selectedNs, flushPendingSave]);
  const leaveChats = useCallback(() => {
    setChatsOpen(false);
    if (chatsReturnTo === 'board') setShowTaskBoard(true);
    if (chatsReturnNote === 'none') {
      // Nothing to go back to but the chat's own raw markdown: land on an
      // empty editor instead.
      setCurrentPath(null); setContent(null); setSavedContent('');
    } else if (chatsReturnNote) {
      openNoteIn(chatsReturnNote.ns, chatsReturnNote.path);
    } else if (currentPath) {
      // Reload the note underneath: chat mode may have rewritten it (a post
      // to that very chat, or the open note turned into one), and editing a
      // stale copy would 409, or strip the chat tag if overwritten.
      openNoteDirect(selectedNs, currentPath);
    }
    setChatsReturnNote(null);
  }, [chatsReturnTo, chatsReturnNote, selectedNs, currentPath, openNoteIn, openNoteDirect]);
  const setChatsActive = useCallback((on) => {
    if (on) enterChats(null); else leaveChats();
  }, [enterChats, leaveChats]);
  // The "is this note a chat?" decision, made where a note finishes loading
  // rather than in an effect on `content`: that effect stayed armed when the
  // click reloaded identical text (or the load failed), then fired on the
  // next keystroke.
  noteLoadedRef.current = (ns, path, text) => {
    const want = chatRedirectFor.current;
    if (!want) return;
    chatRedirectFor.current = null;
    const from = chatRedirectFrom.current;
    chatRedirectFrom.current = null;
    if (want !== `${ns}/${path}` || !chatEnabled || !isChatDoc(text)) return;
    enterChats({ ns, path }, from && !(from.ns === ns && from.path === path) ? from : 'none');
  };
  const chatsBackLabel = chatsReturnTo === 'board'
    ? 'Task board'
    : chatsReturnNote === 'none'
      ? 'notes'
      : (chatsReturnNote?.path || currentPath || '').split('/').pop() || 'notes';
  const setBoardActive = useCallback((on) => {
    if (on) {
      flushPendingSave(); // the editor is swapped out; see enterChats
      setChatsOpen(false);
    }
    setShowTaskBoard(on);
  }, [flushPendingSave]);


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
    // Named so flushPendingSave() can run it immediately when the user
    // navigates away before the debounce elapses. It closes over the path,
    // namespace and content of the edit that scheduled it, so running it late
    // still writes to the right file.
    const doSave = async (seq) => {
      if (seq !== saveSeqRef.current) return; // a newer save will write all of this
      if (!currentPath || !selectedNs) return;
      // Safety against destructive autosave: never write empty content
      // when we know the file had content when we loaded it. This is the
      // path that, pre-v3.6.1, allowed Milkdown's undo-to-empty to land
      // on disk via the debounced auto-PUT and erase the user's work.
      // The deliberate clear-this-file path uses clearNote() (allow-empty=1)
      // and bypasses this guard. The backend has the same check as a
      // last line of defense in case this ever fails to fire.
      if (newContent === '' && (savedContentRef.current || '') !== '') {
        console.warn('mdnest: autosave skipped — refusing to overwrite non-empty note with empty content. Use the explicit clear action to deliberately empty a file.');
        return;
      }
      const saveToken = echoGate.beginSave();
      try {
        const result = await saveNote(selectedNs, currentPath, newContent, etagRef.current);
        setSavedContent(newContent);
        if (result.etag) { etagRef.current = result.etag; echoGate.rememberOwnEtag(result.etag); }
      } catch (e) {
        if (e.status === 409) {
          // Confirm it is a real conflict before saying so: if the server
          // already holds exactly this text, adopt its etag and move on.
          let same = false;
          try {
            const latest = await getNote(selectedNs, currentPath);
            if (latest.text === newContent) {
              same = true;
              setSavedContent(newContent);
              etagRef.current = latest.etag;
            }
          } catch { /* fall through to the banner */ }
          if (!same) setConflictBanner({ username: 'another user', etag: e.etag });
        } else if (e.status === 404) {
          // Moved or deleted elsewhere. The PUT does not re-create the note
          // at its old path; say so, and keep the text on screen to copy.
          setMissingNote({ ns: selectedNs, path: currentPath });
        } else if (e.name === 'PermissionError') {
          console.error('Save blocked: no write permission');
        } else {
          console.error('Auto-save failed:', e);
        }
      } finally {
        // Re-check any broadcast that arrived while the save was in flight —
        // our own echo is now recognizable, a real remote change still lands.
        // (A no-op if the user switched notes mid-save: the token's epoch
        // is closed and endSave returns nothing.)
        echoGate.endSave(saveToken).forEach(handleFileChanged);
      }
    };
    const runSave = () => {
      pendingSaveRef.current = null;
      const seq = ++saveSeqRef.current;
      const job = saveChainRef.current.then(() => doSave(seq));
      saveChainRef.current = job.catch(() => {});
      return job;
    };
    pendingSaveRef.current = runSave;
    saveTimerRef.current = setTimeout(runSave, 800);
  }, [currentPath, selectedNs]);


  // Send cursor position to collab
  const handleCursorChange = useCallback((line, ch) => {
    if (collabRef.current) collabRef.current.sendCursor(line, ch);
  }, []);

  const handleSelectionChange = useCallback((fromLine, fromCh, toLine, toCh) => {
    if (collabRef.current) collabRef.current.sendSelection(fromLine, fromCh, toLine, toCh);
  }, []);

  const handleCheckboxToggle = useCallback(async (lineIndex, colIndex) => {
    if (content === null) return;
    const lines = content.split('\n');
    const line = lines[lineIndex];
    if (!line) return;
    // colIndex provided → toggle the bracket pair starting at that
    // column. Used for in-cell checkboxes (no list-item prefix).
    if (typeof colIndex === 'number') {
      const segment = line.substr(colIndex, 3);
      if (segment === '[ ]') {
        lines[lineIndex] = line.substr(0, colIndex) + '[x]' + line.substr(colIndex + 3);
      } else if (segment === '[x]' || segment === '[X]') {
        lines[lineIndex] = line.substr(0, colIndex) + '[ ]' + line.substr(colIndex + 3);
      } else {
        return;
      }
    } else if (line.includes('- [ ]')) {
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
      const saveToken = echoGate.beginSave();
      try {
        const result = await saveNote(selectedNs, currentPath, newContent);
        if (result.etag) { etagRef.current = result.etag; echoGate.rememberOwnEtag(result.etag); }
      } catch (e) {
        console.error('Checkbox save failed:', e);
      } finally {
        echoGate.endSave(saveToken).forEach(handleFileChanged);
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
    // No explicit target means the sidebar buttons (the context menu always
    // passes the node it was opened on). Use the folder the user last clicked,
    // else the open note's folder, else the namespace root.
    if (!target) {
      const dir = pickedFolder !== null
        ? pickedFolder
        : (currentPath && currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '');
      return dir ? dir.replace(/\/$/, '') + '/' : '';
    }
    if (target.type === 'folder') {
      const p = target.path || target.name;
      return p.replace(/\/$/, '') + '/';
    }
    const parts = (target.path || '').split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') + '/' : '';
  }, [currentPath, pickedFolder]);

  const doCreateNote = useCallback(async (target) => {
    if (!selectedNs) return;
    let name = prompt('Note name (e.g. my-note.md):');
    if (!name) return;
    if (!name.endsWith('.md')) name += '.md';
    const dir = getTargetDir(target);
    const path = dir + name.replace(/^\/+/, '');
    try {
      await createNote(selectedNs, path);
      await refreshTree(undefined, { broadcast: true });
      openNote(path);
    } catch (e) {
      alert('Failed to create note: ' + e.message);
    }
  }, [selectedNs, getTargetDir, refreshTree, openNote]);

  // Create an empty Excalidraw drawing and open it in the drawing editor.
  const doCreateDrawing = useCallback(async (target) => {
    if (!selectedNs) return;
    let name = prompt('Drawing name (e.g. sketch.excalidraw.md):');
    if (!name) return;
    if (!isExcalidrawDoc(name)) name += '.excalidraw.md';
    const dir = getTargetDir(target);
    const path = dir + name.replace(/^\/+/, '');
    try {
      await createNote(selectedNs, path);
      await refreshTree(undefined, { broadcast: true });
      openNote(path);
    } catch (e) {
      alert('Failed to create drawing: ' + e.message);
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
      await refreshTree(undefined, { broadcast: true });
    } catch (e) {
      alert('Failed to create folder: ' + e.message);
    }
  }, [selectedNs, getTargetDir, refreshTree]);

  useEffect(() => {
    if (!notice || (notice.kind !== 'ok' && notice.kind !== 'info') || notice.action) return undefined;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Download a file, or a folder as a zip. fetch + Blob rather than a bare
  // link, so a 413/429 shows its real reason and the download can be
  // cancelled (which also frees the server's slot).
  const runDownload = useCallback(async (ns, target) => {
    if (!ns || !target?.path) return;
    const isFolder = target.type === 'folder' || target.type === 'directory';
    const label = (target.name || baseName(target.path)) + (isFolder ? '.zip' : '');
    const ctrl = new AbortController();
    setNotice({ kind: 'running', text: `Downloading ${label}…`, cancel: () => ctrl.abort() });
    try {
      const r = await downloadItem(ns, target.path, ctrl.signal);
      if (!r.ok) {
        setNotice({ kind: 'error', text: describeRefusal(r.status, r.body, { action: 'download' }) });
        return;
      }
      // Re-typed as a plain download: the object URL lives on mdnest's origin,
      // and a server type such as text/html must not make it a page.
      const url = URL.createObjectURL(new Blob([r.blob], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameFromDisposition(r.disposition, label);
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke once the save has been handed to the browser; the short delay
      // is for engines that start reading the URL asynchronously.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(null);
    } catch (e) {
      if (e.name === 'AbortError') setNotice({ kind: 'info', text: 'Download cancelled.' });
      else setNotice({ kind: 'error', text: `Download failed: ${e.message}` });
    }
  }, []);

  // "Copy for another mdnest": one note on the clipboard as a small JSON
  // payload another mdnest's "Paste here" understands. Plain-HTTP installs
  // have no async Clipboard API, so the hidden-textarea route is the fallback;
  // if the browser refuses both (the fetch above used up the click's
  // activation), the notice offers a button that copies synchronously.
  const copyForAnotherMdnest = useCallback(async (ns, target) => {
    let text;
    try {
      ({ text } = await getNote(ns, target.path));
    } catch (e) {
      setNotice({ kind: 'error', text: `Could not read the note: ${e.message}` });
      return;
    }
    const name = target.name || baseName(target.path);
    const p = buildClipboardPayload(name, text);
    if (!p.ok) {
      setNotice({
        kind: 'error',
        text: `This note is ${formatBytes(p.bytes)}, over the ${formatBytes(CLIPBOARD_MAX_BYTES)} clipboard limit. Download it instead.`,
        action: { label: 'Download', run: () => runDownload(ns, target) },
      });
      return;
    }
    const links = localLinks(text);
    const done = `Copied "${name}". In the other mdnest, right-click a folder and choose Paste here.`
      + (links.length ? ` ${links.length} linked file${links.length === 1 ? '' : 's'} on this server will not be copied.` : '');
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(p.text); ok = true; } catch { /* fall back */ }
    }
    if (!ok) ok = copyPlainText(p.text);
    if (ok) {
      setNotice({ kind: 'ok', text: done });
    } else {
      setNotice({
        kind: 'info',
        text: `"${name}" is ready to copy.`,
        action: {
          label: 'Copy',
          run: () => setNotice(copyPlainText(p.text) ? { kind: 'ok', text: done } : { kind: 'error', text: 'The browser blocked the clipboard.' }),
        },
      });
    }
  }, [runDownload]);

  const handleContextAction = useCallback(async (action, target) => {
    switch (action) {
      case 'new-note': await doCreateNote(target); break;
      case 'new-drawing': await doCreateDrawing(target); break;
      case 'new-folder': await doCreateFolder(target); break;
      case 'delete-file': {
        if (!target || !selectedNs) return;
        if (!confirm(`Delete "${target.name || target.path}"?`)) return;
        try {
          await deleteNote(selectedNs, target.path);
          if (currentPath === target.path) { setCurrentPath(null); setContent(null); setSavedContent(''); }
          // Forget this as the namespace's last-opened file so a future
          // ns switch doesn't try to reopen a now-deleted note.
          const lastForNs = getLastPath(selectedNs);
          if (lastForNs === target.path) setLastPath(selectedNs, null);
          await refreshTree(undefined, { broadcast: true });
        } catch (e) { alert('Failed to delete: ' + e.message); }
        break;
      }
      case 'history': {
        if (!target || !selectedNs) return;
        // Open the file first if it's not already open — the modal
        // restores into whatever's currently in the editor, and we
        // want that to be this file.
        if (currentPath !== target.path) {
          await openNote(target.path);
        }
        setHistoryModal({ ns: selectedNs, path: target.path });
        break;
      }
      case 'authors': {
        if (!target || !selectedNs) return;
        setAttributionModal({ ns: selectedNs, path: target.path });
        break;
      }
      case 'move':
      case 'copy-to': {
        if (!target || !selectedNs) return;
        // Write out pending edits first: a move may take the open note to
        // another namespace, and a copy should carry what is on screen.
        await flushPendingSave();
        // The MoveToModal handles the destination picking, the dry run, the
        // API call and the validity filtering itself. We just open it with
        // the target and follow the result.
        setMoveModal({ ns: selectedNs, target, mode: action === 'copy-to' ? 'copy' : 'move' });
        break;
      }
      case 'download': {
        if (!target || !selectedNs) return;
        await flushPendingSave();
        runDownload(selectedNs, target);
        break;
      }
      case 'copy-clipboard': {
        if (!target || !selectedNs) return;
        await flushPendingSave();
        copyForAnotherMdnest(selectedNs, target);
        break;
      }
      case 'paste-here': {
        if (!selectedNs) return;
        setPasteModal({ ns: selectedNs, folder: target?.path || '' });
        break;
      }
      case 'delete-folder': {
        if (!target || !selectedNs) return;
        if (!confirm(`Delete folder "${target.name || target.path}" and all its contents?`)) return;
        try {
          await deleteNote(selectedNs, target.path);
          if (currentPath && currentPath.startsWith(target.path)) { setCurrentPath(null); setContent(null); setSavedContent(''); }
          // If the last-opened file lived inside this folder it's gone now.
          const lastForNs = getLastPath(selectedNs);
          if (lastForNs && lastForNs.startsWith(target.path)) setLastPath(selectedNs, null);
          await refreshTree(undefined, { broadcast: true });
        } catch (e) { alert('Failed to delete folder: ' + e.message); }
        break;
      }
      case 'new-chat': {
        if (!selectedNs) break;
        const title = window.prompt('Chat name');
        if (!title || !title.trim()) break;
        const path = chatPathFor(title, target?.path || '');
        try {
          await convertToChat(selectedNs, path, title.trim());
          await refreshTree(undefined, { broadcast: true });
          enterChats({ ns: selectedNs, path });
        } catch (e) { alert('Failed to create chat: ' + e.message); }
        break;
      }
      case 'copy-path': {
        if (target && selectedNs) copyPlainText(mdnestUri(appConfig?.serverAlias, selectedNs, target.path));
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
        let newName = prompt('Rename to:', oldName);
        if (!newName) return;
        // Preserve the file's extension if the user typed a name without one.
        // Without this, renaming foo.md to "foo" writes "foo" to disk, and the
        // tree filter drops files without a recognized text extension — so the
        // file silently disappears from the sidebar.
        const isFolder = target.type === 'folder' || target.type === 'directory';
        if (!isFolder) {
          const lastDot = oldName.lastIndexOf('.');
          if (lastDot > 0 && !newName.includes('.')) {
            newName += oldName.substring(lastDot);
          }
        }
        if (newName === oldName) return;
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
          // Update last-path pointer so it follows the rename.
          const lastForNs = getLastPath(selectedNs);
          if (lastForNs === target.path) {
            setLastPath(selectedNs, newPath);
          } else if (lastForNs && lastForNs.startsWith(target.path + '/')) {
            setLastPath(selectedNs, newPath + lastForNs.substring(target.path.length));
          }
          await refreshTree(undefined, { broadcast: true });
        } catch (e) { alert('Failed to rename: ' + e.message); }
        break;
      }
    }
  }, [selectedNs, currentPath, refreshTree, doCreateNote, doCreateDrawing, doCreateFolder, getLastPath, setLastPath, enterChats, flushPendingSave, runDownload, copyForAnotherMdnest]);

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
      // Update last-path pointer if it tracked the moved file/folder.
      const lastForNs = getLastPath(selectedNs);
      if (lastForNs === fromPath) {
        setLastPath(selectedNs, newPath);
      } else if (lastForNs && lastForNs.startsWith(fromPath + '/')) {
        setLastPath(selectedNs, newPath + lastForNs.substring(fromPath.length));
      }
      await refreshTree(undefined, { broadcast: true });
    } catch (e) {
      alert('Failed to move: ' + e.message);
    }
  }, [selectedNs, currentPath, refreshTree, getLastPath, setLastPath]);

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

  // Marp split-view sync: the deck is paginated, not scrollable, so the
  // scrollTop mirror above doesn't apply. Instead, track the editor's scroll
  // ratio and hand it to MarpDeck, which maps it to the matching slide. The
  // update is rAF-throttled and deduped so a large App tree isn't re-rendered
  // on every scroll frame; only meaningful movement flows through.
  useEffect(() => {
    if (isMobile || viewMode !== 'split' || !marpActive) return undefined;
    const findScrollable = (wrapper) => {
      if (!wrapper) return null;
      const textarea = wrapper.querySelector('.editor-textarea');
      if (textarea) return textarea;
      const liveContent = wrapper.querySelector('.live-editor-wrapper');
      if (liveContent) return liveContent;
      return wrapper;
    };
    const editorEl = findScrollable(editorWrapperRef.current);
    if (!editorEl) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      const max = editorEl.scrollHeight - editorEl.clientHeight;
      const pct = max > 0 ? editorEl.scrollTop / max : 0;
      setMarpScrollPct((prev) => (Math.abs(prev - pct) < 0.005 ? prev : pct));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    editorEl.addEventListener('scroll', onScroll, { passive: true });
    update(); // seed the initial slide from the current scroll position
    return () => {
      editorEl.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [viewMode, isMobile, marpActive, currentPath, editorMode]);

  const handleRefresh = useCallback(async () => {
    if (!authenticated || !selectedNs) return;
    // When the board overlay is up, Refresh should reload its tasks — bump the
    // nonce the board watches (the note/tree refresh below doesn't touch it).
    if (showTaskBoard) setBoardRefreshNonce((n) => n + 1);
    // broadcast: this is the Sidebar's manual Refresh AND the git-sync button
    // (both call onRefreshTree), so tell other tabs to refresh too.
    await refreshTree(selectedNs, { broadcast: true });
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
  }, [authenticated, selectedNs, currentPath, refreshTree, showTaskBoard]);

  // Reload note content (used by conflict banner)
  const handleReloadNote = useCallback(async () => {
    if (!selectedNs || !currentPath) return;
    try {
      const { text, etag } = await getNote(selectedNs, currentPath);
      setContent(text);
      setSavedContent(text);
      etagRef.current = etag;
      setDrawingReloadKey((k) => k + 1);
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
    // Render the Firebase flow only once the backend config has loaded so
    // we know which login component to mount. While appConfig is still
    // null, show a minimal splash to avoid flashing the wrong form.
    if (!appConfig) return <div className="login-screen"><div className="login-box"><h1>mdnest</h1></div></div>;

    // Hidden dev-login route — only when the operator manually visits
    // /?login=dev AND the backend has INSECURE_DEV_LOGIN=true. The
    // default flow below is unchanged (still strict SSO).
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === 'dev' && appConfig.devLoginEnabled) {
      return <LoginDev onLogin={() => window.location.reload()} />;
    }

    if (appConfig.userProvider === 'firebase') {
      return <LoginFirebase onLogin={() => window.location.reload()} />;
    }
    if (appConfig.userProvider === 'sso') {
      return <LoginSSO providerLabel={appConfig.ssoProvider} errorCode={ssoError} />;
    }
    return <Login onLogin={() => window.location.reload()} serverAlias={appConfig.serverAlias} />;
  }

  if (showAdminPanel && isAdmin && isMulti) {
    return <AdminPanel
      onClose={() => setShowAdminPanel(false)}
      namespaces={namespaces}
      isSuperAdmin={isSuperAdmin}
      adminNamespaces={adminNamespaces}
      userProvider={appConfig?.userProvider || 'local'}
      grantMaxDepth={appConfig?.grantMaxDepth || 0}
      marpThemesEnabled={!!appConfig?.marpThemes}
    />;
  }

  return (
    <div className={`app${chatsOpen && chatEnabled ? ' app--chats' : ''}`}>
      {appConfig?.devLoginEnabled && (
        // Small fixed-position warning pill — visible on every
        // authenticated screen but unobtrusive. Hover for the full
        // explanation. Loud enough that a stray production deploy with
        // this flag is impossible to miss; small enough to ignore once
        // you've registered it.
        <div className="dev-login-pill" role="status" aria-label="Dev login backdoor enabled">
          <span className="dev-login-pill-icon" aria-hidden="true">⚠</span>
          <span className="dev-login-pill-label">DEV LOGIN</span>
          <span className="dev-login-pill-tooltip">
            <strong>INSECURE_DEV_LOGIN is enabled.</strong>
            Anyone reaching this server can impersonate any user via{' '}
            <code>/?login=dev</code>. Disable in <code>mdnest.conf</code> before
            sharing this URL.
          </span>
        </div>
      )}
      <Sidebar
        tree={tree}
        treeLoading={treeLoading}
        // Opening a file hands the create-target back to that file's folder,
        // so it tracks where you actually are rather than the last folder
        // you happened to expand.
        onSelect={(p) => { setPickedFolder(null); setChatsOpen(false); chatRedirectFor.current = `${selectedNs}/${p}`; chatRedirectFrom.current = currentPath ? { ns: selectedNs, path: currentPath } : null; openNote(p); }}
        currentPath={currentPath}
        namespaces={namespaces}
        selectedNs={selectedNs}
        onSelectNs={handleSelectNs}
        onContextMenu={handleContextMenu}
        onDrop={canWrite('') ? handleTreeDrop : null}
        visible={sidebarVisible}
        onClose={() => setSidebarVisible(false)}
        userInfo={userInfo}
        onLogout={logout}
        onAdminPanel={isAdmin && isMulti ? () => setShowAdminPanel(true) : null}
        onNewNote={canWrite('') ? () => doCreateNote(null) : null}
        onNewDrawing={excalidrawEnabled && canWrite('') ? () => doCreateDrawing(null) : null}
        pickedFolder={pickedFolder}
        onPickFolder={setPickedFolder}
        onNewFolder={canWrite('') ? () => doCreateFolder(null) : null}
        onRefreshTree={handleRefresh}
        isAdmin={isAdmin}
        serverVersion={appConfig?.version}
        serverCommit={appConfig?.commit}
        serverBuildTime={appConfig?.buildTime}
        updateAvailableVersion={
          appConfig?.latestRelease &&
          isVersionNewer(appConfig.latestRelease.version, appConfig.version) &&
          appConfig.latestRelease.version !== dismissedReleaseVer
            ? appConfig.latestRelease.version
            : null
        }
        onShowReleaseNotes={() => setShowReleaseNotes(true)}
        revealNonce={revealNonce}
        width={sidebarWidth}
        onResize={setSidebarWidth}
      />
      <div
        className="main"
        style={
          !isMobile && ((commentsEnabled && showComments && currentPath) || stickiesView === 'panel')
            ? { marginRight: commentWidth }
            : undefined
        }
      >
        <Toolbar
          currentPath={currentPath}
          onManageUsers={isAdmin && isMulti ? () => setShowAdminPanel(true) : null}
          theme={resolvedTheme}
          onToggleTheme={toggleTheme}
          onToggleSidebar={() => setSidebarVisible((v) => !v)}
          onRevealInTree={revealInTree}
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
          editorMode={editorModeForNote}
          marpLocked={marpActive || chatNoteActive}
          mobileView={mobileView}
          onMobileViewChange={isMobile && currentPath && !excalidrawActive && !showTaskBoard && !chatsOpen ? (v) => { setMobileView(v); localStorage.setItem('mdnest_mobile_view', v); } : null}
          liveLockReason={chatNoteActive && !marpActive ? 'Disabled for chats — the rich editor would rewrite the chat tag and turn it back into a plain note' : null}
          onSetBoardActive={taskBoardEnabled && selectedNs ? setBoardActive : null}
          onSetChatsActive={chatEnabled ? setChatsActive : null}
          chatsBackLabel={chatsBackLabel}
          chatsActive={chatsOpen && chatEnabled}
          drawingDoc={isDrawingDoc}
          drawingSource={drawingSource}
          onDrawingSourceChange={setDrawingSource}
          boardActive={showTaskBoard}
          onEditorModeChange={(mode) => {
            // Marp decks are locked to Basic — ignore attempts to switch to the
            // Live editor, which would reformat and break the slides.
            if ((marpActive || chatNoteActive) && mode === 'live') return;
            setShowTaskBoard(false);
            setChatsOpen(false);
            setEditorMode(mode);
            localStorage.setItem('mdnest_editor_mode', mode);
            // User explicitly opted back into Live for this file — clear
            // the post-crash banner so we don't leave a stale notice up.
            if (mode === 'live') setLiveCrashedFor(null);
            if (selectedNs && currentPath) {
              restoreScrollPosition(selectedNs, currentPath);
            }
          }}
          onRefresh={handleRefresh}
          commentCount={commentsEnabled ? comments.filter(c => !c.parentId && !c.resolved).length : 0}
          stickiesOpen={stickiesView !== 'closed'}
          onToggleStickies={() => {
            // Two drawers, one strip of screen. Opening either closes the
            // other rather than stacking them — the comment panel already
            // owns this edge, and two overlapping fixed panels is not a
            // layout, it is a bug report.
            setStickiesView((v) => {
              if (v === 'closed') setShowComments(false);
              // The button closes whichever view is open and reopens at the
              // drawer — it is one toggle, not a cycle through three states.
              return v === 'closed' ? 'panel' : 'closed';
            });
          }}
          onToggleComments={!commentsEnabled ? null : () => {
            // A plain toggle: the panel is usable in any view mode (including
            // preview-only, e.g. reviewing Marp slides). Selection-anchored
            // comments and highlights still require the Live editor, but
            // general comments work everywhere, so we no longer force the
            // user out of their current view.
            setShowComments((v) => {
              if (!v) setStickiesView('closed');
              return !v;
            });
          }}
          wsStatus={appConfig?.liveCollab ? wsStatus : null}
        />
        {updateAvailable && (
          <div className="update-banner">
            New version available: <strong>v{updateAvailable.current}</strong> → <strong>v{updateAvailable.latest}</strong>
            <button
              onClick={() => {
                // Immediate visual feedback — the new build is heavy
                // (Crepe + Vue + CodeMirror + KaTeX ≈ 340 KB gzipped) and
                // a slow connection / low-memory device can spend several
                // seconds parsing it. Without the disabled + "Refreshing…"
                // state the tab looks frozen and users hit-and-kill it.
                setRefreshing(true);
                // Modern browsers ignore the deprecated `true` arg; call
                // the standard no-arg form.
                window.location.reload();
              }}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh Now'}
            </button>
          </div>
        )}
        {conflictBanner && (
          <div className="conflict-banner floating-notice" role="alert">
            This file was modified by {conflictBanner.username}. Your changes may conflict.
            <button onClick={handleReloadNote}>Reload</button>
            <button onClick={() => setConflictBanner(null)}>Dismiss</button>
          </div>
        )}
        {missingNote && missingNote.ns === selectedNs && missingNote.path === currentPath && (
          <div className="conflict-banner" data-testid="missing-note-banner">
            This note is no longer here: it was moved or deleted. Your latest edits were not saved.
            <button onClick={() => { copyPlainText(content || ''); setNotice({ kind: 'ok', text: 'Your text is on the clipboard.' }); }}>Copy my text</button>
            <button onClick={() => setMissingNote(null)}>Dismiss</button>
          </div>
        )}
        {restoreBanner && (
          <div className="restore-banner floating-notice" role="status">
            {restoreBanner.username} restored this file to an earlier version
            {restoreBanner.ref ? ` (${restoreBanner.ref.slice(0, 7)})` : ''}.
            {restoreBanner.etag ? ' Your unsaved changes are kept until you reload.' : ' Content has been updated.'}
            {restoreBanner.etag && <button onClick={handleReloadNote}>Reload</button>}
            <button onClick={() => setRestoreBanner(null)}>Dismiss</button>
          </div>
        )}
        {liveCrashedFor && liveCrashedFor === currentPath && (
          <div className="restore-banner">
            Live editor failed to load this file — switched to Basic mode so you can keep working.
            You can try Live again from the toolbar; the crash is usually content-specific.
            <button onClick={() => setLiveCrashedFor(null)}>Dismiss</button>
          </div>
        )}
        <div className="split-view">
          {/* Rendered inside the content area, not above it: this is an overlay
              and .split-view is the box it should be positioned against.
              Placed in .main it floated over the toolbar and covered the
              view-mode and settings buttons. */}
          {appConfig?.liveCollab && presenceUsers.length > 1 && (
            <PresenceBar users={presenceUsers} currentUserId={userInfo?.id} typingUsers={typingUsers} />
          )}
          {chatsOpen && chatEnabled ? (
            <ChunkErrorBoundary
              label="chats"
              resetKey="chats"
              onDismiss={() => setChatsOpen(false)}
              dismissLabel="Close chats"
            >
            <Suspense fallback={<div className="editor-loading">Loading chats...</div>}>
              <ChatView
                ns={chatNs || selectedNs}
                namespaces={namespaces}
                onSelectNs={(n) => { setChatNs(n); if (openChat && openChat.ns !== n) setOpenChat(null); }}
                account={isMulti ? userInfo?.username : null}
                serverAlias={appConfig?.serverAlias}
                isMobile={isMobile}
                openChat={openChat}
                onSelectChat={setOpenChat}
                onOpenNote={openNoteFromChat}
                onDeleteChat={deleteChat}
                onClose={leaveChats}
              />
            </Suspense>
            </ChunkErrorBoundary>
          ) : showTaskBoard && taskBoardEnabled && selectedNs ? (
            <ChunkErrorBoundary
              label="the task board"
              resetKey={selectedNs}
              onDismiss={() => setShowTaskBoard(false)}
              dismissLabel="Close board"
            >
            <Suspense fallback={<div className="editor-loading">Loading task board...</div>}>
              <TaskBoard
                ns={selectedNs}
                canWrite={canWrite('')}
                currentPath={currentPath}
                currentUser={userInfo?.username}
                refreshSignal={boardRefreshNonce}
                onOpenNote={openNoteFromBoard}
                onClose={() => setShowTaskBoard(false)}
              />
            </Suspense>
            </ChunkErrorBoundary>
          ) : currentPath ? (
            excalidrawActive ? (
              <div className="excalidraw-wrapper">
                {content === null ? (
                  <div className="editor-loading">Loading drawing…</div>
                ) : (
                  <ChunkErrorBoundary
                    label="the drawing editor"
                    resetKey={`${selectedNs}/${currentPath}`}
                  >
                  <Suspense fallback={<div className="editor-loading">Loading drawing editor…</div>}>
                    <ExcalidrawEditor
                      key={`${selectedNs}/${currentPath}#${drawingReloadKey}`}
                      content={content}
                      docPath={`${selectedNs}/${currentPath}#${drawingReloadKey}`}
                      onChange={canWriteCurrent ? handleContentChange : null}
                      readOnly={!canWriteCurrent}
                      libraries={appConfig?.excalidrawLibraries}
                      registerFlush={registerEditorFlush}
                    />
                  </Suspense>
                  </ChunkErrorBoundary>
                )}
              </div>
            ) : (
            <>
              {/* The phone's Edit/Preview switch lives in the toolbar now, as
                  the third option of Basic | Live | Preview. */}
              {(isMobile ? mobileView === 'editor' : viewMode !== 'preview') && (
                <div
                  ref={editorWrapperRef}
                  className={`editor-wrapper${mobileView === 'editor' ? ' mobile-active' : ''}`}
                  style={!isMobile && viewMode === 'split' ? { flex: `0 0 ${splitRatio}%` } : undefined}
                >
                  {content === null ? (
                    <div className="editor-loading">Loading note…</div>
                  ) : editorModeForNote === 'live' ? (
                    <EditorErrorBoundary
                      resetKey={`${selectedNs}/${currentPath}`}
                      onError={() => {
                        // Live editor blew up on this file (Milkdown
                        // parse, plugin init, node-view crash, etc.).
                        // Auto-fallback to Basic so the user can still
                        // edit, persist that choice, and remember the
                        // path so the banner can name it.
                        setLiveCrashedFor(currentPath);
                        setEditorMode('basic');
                        try { localStorage.setItem('mdnest_editor_mode', 'basic'); } catch { /* ignore */ }
                      }}
                    >
                      <Suspense fallback={<div className="editor-loading">Loading live editor...</div>}>
                        {/* key forces a fresh editor instance per note, so the
                            undo stack is per-note (no cross-note Cmd+Z) and never
                            contains the moment-the-prop-was-empty (because we only
                            mount once content is a real string). */}
                        <LiveEditor
                            key={`${selectedNs}/${currentPath}`}
                            content={content}
                            onChange={canWriteCurrent ? handleContentChange : null}
                            readOnly={!canWriteCurrent}
                            ns={selectedNs}
                            currentPath={currentPath}
                            comments={commentsEnabled ? comments : []}
                            onComment={!commentsEnabled ? null : (sel) => {
                              setPendingCommentSelection(sel);
                              setShowComments(true);
                            }}
                            onGoToReady={(fn) => { goToCommentRef.current = fn; }}
                            onWikiLink={openNote}
                            wikiIndex={wikiIndex}
                            onHighlightClick={!commentsEnabled ? null : (commentId) => {
                              setShowComments(true);
                              setHighlightedCommentId(commentId);
                              if (viewMode === 'preview') {
                                setViewMode('editor');
                                localStorage.setItem('mdnest_view_mode', 'editor');
                              }
                            }}
                          />
                      </Suspense>
                    </EditorErrorBoundary>
                  ) : (
                    <Editor
                      key={`${selectedNs}/${currentPath}`}
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
                  {marpEnabled && isMarpDoc(content) ? (
                    <ChunkErrorBoundary label="the slide renderer" resetKey={`${selectedNs}/${currentPath}`}>
                      <Suspense fallback={<div className="editor-loading">Loading slides…</div>}>
                        <MarpDeck content={content || ''} title={currentPath} scrollPct={viewMode === 'split' && !isMobile ? marpScrollPct : undefined} />
                      </Suspense>
                    </ChunkErrorBoundary>
                  ) : (
                    <Preview content={content || ''} currentPath={currentPath} ns={selectedNs} onCheckboxToggle={canWriteCurrent ? handleCheckboxToggle : null} pathIndex={wikiIndex} onWikiLink={openNote} />
                  )}
                </div>
              )}
            </>
            )
          ) : (
            <div className="empty-state">
              <p>{namespaces.length === 0 ? 'No namespaces found. Check your mdnest.conf mounts.' : 'Select a note or create one to get started.'}</p>
            </div>
          )}
        </div>
      </div>
      {showChangePassword && (
        <Settings
          onClose={() => setShowChangePassword(false)}
          userProvider={appConfig?.userProvider}
          themePreference={themePreference}
          resolvedTheme={resolvedTheme}
          onChangeTheme={changeTheme}
          serverDefaultTheme={appConfig?.defaultTheme}
          serverVersion={appConfig?.version}
        />
      )}
      {shareTarget && (
        <ShareDialog
          namespace={shareTarget.namespace}
          path={shareTarget.path}
          onClose={() => setShareTarget(null)}
        />
      )}
      {historyModal && (
        <HistoryModal
          ns={historyModal.ns}
          path={historyModal.path}
          currentETag={etagRef.current}
          canWrite={canWriteCurrent}
          otherUserNames={(presenceUsers || []).filter(u => u.id !== userInfo?.id).map(u => u.username)}
          onClose={() => setHistoryModal(null)}
          onRestored={(text) => {
            // Restore went through saveNote → backend wrote the file →
            // backend broadcast file-changed back to us. The collab
            // handler (case 'file-changed' above) will refresh content
            // and etag. We also update local state immediately so the
            // editor reflects the restored content without waiting for
            // the round-trip through the websocket.
            setContent(text);
            setSavedContent(text);
            setHistoryModal(null);
          }}
        />
      )}
      {attributionModal && (
        <AttributionModal
          ns={attributionModal.ns}
          path={attributionModal.path}
          onClose={() => setAttributionModal(null)}
        />
      )}
      {moveModal && (
        <MoveToModal
          mode={moveModal.mode}
          namespace={moveModal.ns}
          source={moveModal.target}
          onClose={() => setMoveModal(null)}
          onDone={async ({ mode, fromNs, fromPath, ns, path }) => {
            setMoveModal(null);
            if (mode === 'copy') {
              if (ns === selectedNs) await refreshTree(undefined, { broadcast: true });
              setNotice({ kind: 'ok', text: `Copied to ${ns === fromNs ? '' : ns + ':'}${path}` });
              return;
            }
            // A move: follow anything that pointed at the old place — the open
            // note, and each namespace's remembered last note.
            const follow = (p) => (p === fromPath ? path : (p && p.startsWith(fromPath + '/') ? path + p.substring(fromPath.length) : null));
            const lastFrom = getLastPath(fromNs);
            const lastMoved = follow(lastFrom);
            const openMoved = fromNs === selectedNs ? follow(currentPath) : null;
            if (ns === fromNs) {
              if (lastMoved) setLastPath(fromNs, lastMoved);
              await refreshTree(undefined, { broadcast: true });
              if (openMoved) {
                setCurrentPath(openMoved);
                setHash(selectedNs, openMoved);
              }
              return;
            }
            if (lastMoved) setLastPath(fromNs, null);
            if (openMoved) {
              // The open note now lives in another namespace: go with it.
              setLastPath(ns, openMoved);
              handleSelectNs(ns);
            } else {
              await refreshTree(undefined, { broadcast: true });
            }
            setNotice({ kind: 'ok', text: `Moved to ${ns}:${path}` });
          }}
        />
      )}
      {pasteModal && (
        <PasteModal
          namespace={pasteModal.ns}
          folder={pasteModal.folder}
          onClose={() => setPasteModal(null)}
          onPasted={async (path) => {
            setPasteModal(null);
            await refreshTree(undefined, { broadcast: true });
            openNote(path);
          }}
        />
      )}
      {notice && (
        <div className={`download-bar ${notice.kind}`} role="status" data-testid="notice-bar">
          <span>{notice.text}</span>
          {notice.cancel && <button onClick={() => { notice.cancel(); }}>Cancel</button>}
          {notice.action && <button onClick={() => notice.action.run()}>{notice.action.label}</button>}
          {notice.kind !== 'running' && <button onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>}
        </div>
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
        multi={isMulti}
        selectedNs={selectedNs}
        excalidraw={excalidrawEnabled}
        chat={chatEnabled}
      />
      {showReleaseNotes && appConfig?.latestRelease && (
        <ReleaseNotesModal
          release={appConfig.latestRelease}
          runningVersion={appConfig.version}
          onClose={() => setShowReleaseNotes(false)}
          onDismiss={() => {
            const v = appConfig.latestRelease.version;
            localStorage.setItem('mdnest_dismissed_release_version', v);
            setDismissedReleaseVer(v);
            setShowReleaseNotes(false);
          }}
        />
      )}
      {stickiesView === 'panel' && (
        <StickiesPanel
          stickies={stickies}
          onChange={updateStickies}
          onClose={() => setStickiesView('closed')}
          onExpand={() => setStickiesView('board')}
          saveState={stickySaveState}
          loadState={stickiesLoad}
          onRetry={loadStickies}
          width={!isMobile ? commentWidth : undefined}
          onWidthChange={!isMobile ? (w) => { setCommentWidth(w); localStorage.setItem('mdnest_comment_width', String(w)); } : undefined}
        />
      )}
      {stickiesView === 'board' && (
        <StickiesBoard
          stickies={stickies}
          onChange={updateStickies}
          onCollapse={() => setStickiesView('panel')}
          onClose={() => setStickiesView('closed')}
          saveState={stickySaveState}
          loadState={stickiesLoad}
          onRetry={loadStickies}
          isMobile={isMobile}
        />
      )}
      {commentsEnabled && showComments && currentPath && (
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
          width={!isMobile ? commentWidth : undefined}
          onWidthChange={!isMobile ? (w) => { setCommentWidth(w); localStorage.setItem('mdnest_comment_width', String(w)); } : undefined}
        />
      )}
    </div>
  );
}

// isVersionNewer returns true when `a` is a strictly higher semver than `b`.
// Both are bare versions like "3.8.1" (no leading "v"). Missing numeric
// components default to 0 ("3.8" == "3.8.0"). A pre-release suffix
// ("3.11.3-dev", "3.11.3-rc.1") sorts BELOW the same plain release
// ("3.11.3" > "3.11.3-dev"), per semver — so develop's `-dev` builds are
// "ahead of" the last release (no false update banner) but correctly see the
// final release as newer once it ships.
function isVersionNewer(a, b) {
  if (!a || !b) return false;
  const split = (v) => {
    const [rel, pre = ''] = String(v).split('-', 2);
    return { nums: rel.split('.').map((n) => Number(n) || 0), pre };
  };
  const A = split(a), B = split(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const x = A.nums[i] || 0, y = B.nums[i] || 0;
    if (x !== y) return x > y;
  }
  if (A.pre === B.pre) return false;     // identical (incl. both plain releases)
  if (!A.pre) return true;               // a is a release, b is a pre-release
  if (!B.pre) return false;              // a is a pre-release, b is a release
  return A.pre > B.pre;                  // both pre-release → lexical
}

export default App;
