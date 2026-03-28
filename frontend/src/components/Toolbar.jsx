function Toolbar({ currentPath, onToggleSidebar, onNewNote, onNewFolder, onChangePassword, onRename, onDelete, viewMode, onViewModeChange }) {
  let dirHint = '';
  if (currentPath) {
    const parts = currentPath.split('/');
    parts.pop();
    dirHint = parts.length > 0 ? parts.join('/') + '/' : '';
  }

  return (
    <div className="toolbar">
      <button className="toolbar-hamburger" onClick={onToggleSidebar} title="Toggle sidebar">
        &#9776;
      </button>
      {onNewNote && (
        <button onClick={onNewNote} title={dirHint ? `New note in ${dirHint}` : 'New note at root'}>
          + Note
        </button>
      )}
      {onNewFolder && (
        <button onClick={onNewFolder} title={dirHint ? `New folder in ${dirHint}` : 'New folder at root'}>
          + Folder
        </button>
      )}
      <span className="toolbar-path">
        {currentPath || 'No file selected'}
      </span>
      {currentPath && (
        <>
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
          {(onRename || onDelete) && (
            <div className="toolbar-file-actions">
              {onRename && (
                <button className="toolbar-action" onClick={onRename} title="Rename file">
                  Rename
                </button>
              )}
              {onDelete && (
                <button className="toolbar-action danger" onClick={onDelete} title="Delete file">
                  Delete
                </button>
              )}
            </div>
          )}
        </>
      )}
      <button className="toolbar-settings" onClick={onChangePassword} title="Settings">
        &#9881;
      </button>
    </div>
  );
}

export default Toolbar;
