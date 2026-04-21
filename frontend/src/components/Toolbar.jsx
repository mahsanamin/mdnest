import { useState, useCallback } from 'react';

function Toolbar({ currentPath, onToggleSidebar, onChangePassword, onRename, onDelete, viewMode, onViewModeChange, editorMode, onEditorModeChange, onRefresh, wsStatus, commentCount, onToggleComments }) {
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    onRefresh().finally(() => setTimeout(() => setRefreshing(false), 2000));
  }, [refreshing, onRefresh]);

  const showEditorToggle = currentPath && viewMode === 'editor' && onEditorModeChange;

  return (
    <div className="toolbar">
      <button className="toolbar-hamburger" onClick={onToggleSidebar} title="Toggle sidebar">
        &#9776;
      </button>
      {showEditorToggle && (
        <div className="editor-mode-toggle">
          <button
            className={editorMode === 'basic' ? 'active' : ''}
            onClick={() => onEditorModeChange('basic')}
            title="Plain text editor"
          >Basic</button>
          <button
            className={editorMode === 'live' ? 'active' : ''}
            onClick={() => onEditorModeChange('live')}
            title="Live rich editor"
          >Live</button>
        </div>
      )}
      <span className="toolbar-path">
        {currentPath || 'No file selected'}
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
      {currentPath && (
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
