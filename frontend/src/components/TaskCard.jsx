import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { cardKey } from './cardKey';

const today = () => new Date().toISOString().slice(0, 10);

// Relation types and their card icons. Values are lists of referenced task
// refs (stable, comma-free ids); each is resolved back to the live task so the
// card shows its current title/status. Legacy notes that stored titles still
// resolve via a title fallback.
const REL_ICON = { 'depends-on': '⬆', 'blocked-by': '⛔', 'related-to': '🔗' };

// TaskCard renders one task as a draggable kanban card: id/priority/blocked
// badges, meta chips, tags, relation chips (resolved to their live task), a
// progress bar and an expandable detail block, plus edit/delete/open actions.
export default function TaskCard({ task, canWrite, onOpen, onToggleStep, onEdit, resolve, onDelete }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: cardKey(task),
    data: { task },
    disabled: !canWrite,
  });
  const [expanded, setExpanded] = useState(!!task.defaultExpanded);
  const steps = task.steps || [];
  const done = steps.filter((s) => s.checked).length;
  const hasDetail = steps.length > 0 || !!task.notes;
  const overdue = task.due && !task.checked && task.due < today();
  const noSwallow = (e) => e.stopPropagation();

  // Relations (depends-on / blocked-by / related-to) and derived blocked state:
  // this task is blocked when a task it depends on / is blocked by is still open.
  const rels = [['depends-on', task.dependsOn], ['blocked-by', task.blockedBy], ['related-to', task.relatedTo]]
    .filter(([, v]) => v && v.length);
  const blockers = [...(task.dependsOn || []), ...(task.blockedBy || [])];
  const isBlocked = !task.checked && blockers.some((ref) => {
    const r = resolve && resolve(ref);
    return r && !r.checked;
  });

  return (
    <div className={`tb-card${isDragging ? ' dragging' : ''}${task.checked ? ' checked' : ''}`} ref={setNodeRef}>
      {task.namespace && (
        <div className="tb-card-ns" title="Source workspace">🗂 {task.namespace}</div>
      )}
      {/* The head is the drag handle; interactive controls below stop propagation. */}
      <div className="tb-card-head" {...(canWrite ? { ...attributes, ...listeners } : {})}>
        {(task.ref || task.priority || isBlocked) && (
          <div className="tb-card-badges">
            {task.ref && <span className="tb-ref" title="Task id">{task.ref}</span>}
            {task.priority && (
              <span className={`tb-pri tb-pri-${String(task.priority).toLowerCase()}`}>{task.priority}</span>
            )}
            {isBlocked && <span className="tb-blocked" title="Blocked: a task it depends on is still open">⛔ blocked</span>}
          </div>
        )}
        <span className="tb-card-text">{task.text || <em>(empty)</em>}</span>
      </div>

      {(task.due || task.workload || task.assignee || steps.length > 0) && (
        <div className="tb-card-meta">
          {task.due && <span className={`tb-due${overdue ? ' overdue' : ''}`} title="Due date">📅 {task.due}</span>}
          {task.workload && <span className="tb-chip" title="Workload">🏋 {task.workload}</span>}
          {task.assignee && <span className="tb-chip" title="Assignee">👤 {task.assignee}</span>}
          {steps.length > 0 && <span className="tb-chip" title="Steps done">☑ {done}/{steps.length}</span>}
        </div>
      )}

      {task.tags && task.tags.length > 0 && (
        <div className="tb-tags">{task.tags.map((t) => <span key={t} className="tb-tag">{t}</span>)}</div>
      )}

      {rels.length > 0 && (
        <div className="tb-rels">
          {rels.flatMap(([label, refs]) => refs.map((ref) => {
            const r = resolve && resolve(ref);
            const state = r ? (r.checked ? '✓' : '○') : '';
            const shown = r ? r.text : ref;
            return (
              <span key={label + '\u0000' + ref} className={`tb-rel${r && !r.checked ? ' open' : ''}`} title={label}>
                {REL_ICON[label]} {state} {shown}
              </span>
            );
          }))}
        </div>
      )}

      {steps.length > 0 && (
        <div className="tb-progress"><div className="tb-progress-bar" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      )}

      {expanded && (
        <div className="tb-card-detail">
          {steps.length > 0 && (
            <ul className="tb-steps">
              {steps.map((s) => (
                <li key={s.line} className={s.checked ? 'checked' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      checked={s.checked}
                      disabled={!canWrite}
                      onPointerDown={noSwallow}
                      onChange={() => onToggleStep(task, s)}
                    />
                    <span>{s.text || <em>(empty)</em>}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {task.notes && <div className="tb-notes">{task.notes}</div>}
        </div>
      )}

      <div className="tb-card-foot">
        {hasDetail && (
          <button type="button" className="tb-expand" onPointerDown={noSwallow}
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>
            {expanded ? '▾ less' : '▸ more'}
          </button>
        )}
        {canWrite && (
          <button type="button" className="tb-expand" onPointerDown={noSwallow}
            onClick={(e) => { e.stopPropagation(); onEdit(task); }}>✎ edit</button>
        )}
        {canWrite && onDelete && (
          <button type="button" className="tb-card-delete" title="Delete task" onPointerDown={noSwallow}
            onClick={(e) => { e.stopPropagation(); if (confirm(`Delete task “${task.text || '(empty)'}”? This removes it from ${task.path}.`)) onDelete(task); }}>🗑</button>
        )}
        <button type="button" className="tb-card-source" title={`Open ${task.path}`} onPointerDown={noSwallow}
          onClick={(e) => { e.stopPropagation(); onOpen(task.path); }}>
          {task.path}
        </button>
      </div>
    </div>
  );
}
