// The URL hash — pure, no React, no window. Shapes:
//
//   #ns/path/to/note.md          a note (or just #ns)
//   #!board/ns[/path/to/note.md]  the task board, opened over that namespace
//                                (and the note it was opened from, if any)
//   #!stickies                   the full-screen sticky board
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

function parseNote(rest) {
  if (!rest) return { ns: null, path: null };
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return { ns: decodeURIComponent(rest), path: null };
  return {
    ns: decodeURIComponent(rest.substring(0, slashIdx)),
    path: decodeURIComponent(rest.substring(slashIdx + 1)) || null,
  };
}

export function parseRoute(hash) {
  const h = (hash || '').replace(/^#\/?/, '');
  if (h === STICKIES_ROUTE) return { ns: null, path: null, stickies: true, board: false };
  if (h === BOARD_ROUTE || h.startsWith(BOARD_ROUTE + '/')) {
    return { ...parseNote(h.slice(BOARD_ROUTE.length + 1)), stickies: false, board: true };
  }
  return { ...parseNote(h), stickies: false, board: false };
}

export function formatRoute({ ns, path, stickies, board }) {
  if (stickies) return '#' + STICKIES_ROUTE;
  let note = '';
  if (ns) {
    note = encodeURIComponent(ns);
    if (path) note += '/' + path.split('/').map(encodeURIComponent).join('/');
  }
  if (board && ns) return `#${BOARD_ROUTE}/${note}`;
  return '#' + note;
}
