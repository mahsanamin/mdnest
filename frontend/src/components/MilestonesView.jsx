import { useMemo, useState } from 'react';
import { milestoneStats, sortMilestones, milestoneId, dueLabel, formatCreated } from '../milestones';
import { NO_GRAMMAR_ASSIST } from '../noGrammarAssist.js';
import './TaskBoard.css';

const EMPTY = { title: '', start: '', due: '', description: '' };
const initials = (name) => name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// MilestoneForm adds or edits a milestone (title, period, description).
function MilestoneForm({ initial, busy, onSubmit, onCancel, submitLabel }) {
  const [form, setForm] = useState(initial || EMPTY);
  const [err, setErr] = useState(null);
  const submit = () => {
    if (!form.title.trim()) { setErr('A title is required'); return; }
    if (form.start && form.due && form.start > form.due) { setErr('The start date is after the due date'); return; }
    onSubmit({ title: form.title.trim(), start: form.start, due: form.due, description: form.description.trim() });
  };
  return (
    <div className="tb-milestone-form">
      <label className="tb-modal-field">Title
        <input className="tb-col-title" autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </label>
      <div className="tb-editor-grid">
        <label className="tb-modal-field">Start
          <input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
        </label>
        <label className="tb-modal-field">Due
          <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
        </label>
      </div>
      <label className="tb-modal-field">Description
        <textarea {...NO_GRAMMAR_ASSIST} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      {err && <div className="tb-error">{err}</div>}
      <div className="tb-modal-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="primary" onClick={submit} disabled={busy}>{submitLabel}</button>
      </div>
    </div>
  );
}

// ProgressBars shows the work done and, with a start date, the time elapsed under it.
function ProgressBars({ stats, label }) {
  return (
    <div className="tb-ms-bars">
      <div className="tb-ms-bar-row" title="Work done: done tasks, and the done sub-tasks of open ones">
        <span className="tb-ms-bar-label">Work</span>
        <div className="tb-progress" role="progressbar" aria-valuenow={stats.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} progress`}>
          <div className="tb-progress-bar" style={{ width: `${stats.percent}%` }} />
        </div>
        <span className="tb-ms-bar-value">{stats.percent}%</span>
      </div>
      {stats.timePercent !== null && (
        <div className="tb-ms-bar-row" title="Share of the period from the start date to the due date already gone">
          <span className="tb-ms-bar-label">Time</span>
          <div className={`tb-progress tb-ms-time${stats.behind ? ' behind' : ''}`} role="progressbar" aria-valuenow={stats.timePercent} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} time elapsed`}>
            <div className="tb-progress-bar" style={{ width: `${stats.timePercent}%` }} />
          </div>
          <span className="tb-ms-bar-value">{stats.timePercent}%</span>
        </div>
      )}
    </div>
  );
}

function StatusChips({ milestone, stats }) {
  return (
    <>
      {milestone.closed && <span className="tb-chip">closed</span>}
      {stats.late && <span className="tb-chip tb-ms-late">late</span>}
      {!stats.late && stats.behind && <span className="tb-chip tb-ms-behind" title="More of the period is gone than of the work is done">behind</span>}
      {milestone.due && (
        <span className={`tb-due${stats.late ? ' overdue' : ''}`} title="Due date">
          📅 {milestone.start ? `${milestone.start} → ` : ''}{milestone.due}{!milestone.closed && stats.daysLeft !== null ? ` · ${dueLabel(stats.daysLeft)}` : ''}
        </span>
      )}
    </>
  );
}

function People({ participants, max = 6 }) {
  return (
    <div className="tb-ms-people">
      {participants.slice(0, max).map((p) => (
        <span key={p.name} className="tb-ms-avatar" title={`${p.name}: ${p.open} open, ${p.done} done`}>{initials(p.name)}</span>
      ))}
      {participants.length > max && <span className="tb-ms-avatar more">+{participants.length - max}</span>}
    </div>
  );
}

// TaskRow is one task of the milestone page, with what matters to follow it.
function TaskRow({ task, today, canWrite, onEditTask, onOpenNote }) {
  const steps = task.steps || [];
  const late = !task.checked && task.due && task.due < today;
  return (
    <li className={`tb-ms-task${task.checked ? ' checked' : ''}`}>
      <span className="tb-ms-task-title">
        {task.ref && <span className="tb-ref">{task.ref}</span>} {task.text || <em>(empty)</em>}
      </span>
      <span className="tb-ms-task-meta">
        {task.assignee && <span className="tb-chip" title="Assignee">👤 {task.assignee}</span>}
        {steps.length > 0 && <span className="tb-chip" title="Steps done">☑ {steps.filter((s) => s.checked).length}/{steps.length}</span>}
        {task.due && <span className={`tb-due${late ? ' overdue' : ''}`} title="Due date">📅 {task.due}</span>}
        {task.completed && <span className="tb-chip" title={`Completed ${task.completed}`}>✓ {formatCreated(task.completed)}</span>}
        {canWrite && <button type="button" className="tb-expand" onClick={() => onEditTask(task)}>✎ edit</button>}
        <button type="button" className="tb-card-source" title={`Open ${task.path}`} onClick={() => onOpenNote(task.path)}>{task.path}</button>
      </span>
    </li>
  );
}

// MilestonePage is one milestone in full: dates and status, progress against
// time, scope, what needs attention, participants, and its tasks by column.
function MilestonePage({ milestone, stats, columns, today, canWrite, busy, onBack, onUpdate, onDelete, onShowOnBoard, onEditTask, onOpenNote }) {
  const [editing, setEditing] = useState(false);
  const attention = [...new Set([...stats.overdue, ...stats.blocked])];
  return (
    <div className="tb-ms-page" data-milestone={milestone.id}>
      <button type="button" className="tb-link-btn tb-ms-back" onClick={onBack}>← All milestones</button>
      {editing ? (
        <MilestoneForm initial={{ title: milestone.title, start: milestone.start || '', due: milestone.due || '', description: milestone.description || '' }}
          busy={busy} submitLabel="Save" onCancel={() => setEditing(false)}
          onSubmit={(fields) => onUpdate({ ...milestone, ...fields }).then(() => setEditing(false))} />
      ) : (
        <>
          <div className="tb-ms-page-head">
            <h2 className="tb-ms-page-title">🏁 {milestone.title}</h2>
            <StatusChips milestone={milestone} stats={stats} />
          </div>
          {milestone.description && <div className="tb-notes tb-ms-description">{milestone.description}</div>}
          <div className="tb-ms-actions">
            <button type="button" className="tb-btn" onClick={() => onShowOnBoard(milestone.id)}>Show on the Kanban</button>
            {canWrite && <button type="button" className="tb-btn" onClick={() => setEditing(true)} disabled={busy}>✎ Edit</button>}
            {canWrite && (milestone.closed
              ? <button type="button" className="tb-btn" onClick={() => onUpdate({ ...milestone, closed: false })} disabled={busy}>Reopen</button>
              : <button type="button" className="tb-btn" onClick={() => onUpdate({ ...milestone, closed: true })} disabled={busy}>Close</button>)}
            {canWrite && <button type="button" className="tb-btn tb-ms-delete" title="Delete milestone" onClick={() => onDelete(milestone, stats.total)} disabled={busy}>🗑 Delete</button>}
          </div>
        </>
      )}

      <div className="tb-ms-kpis">
        <div className="tb-ms-kpi">
          <div className="tb-ms-kpi-value" data-testid="ms-percent">{stats.percent}%</div>
          <div className="tb-ms-kpi-label">done</div>
          <ProgressBars stats={stats} label={milestone.title} />
        </div>
        <div className="tb-ms-kpi">
          <div className="tb-ms-kpi-value" data-testid="ms-tasks">{stats.done}/{stats.total}</div>
          <div className="tb-ms-kpi-label">tasks done</div>
          <div className="tb-ms-kpi-sub" data-testid="ms-steps">{stats.stepsDone}/{stats.steps} sub-tasks</div>
        </div>
        <div className="tb-ms-kpi">
          <div className="tb-ms-kpi-value" data-testid="ms-attention">{attention.length}</div>
          <div className="tb-ms-kpi-label">need attention</div>
          <div className="tb-ms-kpi-sub">{stats.overdue.length} late · {stats.blocked.length} blocked</div>
        </div>
        {milestone.start && (
          <div className="tb-ms-kpi" title={`Tasks created after ${milestone.start}`}>
            <div className="tb-ms-kpi-value" data-testid="ms-added">+{stats.addedAfterStart.length}</div>
            <div className="tb-ms-kpi-label">added since the start</div>
          </div>
        )}
      </div>

      {stats.total > 0 && (
        <div className="tb-ms-columns" aria-label="Tasks per column">
          {columns.filter((c) => stats.byColumn[c.id]).map((c) => (
            <div key={c.id} className={`tb-ms-col-seg${c.done ? ' done' : ''}`} style={{ flexGrow: stats.byColumn[c.id] }} title={`${c.title}: ${stats.byColumn[c.id]}`}>
              {c.title} {stats.byColumn[c.id]}
            </div>
          ))}
        </div>
      )}

      {attention.length > 0 && (
        <section className="tb-ms-section tb-ms-attention">
          <h3>Needs attention</h3>
          <ul className="tb-ms-tasks">
            {attention.map((t) => (
              <TaskRow key={`${t.path}:${t.line}`} task={t} today={today} canWrite={canWrite} onEditTask={onEditTask} onOpenNote={onOpenNote} />
            ))}
          </ul>
        </section>
      )}

      {stats.participants.length > 0 && (
        <section className="tb-ms-section">
          <h3>Participants</h3>
          <table className="tb-ms-participants">
            <thead><tr><th>Person</th><th>Open</th><th>Done</th><th>Role</th></tr></thead>
            <tbody>
              {stats.participants.map((p) => (
                <tr key={p.name}>
                  <td><span className="tb-ms-avatar">{initials(p.name)}</span> {p.name}</td>
                  <td>{p.open}</td>
                  <td>{p.done}</td>
                  <td>{[p.assigned && `assigned ${p.assigned}`, p.created && `created ${p.created}`].filter(Boolean).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {columns.filter((c) => stats.byColumn[c.id]).map((c) => (
        <section key={c.id} className="tb-ms-section">
          <h3>{c.title} <span className="tb-column-count">{stats.byColumn[c.id]}</span></h3>
          <ul className="tb-ms-tasks">
            {stats.tasks.filter((t) => t.column === c.id).map((t) => (
              <TaskRow key={`${t.path}:${t.line}`} task={t} today={today} canWrite={canWrite} onEditTask={onEditTask} onOpenNote={onOpenNote} />
            ))}
          </ul>
        </section>
      ))}
      {stats.total === 0 && <div className="tb-empty">No task in this milestone yet. Pick it in a task&apos;s editor.</div>}
    </div>
  );
}

// MilestonesView is the board's Milestones mode: every milestone as a card
// (progress against time, participants, what needs attention), and a page per
// milestone. Milestones live in .mdnest/board.json; a task joins one with
// `milestone: <id>`.
export default function MilestonesView({ milestones, tasks, columns, doneColumns, isBlocked, canWrite, selected, onSelect, onSave, onShowOnBoard, onEditTask, onOpenNote }) {
  const [creating, setCreating] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const today = new Date().toISOString().slice(0, 10);
  const all = useMemo(() => sortMilestones(milestones).map((m) => ({ m, s: milestoneStats(m, tasks, { doneColumns, today, isBlocked }) })),
    [milestones, tasks, doneColumns, today, isBlocked]);

  const save = async (next) => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(next);
    } catch (e) {
      setErr(e?.message || 'Failed to save milestones');
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const update = (m) => save(milestones.map((x) => (x.id === m.id ? m : x))).catch(() => {});
  const remove = (m, count) => {
    const tail = count ? ` Its ${count} task${count > 1 ? 's' : ''} keep their milestone field and show its id.` : '';
    if (confirm(`Delete milestone “${m.title}”?${tail}`)) save(milestones.filter((x) => x.id !== m.id)).then(() => onSelect('')).catch(() => {});
  };

  const current = selected ? all.find(({ m }) => m.id === selected) : null;
  if (selected && current) {
    return (
      <div className="tb-milestones-view">
        {err && <div className="tb-error">{err}</div>}
        <MilestonePage milestone={current.m} stats={current.s} columns={columns} today={today} canWrite={canWrite} busy={busy}
          onBack={() => onSelect('')} onUpdate={update} onDelete={remove} onShowOnBoard={onShowOnBoard}
          onEditTask={onEditTask} onOpenNote={onOpenNote} />
      </div>
    );
  }

  const shown = all.filter(({ m }) => showClosed || !m.closed);
  const closedCount = all.length - all.filter(({ m }) => !m.closed).length;
  return (
    <div className="tb-milestones-view">
      {selected && !current && <div className="tb-error">Milestone “{selected}” does not exist on this board.</div>}
      {err && <div className="tb-error">{err}</div>}
      <div className="tb-ms-toolbar">
        {canWrite && !creating && <button type="button" className="tb-btn primary" onClick={() => setCreating(true)}>+ New milestone</button>}
        {closedCount > 0 && (
          <label className="tb-filter-showdone">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            Show closed ({closedCount})
          </label>
        )}
      </div>
      {creating && (
        <div className="tb-ms-card tb-ms-new">
          <MilestoneForm busy={busy} submitLabel="Add milestone" onCancel={() => setCreating(false)}
            onSubmit={(fields) => {
              const id = milestoneId(fields.title, milestones.map((m) => m.id));
              save([...milestones, { id, ...fields }]).then(() => { setCreating(false); onSelect(id); }).catch(() => {});
            }} />
        </div>
      )}
      {all.length === 0 && !creating && (
        <div className="tb-empty">No milestones yet. A milestone groups tasks towards a goal and shows how far along they are.</div>
      )}
      <div className="tb-ms-grid">
        {shown.map(({ m, s }) => (
          <button key={m.id} type="button" className={`tb-ms-card${m.closed ? ' closed' : ''}`} data-milestone={m.id} onClick={() => onSelect(m.id)}>
            <div className="tb-ms-card-head">
              <span className="tb-milestone-title">🏁 {m.title}</span>
              <span className="tb-milestone-count" title="Tasks done">{s.done}/{s.total} · {s.percent}%</span>
            </div>
            <div className="tb-milestone-head"><StatusChips milestone={m} stats={s} /></div>
            <ProgressBars stats={s} label={m.title} />
            <div className="tb-ms-card-foot">
              <People participants={s.participants} />
              <span className="tb-ms-card-flags">
                {s.overdue.length > 0 && <span className="tb-chip tb-ms-late" title="Open tasks past their due date">{s.overdue.length} late</span>}
                {s.blocked.length > 0 && <span className="tb-blocked" title="Open tasks waiting on another open task">⛔ {s.blocked.length}</span>}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
