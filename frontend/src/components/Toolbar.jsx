function Toolbar({ currentPath, onToggleSidebar, onNewNote, onNewFolder, onChangePassword, onRename, onDelete }) {
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
      <button onClick={onNewNote} title={dirHint ? `New note in ${dirHint}` : 'New note at root'}>
        + Note
      </button>
      <button onClick={onNewFolder} title={dirHint ? `New folder in ${dirHint}` : 'New folder at root'}>
        + Folder
      </button>
      <span className="toolbar-path">
        {currentPath || 'No file selected'}
      </span>
      {currentPath && (
        <div className="toolbar-file-actions">
          <button className="toolbar-action" onClick={onRename} title="Rename file">
            Rename
          </button>
          <button className="toolbar-action danger" onClick={onDelete} title="Delete file">
            Delete
          </button>
        </div>
      )}
      <button className="toolbar-settings" onClick={onChangePassword} title="Change credentials">
        &#9881;
      </button>
    </div>
  );
}

export default Toolbar;
