import { useState, useRef, useCallback } from 'react';

const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

function TreeNode({ node, onSelect, currentPath, depth, onContextMenu, onDrop, expandedPaths, onToggleExpand, forceExpand }) {
  const isFolder = node.type === 'folder' || node.type === 'directory';
  const isActive = currentPath === node.path;
  const longPressTimer = useRef(null);
  const touchMoved = useRef(false);
  const longPressFired = useRef(false);
  const [dragOver, setDragOver] = useState(false);

  // Expansion is controlled purely by the per-namespace `expandedPaths` set
  // owned by Sidebar (persisted, so it survives refresh / namespace switches),
  // plus `forceExpand` while a search is running so matches are visible. We do
  // NOT force a folder open just because it contains the active file — Sidebar
  // auto-adds the open file's ancestors to the set instead, which keeps them
  // collapsible (forcing it here made such folders impossible to collapse).
  const expanded = isFolder && (forceExpand || expandedPaths.has(node.path));

  const handleClick = () => {
    if (isFolder) onToggleExpand(node.path);
    else onSelect(node.path);
  };

  const handleRightClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) onContextMenu(e.clientX, e.clientY, node);
  }, [node, onContextMenu]);

  const handleTouchStart = useCallback((e) => {
    // Stop the bubble so the parent .sidebar-tree's empty-area long-press
    // timer doesn't ALSO schedule and fire ~the same 500ms later with
    // target=null, overwriting our file/folder menu with the empty-area
    // ("New Note / New Folder" only) one. Mirrors what handleRightClick
    // does for desktop.
    e.stopPropagation();
    touchMoved.current = false;
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!touchMoved.current && onContextMenu) {
        longPressFired.current = true;
        const touch = e.touches[0];
        onContextMenu(touch.clientX, touch.clientY, node);
      }
    }, 500);
  }, [node, onContextMenu]);

  const handleTouchEnd = useCallback((e) => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    // Prevent the tap from firing click after a long press opened the context menu
    if (longPressFired.current) {
      e.preventDefault();
      longPressFired.current = false;
    }
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
        // Block dropping a folder INTO its own descendant (circular move)
        // e.g. dragging Dir_O onto Dir_O/Dir_B — node.path starts with data.path
        if (node.path && node.path.startsWith(data.path + '/')) return;
        // Block dropping into the SAME parent it's already in (no-op)
        const fromParent = data.path.includes('/') ? data.path.substring(0, data.path.lastIndexOf('/')) : '';
        if (node.path === fromParent) return;
        onDrop(data.path, node.path);
      }
    } catch (err) { /* ignore */ }
  }, [isFolder, node, onDrop]);

  const name = node.name || node.path.split('/').filter(Boolean).pop() || node.path;

  const hasChildren = isFolder && node.children && node.children.length > 0;

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isActive ? ' active' : ''}${dragOver ? ' drag-over' : ''}`}
        // CSS variable so .tree-row can compute its padding differently
        // per breakpoint (desktop: 0.75rem/level, mobile: 0.4rem/level).
        // See .tree-row in App.css.
        style={{ '--tree-depth': depth }}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        draggable={!isTouchDevice}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        title={name + (node.path ? '\n' + node.path : '')}
      >
        {isFolder ? (
          hasChildren
            ? <span className="tree-arrow">{expanded ? '\u25BE' : '\u25B8'}</span>
            : <span className="tree-arrow-spacer" />
        ) : (
          <span className="tree-arrow-spacer" />
        )}
        <span className={`tree-icon-svg ${isFolder ? (expanded ? 'folder-open' : (hasChildren ? 'folder-full' : 'folder-empty')) : 'file'}`} />
        <span className={`tree-label${isFolder && !hasChildren ? ' empty-folder' : ''}`}>{name}</span>
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
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              forceExpand={forceExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default TreeNode;
