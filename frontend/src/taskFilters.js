// Client-side task filtering shared by the board views. Kept pure and separate
// from the component so the predicate can be unit-tested without rendering.

// matchesTaskFilters reports whether a task passes the active filters:
//   - search: case-insensitive substring match on the title
//   - tags:   the task must carry at least one of the selected tags (OR)
//   - assignee: '@me' (=== currentUser), '@unassigned' (empty assignee),
//               or an exact username; '' means any assignee
//   - priority: exact (case-insensitive) match on the task's priority; '' = any
//   - relation: 'any' (has any relation), 'depends-on', 'blocked-by' or
//               'related-to' (has that relation kind); '' = ignore
//   - showDone + doneColumns: when showDone is false, tasks sitting in a "done"
//               column are hidden (active work is the default focus)
export function matchesTaskFilters(task, { search = '', tags = [], assignee = '', priority = '', relation = '', showDone = true, doneColumns = [], currentUser = '' } = {}) {
  const q = String(search).trim().toLowerCase();
  if (q && !String(task.text || '').toLowerCase().includes(q)) return false;
  if (tags.length && !(task.tags || []).some((tg) => tags.includes(tg))) return false;
  if (priority && String(task.priority || '').toLowerCase() !== String(priority).toLowerCase()) return false;
  if (relation) {
    const deps = task.dependsOn || [];
    const blk = task.blockedBy || [];
    const rel = task.relatedTo || [];
    if (relation === 'any' && !(deps.length || blk.length || rel.length)) return false;
    if (relation === 'depends-on' && !deps.length) return false;
    if (relation === 'blocked-by' && !blk.length) return false;
    if (relation === 'related-to' && !rel.length) return false;
  }
  if (!showDone && doneColumns.includes(task.column)) return false;
  const who = String(task.assignee || '').trim();
  if (assignee === '@me') return who === (currentUser || '');
  if (assignee === '@unassigned') return who === '';
  if (assignee) return who === assignee;
  return true;
}
