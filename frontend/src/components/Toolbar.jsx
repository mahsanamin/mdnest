function Toolbar({ currentPath, onToggleSidebar, onNewNote, onNewFolder, onChangePassword, onRename, onDelete, viewMode, onViewModeChange }) {
  return (
    <div className="toolbar">
      <button className="toolbar-hamburger" onClick={onToggleSidebar} title="Toggle sidebar">
        &#9776;
      </button>
      {onNewNote && (
        <button onClick={onNewNote} title="New note">
          + Note
        </button>
      )}
      {onNewFolder && (
        <button onClick={onNewFolder} title="New folder">
          + Folder
        </button>
      )}
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
      <button className="toolbar-settings" onClick={onChangePassword} title="Settings">
        &#9881;
      </button>
    </div>
  );
}

export default Toolbar;
