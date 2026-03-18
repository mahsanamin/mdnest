import { useRef, useCallback, useState } from 'react';
import TreeNode from './TreeNode.jsx';

function Sidebar({
  tree,
  onSelect,
  currentPath,
  namespaces,
  selectedNs,
  onSelectNs,
  onContextMenu,
  onDrop,
  visible,
  onClose,
}) {
  const treeAreaRef = useRef(null);
  const longPressTimer = useRef(null);
  const touchMoved = useRef(false);
  // null = default, true = expand all, false = collapse all
  const [expandAll, setExpandAll] = useState(null);

  const handleExpandAll = () => setExpandAll(true);
  const handleCollapseAll = () => setExpandAll(false);
  // Reset after toggling so individual folders can be toggled again
  const resetExpandAll = () => setTimeout(() => setExpandAll(null), 50);

  const handleEmptyContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onContextMenu) onContextMenu(e.clientX, e.clientY, null);
  }, [onContextMenu]);

  const handleEmptyTouchStart = useCallback((e) => {
    touchMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!touchMoved.current && onContextMenu) {
        const touch = e.touches[0];
        onContextMenu(touch.clientX, touch.clientY, null);
      }
    }, 500);
  }, [onContextMenu]);

  const handleEmptyTouchEnd = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  const handleEmptyTouchMove = useCallback(() => {
    touchMoved.current = true;
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  return (
    <>
      {visible && <div className="sidebar-backdrop" onClick={onClose} />}
      <div className={`sidebar${visible ? ' sidebar-open' : ''}`}>
        <div className="sidebar-header">
          {namespaces.length > 1 ? (
            <select
              className="ns-select"
              value={selectedNs || ''}
              onChange={(e) => onSelectNs(e.target.value)}
            >
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
          ) : (
            <span className="ns-label">{selectedNs || 'mdnest'}</span>
          )}
          <div className="sidebar-tree-controls">
            <button
              className="tree-control-btn"
              onClick={() => { handleExpandAll(); resetExpandAll(); }}
              title="Expand all"
            >⊞</button>
            <button
              className="tree-control-btn"
              onClick={() => { handleCollapseAll(); resetExpandAll(); }}
              title="Collapse all"
            >⊟</button>
          </div>
        </div>
        <div
          className="sidebar-tree"
          ref={treeAreaRef}
          onContextMenu={handleEmptyContextMenu}
          onTouchStart={handleEmptyTouchStart}
          onTouchEnd={handleEmptyTouchEnd}
          onTouchMove={handleEmptyTouchMove}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => {
            e.preventDefault();
            try {
              const data = JSON.parse(e.dataTransfer.getData('text/plain'));
              if (data.path && onDrop) onDrop(data.path, '');
            } catch (err) { /* ignore */ }
          }}
        >
          {Array.isArray(tree) && tree.map((node) => (
            <TreeNode
              key={node.path || node.name}
              node={node}
              onSelect={onSelect}
              currentPath={currentPath}
              depth={0}
              onContextMenu={onContextMenu}
              onDrop={onDrop}
              expandAll={expandAll}
            />
          ))}
          {(!tree || tree.length === 0) && (
            <div className="sidebar-empty">No files yet</div>
          )}
        </div>
      </div>
    </>
  );
}

export default Sidebar;
