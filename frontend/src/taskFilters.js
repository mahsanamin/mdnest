// Client-side task filtering shared by the board views. Kept pure and separate
// from the component so the predicate can be unit-tested without rendering.

// matchesTaskFilters reports whether a task passes the active filters:
//   - search: case-insensitive substring match on the title
//   - tags:   the task must carry at least one of the selected tags (OR)
//   - assignee: '@me' (=== currentUser), '@unassigned' (empty assignee),
//               or an exact username; '' means any assignee
export function matchesTaskFilters(task, { search = '', tags = [], assignee = '', currentUser = '' } = {}) {
  const q = String(search).trim().toLowerCase();
  if (q && !String(task.text || '').toLowerCase().includes(q)) return false;
  if (tags.length && !(task.tags || []).some((tg) => tags.includes(tg))) return false;
  const who = String(task.assignee || '').trim();
  if (assignee === '@me') return who === (currentUser || '');
  if (assignee === '@unassigned') return who === '';
  if (assignee) return who === assignee;
  return true;
}
