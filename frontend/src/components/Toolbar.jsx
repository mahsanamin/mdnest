import { useState, useCallback } from 'react';

function Toolbar({ currentPath, onToggleSidebar, onChangePassword, onRename, onDelete, viewMode, onViewModeChange, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    onRefresh().finally(() => setTimeout(() => setRefreshing(false), 2000));
  }, [refreshing, onRefresh]);
  return (
    <div className="toolbar">
      <button className="toolbar-hamburger" onClick={onToggleSidebar} title="Toggle sidebar">
        &#9776;
      </button>
      <span className="toolbar-path">
        {currentPath || 'No file selected'}
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
      <button
        className={`toolbar-refresh${refreshing ? ' spinning' : ''}`}
        onClick={handleRefresh}
        disabled={refreshing}
        title="Refresh"
      >
        &#8635;
      </button>
      <button className="toolbar-settings" onClick={onChangePassword} title="Settings">
        &#9881;
      </button>
    </div>
  );
}

export default Toolbar;
