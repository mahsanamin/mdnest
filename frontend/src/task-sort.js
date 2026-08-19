// Ordering for the task board.
//
// A column paints a page of cards at a time, so on a big board the order stops
// being cosmetic and starts deciding what you can see: with tasks in note
// order, an overdue item in a late-alphabet file sits on page 64. Sorting by
// urgency makes the first page the page that matters.
//
// The default stays 'note' on purpose. Note order is what the board has always
// shown, it mirrors the files the tasks live in, and quietly reshuffling every
// existing board — most of which are small enough that paging never applies —
// would be a worse trade than leaving the choice to the reader.

export const SORT_MODES = [
  { id: 'note', label: 'Note order' },
  { id: 'urgency', label: 'Due date, then priority' },
];

const PRIORITY_RANK = { high: 0, medium: 1, normal: 2, low: 3 };

// dueRank turns a due date into something sortable. Anything unparseable or
// absent sorts last rather than first — a task with no date is not urgent, and
// letting a malformed date jump the queue would be worse than ignoring it.
export function dueRank(due) {
  if (!due) return Number.POSITIVE_INFINITY;
  const t = Date.parse(due);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export function priorityRank(priority) {
  if (!priority) return 4;
  const p = String(priority).toLowerCase();
  return p in PRIORITY_RANK ? PRIORITY_RANK[p] : 4;
}

// compareUrgency: soonest due first, then highest priority, then note order.
// The final tiebreak on path+line is what makes the sort stable and repeatable
// — without it, two equally urgent tasks could swap places between renders.
export function compareUrgency(a, b) {
  const da = dueRank(a.due);
  const db = dueRank(b.due);
  if (da !== db) return da < db ? -1 : 1;
  const pa = priorityRank(a.priority);
  const pb = priorityRank(b.priority);
  if (pa !== pb) return pa - pb;
  const pathCmp = String(a.path || '').localeCompare(String(b.path || ''));
  if (pathCmp !== 0) return pathCmp;
  return (a.line || 0) - (b.line || 0);
}

// sortTasks never mutates its input: the board holds the server's list in
// state, and sorting it in place would reorder that too.
export function sortTasks(tasks, mode) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (mode !== 'urgency') return list;
  return [...list].sort(compareUrgency);
}
