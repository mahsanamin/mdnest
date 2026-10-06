// Pure module: what the tree's right-click menu offers, in what order.
//
// The menu used to grow one feature at a time, so it read as a pile: Delete
// sat in the middle of the file menu, the copy actions were split across two
// groups, and Authors was offered in single mode, where its route does not
// exist. Items now come in fixed groups, in this order, with Delete always
// last and on its own:
//
//   create    New note / folder / drawing / chat, Paste here   (folder, root)
//   organize  Rename, Move to…, Copy to…
//   share     Download, Copy for another mdnest, Copy path for CLI
//   info      History, Authors                                  (files)
//   admin     Manage access
//   danger    Delete
//
// Each group is a list of { label, action, icon, hint?, danger? }; the component
// draws a divider between non-empty groups. Labels are what the browser specs
// click, so change one only together with tests/browser.

export function contextMenuGroups({
  target, hasWrite = true, isAdmin = false, multi = false, excalidraw = false, chat = false,
}) {
  const isFolder = !!target && (target.type === 'folder' || target.type === 'directory');
  const isFile = !!target && !isFolder && !!target.path;
  const isRoot = !target;
  const path = (target?.path || '').toLowerCase();

  const create = [];
  if ((isFolder || isRoot) && hasWrite) {
    create.push({ label: 'New note', action: 'new-note', icon: 'note' });
    create.push({ label: 'New folder', action: 'new-folder', icon: 'folder' });
    if (excalidraw) create.push({ label: 'New drawing', action: 'new-drawing', icon: 'drawing' });
    if (chat) create.push({ label: 'New chat', action: 'new-chat', icon: 'chat' });
    // A note copied with "Copy for another mdnest", possibly on another server.
    create.push({ label: 'Paste here', action: 'paste-here', icon: 'paste' });
  }

  const organize = [];
  if ((isFile || isFolder) && hasWrite) {
    organize.push({ label: 'Rename', action: 'rename', icon: 'rename' });
    organize.push({ label: 'Move to…', action: 'move', icon: 'move' });
  }
  // Copy needs only read access here: the picker's dry run checks write on
  // the destination.
  if (isFile || isFolder) organize.push({ label: 'Copy to…', action: 'copy-to', icon: 'copy' });

  const share = [];
  if (isFile || isFolder) {
    share.push({ label: isFolder ? 'Download as zip' : 'Download', action: 'download', icon: 'download' });
    if (isFile && (path.endsWith('.md') || path.endsWith('.txt'))) {
      share.push({ label: 'Copy for another mdnest', action: 'copy-clipboard', icon: 'clipboard' });
    }
    // It copies an mdnest:// address for the CLI and agents, not a file-system
    // path; the plain "Copy path" read as the latter.
    share.push({ label: 'Copy path for CLI', action: 'copy-path', icon: 'link', hint: 'Copies an mdnest:// address that the mdnest CLI and agents accept' });
  }

  // History works for any readable file; the modal explains when git-sync is
  // off. Authors reads the attribution route, which only exists with a
  // database (multi mode).
  const info = [];
  if (isFile) {
    info.push({ label: 'History', action: 'history', icon: 'history' });
    if (multi) info.push({ label: 'Authors', action: 'authors', icon: 'people' });
  }

  const admin = [];
  if ((isFolder || isRoot) && isAdmin) admin.push({ label: 'Manage access', action: 'manage-access', icon: 'lock' });

  const danger = [];
  if (isFile && hasWrite) danger.push({ label: 'Delete', action: 'delete-file', icon: 'trash', danger: true });
  if (isFolder && hasWrite) danger.push({ label: 'Delete folder', action: 'delete-folder', icon: 'trash', danger: true });

  return [create, organize, share, info, admin, danger].filter((g) => g.length > 0);
}

// The chat list's right-click menu (one chat). Same component and look as the
// tree's; open is the plain click, so the menu holds what a click cannot do.
export function chatMenuGroups({ canDelete = false } = {}) {
  return [
    [{ label: 'Open as note', action: 'open-note', icon: 'note' }],
    [{ label: 'Copy path for CLI', action: 'copy-path', icon: 'link', hint: 'Copies an mdnest:// address that the mdnest CLI and agents accept' }],
    canDelete ? [{ label: 'Delete chat', action: 'delete-chat', icon: 'trash', danger: true }] : [],
  ].filter((g) => g.length > 0);
}
