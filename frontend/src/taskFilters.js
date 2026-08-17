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
//   - due:    '' (any) | 'overdue' | 'today' | 'week' (due within 7 days) |
//             'month' (within 30 days) | 'has' (has a due date) | 'none'
//   - showDone + doneColumns: when showDone is false, tasks sitting in a "done"
//               column are hidden (active work is the default focus)
export function matchesTaskFilters(task, { search = '', tags = [], assignee = '', priority = '', relation = '', due = '', showDone = true, doneColumns = [], currentUser = '', today = isoToday() } = {}) {
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
  if (due && !matchesDue(task, due, today)) return false;
  if (!showDone && doneColumns.includes(task.column)) return false;
  const who = String(task.assignee || '').trim();
  if (assignee === '@me') return who === (currentUser || '');
  if (assignee === '@unassigned') return who === '';
  if (assignee) return who === assignee;
  return true;
}

// isoToday returns today's date as YYYY-MM-DD (local).
export function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

// isoAddDays adds n days to a YYYY-MM-DD string and returns YYYY-MM-DD.
export function isoAddDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// matchesDue reports whether a task's due date passes the due-window filter.
// ISO date strings compare lexicographically, so plain string comparison works.
function matchesDue(task, due, today) {
  const d = String(task.due || '').trim();
  if (due === 'none') return !d;
  if (due === 'has') return !!d;
  if (!d) return false;
  if (due === 'overdue') return d < today && !task.checked;
  if (due === 'today') return d === today;
  if (due === 'week') return d >= today && d <= isoAddDays(today, 7);
  if (due === 'month') return d >= today && d <= isoAddDays(today, 30);
  return true;
}
