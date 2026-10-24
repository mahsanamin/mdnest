// Milestones of a board (.mdnest/board.json) and their progress over the loaded
// tasks. Pure helpers, unit-tested without rendering.

const DAY = 86_400_000;
const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isDone = (t, doneColumns) => !!t.checked || doneColumns.includes(t.column);

// milestoneProgress counts the tasks that point at a milestone: done = in a
// done column (or checked), overdue = due date passed while work is open.
export function milestoneProgress(milestone, tasks, doneColumns = [], today = new Date().toISOString().slice(0, 10)) {
  const s = milestoneStats(milestone, tasks, { doneColumns, today });
  return { total: s.total, done: s.done, open: s.open, percent: s.taskPercent, overdue: s.late };
}

// milestoneStats is everything the milestone views show, from the tasks of the
// milestone:
//   - progress: a done task counts 1, an open task the share of its done steps,
//     an open task without steps 0 (percent), next to tasks x/y and steps a/b;
//   - time: days left (negative when late) and, with a start date, the share of
//     the period elapsed, to compare with the progress;
//   - scope: tasks created after the start date;
//   - attention: open tasks past their own due date, and blocked ones
//     (isBlocked is the board's relation check);
//   - participants: assignees and creators, with their open and done tasks;
//   - byColumn: task count per column id.
export function milestoneStats(milestone, tasks, { doneColumns = [], today = new Date().toISOString().slice(0, 10), isBlocked = () => false } = {}) {
  const mine = (tasks || []).filter((t) => t.milestone === milestone.id);
  let done = 0;
  let work = 0;
  let steps = 0;
  let stepsDone = 0;
  const byColumn = {};
  const people = new Map();
  const overdue = [];
  const blocked = [];
  const addedAfterStart = [];
  for (const t of mine) {
    const closed = isDone(t, doneColumns);
    const st = t.steps || [];
    const sd = st.filter((x) => x.checked).length;
    steps += st.length;
    stepsDone += sd;
    if (closed) {
      done += 1;
      work += 1;
    } else if (st.length) {
      work += sd / st.length;
    }
    byColumn[t.column] = (byColumn[t.column] || 0) + 1;
    if (!closed && t.due && t.due < today) overdue.push(t);
    if (!closed && isBlocked(t)) blocked.push(t);
    if (milestone.start && t.created && t.created.slice(0, 10) > milestone.start) addedAfterStart.push(t);
    for (const name of new Set([t.assignee, t.createdBy].filter(Boolean))) {
      const p = people.get(name) || { name, open: 0, done: 0, assigned: 0, created: 0 };
      if (closed) p.done += 1; else p.open += 1;
      if (t.assignee === name) p.assigned += 1;
      if (t.createdBy === name) p.created += 1;
      people.set(name, p);
    }
  }
  const total = mine.length;
  const open = total - done;
  const percent = total ? Math.round((work / total) * 100) : 0;
  let timePercent = null;
  if (milestone.start && milestone.due) {
    const span = dayNumber(milestone.due) - dayNumber(milestone.start);
    const elapsed = dayNumber(today) - dayNumber(milestone.start);
    timePercent = span > 0 ? Math.min(100, Math.max(0, Math.round((elapsed / span) * 100))) : (elapsed >= 0 ? 100 : 0);
  }
  const daysLeft = milestone.due ? dayNumber(milestone.due) - dayNumber(today) : null;
  return {
    tasks: mine,
    total,
    done,
    open,
    percent,
    taskPercent: total ? Math.round((done / total) * 100) : 0,
    steps,
    stepsDone,
    byColumn,
    overdue,
    blocked,
    addedAfterStart,
    participants: [...people.values()].sort((a, b) => b.open - a.open || b.done - a.done || a.name.localeCompare(b.name)),
    timePercent,
    daysLeft,
    late: !milestone.closed && daysLeft !== null && daysLeft < 0 && open > 0,
    // Behind: more of the period gone than of the work done (10 points of slack).
    behind: !milestone.closed && timePercent !== null && open > 0 && timePercent - percent > 10,
  };
}

// dueLabel says how far the due date is: "due today", "3 days left", "2 days late".
export function dueLabel(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return '';
  if (daysLeft === 0) return 'due today';
  const n = Math.abs(daysLeft);
  return `${n} day${n > 1 ? 's' : ''} ${daysLeft > 0 ? 'left' : 'late'}`;
}

// sortMilestones lists open milestones first, soonest due first (no due date
// last), then closed ones; ties keep the board's order.
export function sortMilestones(milestones) {
  const rank = (m) => [m.closed ? 1 : 0, m.due || '9999-99-99'];
  return (milestones || [])
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const [ca, da] = rank(a.m);
      const [cb, db] = rank(b.m);
      return ca - cb || da.localeCompare(db) || a.i - b.i;
    })
    .map(({ m }) => m);
}

// milestoneId derives a unique, field-safe id from a title ("M1 – CI sandbox"
// -> "m1-ci-sandbox"), suffixing -2, -3... when it is taken.
export function milestoneId(title, taken = []) {
  const base = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 40) || 'milestone';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// milestoneLabel is the title of a milestone id, or the raw id when the board
// no longer defines it (deleted, or a typo in the note).
export function milestoneLabel(milestones, id) {
  if (!id) return '';
  const m = (milestones || []).find((x) => x.id === id);
  return m ? m.title : id;
}

// formatCreated renders a task's `created:` time (UTC RFC 3339) as a local
// date, falling back to the raw value when it does not parse.
export function formatCreated(created) {
  if (!created) return '';
  const d = new Date(created);
  return Number.isNaN(d.getTime()) ? created : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
