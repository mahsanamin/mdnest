import { useState, useEffect, useRef, useCallback } from 'react';

function TreeNode({ node, onSelect, currentPath, depth, onContextMenu, onDrop, expandAll }) {
  const isFolder = node.type === 'folder' || node.type === 'directory';
  const isActive = currentPath === node.path;
  const longPressTimer = useRef(null);
  const touchMoved = useRef(false);
  const [dragOver, setDragOver] = useState(false);

  const containsActive = isFolder && currentPath && node.path &&
    currentPath.startsWith(node.path + '/');

  const [expanded, setExpanded] = useState(depth < 1 || containsActive);

  // Auto-expand when a file inside is opened
  useEffect(() => {
    if (containsActive && !expanded) setExpanded(true);
  }, [containsActive]);

  // Expand all / collapse all
  useEffect(() => {
    if (expandAll === true) setExpanded(true);
    else if (expandAll === false) setExpanded(depth < 1 || containsActive);
  }, [expandAll]);

  const handleClick = () => {
    if (isFolder) setExpanded(!expanded);
    else onSelect(node.path);
  };

  const handleRightClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) onContextMenu(e.clientX, e.clientY, node);
  }, [node, onContextMenu]);

  const handleTouchStart = useCallback((e) => {
    touchMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!touchMoved.current && onContextMenu) {
        const touch = e.touches[0];
        onContextMenu(touch.clientX, touch.clientY, node);
      }
    }, 500);
  }, [node, onContextMenu]);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  const handleTouchMove = useCallback(() => {
    touchMoved.current = true;
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  const handleDragStart = useCallback((e) => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', JSON.stringify({ path: node.path, name: node.name, type: node.type }));
    e.dataTransfer.effectAllowed = 'move';
  }, [node]);

  const handleDragOver = useCallback((e) => {
    if (!isFolder) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  }, [isFolder]);

  const handleDragLeave = useCallback((e) => { e.stopPropagation(); setDragOver(false); }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!isFolder || !onDrop) return;
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.path && data.path !== node.path) {
        if (node.path && data.path.startsWith(node.path + '/')) return;
        onDrop(data.path, node.path);
      }
    } catch (err) { /* ignore */ }
  }, [isFolder, node, onDrop]);

  const name = node.name || node.path.split('/').filter(Boolean).pop() || node.path;

  // File extension for icon
  const ext = !isFolder ? (name.split('.').pop() || '').toLowerCase() : '';
  const fileIcon = ext === 'md' ? '📝' : ext === 'json' ? '📋' : ext === 'txt' ? '📄' : '📄';

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isActive ? ' active' : ''}${dragOver ? ' drag-over' : ''}`}
        style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        title={node.path}
      >
        {isFolder && (
          <span className="tree-arrow">{expanded ? '▾' : '▸'}</span>
        )}
        <span className="tree-icon">
          {isFolder
            ? (expanded ? '📂' : '📁')
            : fileIcon
          }
        </span>
        <span className="tree-label">{name}</span>
      </div>
      {isFolder && expanded && node.children && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode
              key={child.path || child.name}
              node={child}
              onSelect={onSelect}
              currentPath={currentPath}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onDrop={onDrop}
              expandAll={expandAll}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default TreeNode;
