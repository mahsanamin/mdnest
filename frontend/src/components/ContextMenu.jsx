import { useEffect, useRef } from 'react';

function ContextMenu({ visible, x, y, target, onAction, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    if (!visible) return;

    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };

    const handleScroll = () => onClose();
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, onClose]);

  // Adjust position to keep menu within viewport
  useEffect(() => {
    if (!visible || !menuRef.current) return;
    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let adjX = x;
    let adjY = y;

    if (rect.right > vw) adjX = vw - rect.width - 8;
    if (rect.bottom > vh) adjY = vh - rect.height - 8;
    if (adjX < 0) adjX = 8;
    if (adjY < 0) adjY = 8;

    menu.style.left = `${adjX}px`;
    menu.style.top = `${adjY}px`;
  }, [visible, x, y]);

  if (!visible) return null;

  const isFolder = target && (target.type === 'folder' || target.type === 'directory');
  const isFile = target && !isFolder && target.path;
  const isEmptyArea = !target;

  const items = [];

  if (isFolder || isEmptyArea) {
    items.push({ label: 'New Note', action: 'new-note' });
    items.push({ label: 'New Folder', action: 'new-folder' });
  }

  if (isFolder) {
    items.push({ label: 'Delete Folder', action: 'delete-folder', danger: true });
  }

  if (isFile) {
    items.push({ label: 'Delete', action: 'delete-file', danger: true });
  }

  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <div
          key={item.action}
          className={`context-menu-item${item.danger ? ' danger' : ''}`}
          onClick={() => {
            onAction(item.action, target);
            onClose();
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}

export default ContextMenu;
