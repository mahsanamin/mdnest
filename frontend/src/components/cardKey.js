// A task is identified across the UI by its source location, which is unique
// even when two items share the same text. In the global (cross-namespace) view
// two namespaces can share a note path + line, so the namespace is part of the
// key. The backend id is content-derived and can collide, so it is not used.
//
// The line alone is NOT stable, though: moving a task writes a `status:` line
// under it and shifts every task below it in that note. A refresh that brings
// the new lines in then re-keyed those cards, and a drag starting or running
// at that moment ended up bound to whichever card now held its old key — the
// drop moved the wrong task, or nothing. So a loaded task carries a `uid`
// (see withStableIds) that survives line shifts, and cardKey prefers it.
export function cardKey(t) {
  return t.uid || `${t.namespace || ''}\u0000${t.path}\u0000${t.line}`;
}

let uidSeq = 0;
const sigOf = (t) => `${t.namespace || ''}\u0000${t.path}\u0000${t.raw}`;

// withStableIds gives every task in a freshly fetched list the uid its
// counterpart had in the previous list, matched by note + raw line + which
// occurrence of that line it is (so two identical lines in one note stay
// distinct and keep their order). A task that is new, or whose line text
// changed (edited, ticked), gets a fresh uid.
export function withStableIds(prev, next) {
  const pool = new Map();
  for (const t of prev) {
    if (!t.uid) continue;
    const k = sigOf(t);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(t.uid);
  }
  return next.map((t) => {
    const reuse = pool.get(sigOf(t));
    return { ...t, uid: (reuse && reuse.shift()) || `t${++uidSeq}` };
  });
}

// relocateTask finds `stale` in a freshly fetched task list after its note
// changed underneath the board — most often the board's own previous move,
// which writes a `status:` line and shifts every task below it down. Same
// namespace + path + raw line; if the text appears more than once, the copy
// nearest the old line wins. Returns null when it is gone or was edited.
export function relocateTask(tasks, stale) {
  let best = null;
  for (const t of tasks) {
    if ((t.namespace || '') !== (stale.namespace || '') || t.path !== stale.path || t.raw !== stale.raw) continue;
    if (!best || Math.abs(t.line - stale.line) < Math.abs(best.line - stale.line)) best = t;
  }
  return best;
}
