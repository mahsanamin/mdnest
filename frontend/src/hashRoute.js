// The URL hash — pure, no React, no window. Shapes:
//
//   #ns/path/to/note.md          a note (or just #ns)
//   #ns/path/to/note.md#Heading  a note, scrolled to that heading. Path
//                                segments are percent-encoded, so a "#"
//                                in a file name is %23 and the first raw
//                                "#" can only start the heading.
//   #!board/ns[/path/to/note.md]  the task board, opened over that namespace
//                                (and the note it was opened from, if any)
//   #!stickies                   the full-screen sticky board
//   #!chats[/ns/path/to/chat.md]  the chats view, optionally with one chat open
//
// The task board keeps its namespace and note in the URL, unlike the sticky
// board: it is scoped to a namespace, its "This note" filter and its back
// button both depend on the note underneath, so a refresh or a shared link
// has to restore both. Before this it had no route at all, so a refresh
// always dropped you back into the editor.
//
// Markers start with "!" because a namespace is a directory name the
// operator chooses; a namespace called `stickies` or `board` would otherwise
// become unreachable. A leading "!" cannot be one.
export const STICKIES_ROUTE = '!stickies';
export const BOARD_ROUTE = '!board';
// Chats span namespaces, so the ns/path here is the OPEN CHAT, not the note
// underneath (the editor's note is left alone while the chats view is up).
export const CHATS_ROUTE = '!chats';

function parseNote(rest) {
  if (!rest) return { ns: null, path: null };
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    const heading = safeDecode(rest.slice(hashIdx + 1)).trim();
    const note = parseNote(rest.slice(0, hashIdx));
    return note.path && heading ? { ...note, heading } : note;
  }
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return { ns: decodeURIComponent(rest), path: null };
  return {
    ns: decodeURIComponent(rest.substring(0, slashIdx)),
    path: decodeURIComponent(rest.substring(slashIdx + 1)) || null,
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function parseRoute(hash) {
  const h = (hash || '').replace(/^#\/?/, '');
  if (h === STICKIES_ROUTE) return { ns: null, path: null, stickies: true, board: false };
  if (h === CHATS_ROUTE || h.startsWith(CHATS_ROUTE + '/')) {
    const chat = parseNote(h.slice(CHATS_ROUTE.length + 1));
    return { ns: null, path: null, stickies: false, board: false, chats: true,
      chat: chat.ns && chat.path ? chat : null };
  }
  if (h === BOARD_ROUTE || h.startsWith(BOARD_ROUTE + '/')) {
    return { ...parseNote(h.slice(BOARD_ROUTE.length + 1)), stickies: false, board: true };
  }
  return { ...parseNote(h), stickies: false, board: false };
}

function formatNote(ns, path) {
  let note = encodeURIComponent(ns);
  if (path) note += '/' + path.split('/').map(encodeURIComponent).join('/');
  return note;
}

// The heading is a one-off: it is in a copied link and is consumed when the
// note opens, so App never writes it back.
export function formatRoute({ ns, path, stickies, board, chats, chat, heading }) {
  if (stickies) return '#' + STICKIES_ROUTE;
  if (chats) return chat?.ns && chat?.path ? `#${CHATS_ROUTE}/${formatNote(chat.ns, chat.path)}` : '#' + CHATS_ROUTE;
  let note = '';
  if (ns) {
    note = encodeURIComponent(ns);
    if (path) note += '/' + path.split('/').map(encodeURIComponent).join('/');
  }
  if (board && ns) return `#${BOARD_ROUTE}/${note}`;
  if (path && heading) note += '#' + encodeURIComponent(heading);
  return '#' + note;
}
