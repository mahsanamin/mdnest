import { useState, useCallback } from 'react';

function Toolbar({ currentPath, onToggleSidebar, onRevealInTree, onChangePassword, onRename, onDelete, viewMode, onViewModeChange, editorMode, onEditorModeChange, onRefresh, wsStatus, commentCount, onToggleComments, onOpenBoard, boardActive }) {
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    onRefresh().finally(() => setTimeout(() => setRefreshing(false), 2000));
  }, [refreshing, onRefresh]);

  // Allow flipping Basic/Live even when no file is open — so a user whose
  // Live-mode crashed on the previous file can pre-switch to Basic before
  // opening the next one. Requires viewMode !== 'preview' (editor isn't
  // visible in preview-only mode anyway).
  const showEditorToggle = viewMode !== 'preview' && onEditorModeChange;

  return (
    <div className="toolbar">
      <button className="toolbar-hamburger" onClick={onToggleSidebar} title="Toggle sidebar">
        &#9776;
      </button>
      {(showEditorToggle || onOpenBoard) && (
        <div className="editor-mode-toggle">
          {showEditorToggle && (
            <>
              <button
                className={!boardActive && editorMode === 'basic' ? 'active' : ''}
                onClick={() => onEditorModeChange('basic')}
                title="Plain text editor"
              >Basic</button>
              <button
                className={!boardActive && editorMode === 'live' ? 'active' : ''}
                onClick={() => onEditorModeChange('live')}
                title="Live rich editor"
              >Live</button>
            </>
          )}
          {onOpenBoard && (
            <button
              className={boardActive ? 'active' : ''}
              onClick={onOpenBoard}
              title="Namespace task board"
            >Board</button>
          )}
        </div>
      )}
      {/* Path display splits dir + basename so the filename never gets
          ellipsized away on narrow screens. .toolbar-path-dir shrinks
          and ellipsizes; .toolbar-path-base has flex-shrink: 0 so it
          stays visible even when the toolbar is cramped. Full path is
          on the title="" attribute for desktop hover reveal. */}
      <span className="toolbar-path" title={currentPath || ''}>
        {!currentPath && 'No file selected'}
        {currentPath && (() => {
          const idx = currentPath.lastIndexOf('/');
          const dir = idx >= 0 ? currentPath.substring(0, idx + 1) : '';
          const base = idx >= 0 ? currentPath.substring(idx + 1) : currentPath;
          return (
            <>
              {dir && <span className="toolbar-path-dir">{dir}</span>}
              <span className="toolbar-path-base">{base}</span>
            </>
          );
        })()}
        {currentPath && onRevealInTree && (
          <button
            className="toolbar-inline-reveal"
            onClick={onRevealInTree}
            title="Reveal in tree"
            aria-label="Reveal current file in the tree"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
            </svg>
          </button>
        )}
        {currentPath && (
          <button
            className={`toolbar-inline-refresh${refreshing ? ' spinning' : ''}`}
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh"
          >&#8635;</button>
        )}
        {currentPath && (onRename || onDelete) && (
          <span className="toolbar-path-actions">
            {onRename && <button className="toolbar-inline-action" onClick={onRename} title="Rename">Rename</button>}
            {onDelete && <button className="toolbar-inline-action danger" onClick={onDelete} title="Delete">Delete</button>}
          </span>
        )}
      </span>
      {/* View mode toggle is shown even without a file open so the user can
          never get trapped in a mode that crashed on the previous file. The
          buttons just mutate the persisted preference; they take effect
          when the next file is opened. */}
      {onViewModeChange && (
        <div className="toolbar-view-toggle">
          <button
            className={viewMode === 'editor' ? 'active' : ''}
            onClick={() => onViewModeChange('editor')}
            title="Editor only"
          >
            &#9998;
          </button>
          <button
            className={viewMode === 'split' ? 'active' : ''}
            onClick={() => onViewModeChange('split')}
            title="Split view"
          >
            &#9109;
          </button>
          <button
            className={viewMode === 'preview' ? 'active' : ''}
            onClick={() => onViewModeChange('preview')}
            title="Preview only"
          >
            &#9673;
          </button>
        </div>
      )}
      {wsStatus && currentPath && (
        <span className={`ws-status ${wsStatus}`}>
          <span className={`ws-status-dot ${wsStatus}`} />
          <span className="ws-status-text">
            {wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Reconnecting' : wsStatus === 'superseded' ? 'Session moved' : 'Offline'}
          </span>
        </span>
      )}
      {currentPath && onToggleComments && (
        <button className="toolbar-comments" onClick={onToggleComments} title="Comments">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
          {commentCount > 0 && <span className="comment-badge">{commentCount}</span>}
        </button>
      )}
      <button className="toolbar-settings" onClick={onChangePassword} title="Settings">
        &#9881;
      </button>
    </div>
  );
}

export default Toolbar;
