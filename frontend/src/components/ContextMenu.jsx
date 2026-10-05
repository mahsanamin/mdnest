import { useEffect, useRef } from 'react';
import { contextMenuGroups } from '../contextMenuItems.js';

// One small stroke icon per action, so the eye can find an item without
// reading every label. Same drawing style as the toolbar's ⋯ menu.
const ICONS = {
  note: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/></>,
  folder: <><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M12 10v6M9 13h6"/></>,
  drawing: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></>,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>,
  paste: <><rect x="6" y="4" width="12" height="17" rx="1.5"/><path d="M9 4V3h6v1M12 10v6M9.5 13.5 12 16l2.5-2.5"/></>,
  rename: <><path d="M4 7V5h11v2M9.5 5v14M7 19h5"/><path d="M17 10v9M15 10h4M15 19h4"/></>,
  move: <><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 13h6M13 10.5l2.5 2.5-2.5 2.5"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></>,
  download: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4 19h16"/></>,
  clipboard: <><rect x="6" y="4" width="12" height="17" rx="1.5"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></>,
  history: <><path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v4h4M12 8v4l3 2"/></>,
  people: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></>,
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>,
};

function ContextMenu({ visible, x, y, target, onAction, onClose, canWrite, isAdmin, multi, selectedNs, excalidraw, chat }) {
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

  // Check write permission for the target path
  const targetPath = target?.path || '';
  const hasWrite = !canWrite || canWrite(targetPath);
  const groups = contextMenuGroups({ target, hasWrite, isAdmin, multi, excalidraw, chat });
  if (groups.length === 0) return null;

  // The clicked item's name heads the menu, so it is clear what Rename or
  // Delete would act on. The namespace root shows the namespace.
  const title = targetPath ? targetPath.split('/').pop() : selectedNs;

  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: x, top: y }}
      role="menu"
    >
      {title && <div className="context-menu-title" title={targetPath || selectedNs}>{title}</div>}
      {groups.map((group, gi) => (
        <div key={gi} className="context-menu-group">
          {gi > 0 && <div className="context-menu-sep" />}
          {group.map((item) => (
            <div
              key={item.action}
              role="menuitem"
              className={`context-menu-item${item.danger ? ' danger' : ''}`}
              onClick={() => {
                onAction(item.action, target);
                onClose();
              }}
            >
              <svg className="context-menu-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {ICONS[item.icon]}
              </svg>
              {item.label}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default ContextMenu;
