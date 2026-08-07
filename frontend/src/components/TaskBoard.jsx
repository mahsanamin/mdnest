import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { getTasks, patchTask, saveBoard, createTask, getNamespaceUsers, getAllTasks } from '../api';
import { matchesTaskFilters } from '../taskFilters';
import BoardColumnsEditor from './BoardColumnsEditor';
import TaskEditor from './TaskEditor';
import './TaskBoard.css';

// A task is identified across the UI by its source location, which is unique
// even when two items share the same text. In the global (cross-namespace) view
// two namespaces can share a note path + line, so the namespace is part of the
// key. The backend id is content-derived and can collide, so it is not used.
function cardKey(t) {
  return `${t.namespace || ''}\u0000${t.path}\u0000${t.line}`;
}

const today = () => new Date().toISOString().slice(0, 10);

function TaskCard({ task, canWrite, onOpen, onToggleStep, onEdit }) {
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

  return (
    <div className={`tb-card${isDragging ? ' dragging' : ''}${task.checked ? ' checked' : ''}`} ref={setNodeRef}>
      {task.namespace && (
        <div className="tb-card-ns" title="Source workspace">🗂 {task.namespace}</div>
      )}
      {/* The head is the drag handle; interactive controls below stop propagation. */}
      <div className="tb-card-head" {...(canWrite ? { ...attributes, ...listeners } : {})}>
        {task.priority && (
          <span className={`tb-pri tb-pri-${String(task.priority).toLowerCase()}`}>{task.priority}</span>
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
        <button type="button" className="tb-card-source" title={`Open ${task.path}`} onPointerDown={noSwallow}
          onClick={(e) => { e.stopPropagation(); onOpen(task.path); }}>
          {task.path}
        </button>
      </div>
    </div>
  );
}

function BoardColumn({ column, tasks, canWrite, onOpen, onToggleStep, onEdit, collapsed, onToggleCollapse }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: !canWrite });
  return (
    <div ref={setNodeRef} className={`tb-column${isOver ? ' over' : ''}${collapsed ? ' collapsed' : ''}`}>
      <div className="tb-column-head" onClick={collapsed ? onToggleCollapse : undefined}>
        <button
          type="button"
          className="tb-column-collapse"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          title={collapsed ? 'Expand column' : 'Collapse column'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '\u25B8' : '\u25BE'}
        </button>
        <span className="tb-column-title">{column.title}</span>
        <span className="tb-column-count">{tasks.length}</span>
      </div>
      {!collapsed && (
        <div className="tb-column-body">
          {tasks.map((t) => (
            <TaskCard key={cardKey(t)} task={t} canWrite={canWrite} onOpen={onOpen} onToggleStep={onToggleStep} onEdit={onEdit} />
          ))}
          {tasks.length === 0 && <div className="tb-column-empty">No tasks</div>}
        </div>
      )}
    </div>
  );
}

// TaskBoard is a namespace-level overlay presenting every markdown task-list
// item in the namespace, either as a flat list (with checkbox toggling) or as
// a kanban board (drag a card between columns). Both views project the same
// data — the notes themselves — so a change in one is reflected in the other.
export default function TaskBoard({ ns, canWrite, onOpenNote, onClose, currentPath, currentUser }) {
  const [board, setBoard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem('mdnest_taskboard_mode') || 'board');
  const [editingColumns, setEditingColumns] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const [scope, setScope] = useState('workspace');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTask, setEditorTask] = useState(null);
  // Namespace members, to populate the assignee picker. Empty in single mode
  // (endpoint absent) — the editor then falls back to a free-choice list.
  const [nsUsers, setNsUsers] = useState([]);

  // Client-side filters over the loaded tasks. They apply to every scope
  // (workspace / this note) and both views (list / kanban) — filtering happens
  // before the tasks are grouped into columns or notes.
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState([]); // selected tags (OR)
  const [assigneeFilter, setAssigneeFilter] = useState(''); // '' | '@me' | '@unassigned' | <username>

  // The note-scoped view only makes sense with a note open; the global view
  // spans every workspace and ignores the current note/namespace for reads.
  const effectiveScope = scope === 'note' && !currentPath ? 'workspace' : scope;
  const isGlobal = effectiveScope === 'global';

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const reload = useCallback(async () => {
    if (!ns && !isGlobal) return;
    setLoading(true);
    setError(null);
    try {
      const data = isGlobal
        ? await getAllTasks()
        : await getTasks(ns, effectiveScope === 'note' ? currentPath : undefined);
      setBoard(data.board);
      setTasks(data.tasks || []);
    } catch (e) {
      setError(e.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [ns, effectiveScope, isGlobal, currentPath]);

  useEffect(() => { reload(); }, [reload]);

  // Load the namespace's members once per namespace for the assignee picker.
  useEffect(() => {
    let cancelled = false;
    if (!ns) { setNsUsers([]); return undefined; }
    getNamespaceUsers(ns)
      .then((u) => { if (!cancelled) setNsUsers(Array.isArray(u) ? u : []); })
      .catch(() => { if (!cancelled) setNsUsers([]); });
    return () => { cancelled = true; };
  }, [ns]);

  const setModePersist = useCallback((m) => {
    setMode(m);
    localStorage.setItem('mdnest_taskboard_mode', m);
  }, []);

  // Per-column collapse state, persisted per namespace. null = not yet
  // initialised, so the Done column can be collapsed by default on first show.
  const collapseKey = `mdnest_taskboard_collapsed_${ns}`;
  const [collapsedCols, setCollapsedCols] = useState(() => {
    try {
      const raw = localStorage.getItem(collapseKey);
      return raw ? new Set(JSON.parse(raw)) : null;
    } catch { return null; }
  });
  const toggleCollapse = useCallback((id) => {
    setCollapsedCols((prev) => {
      const next = new Set(prev || []);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(collapseKey, JSON.stringify([...next]));
      return next;
    });
  }, [collapseKey]);

  // Optimistically replace a task in local state after a successful mutation,
  // keyed by its (still-current) source location.
  const applyUpdated = useCallback((prevKey, updated) => {
    setTasks((cur) => cur.map((t) => (cardKey(t) === prevKey ? updated : t)));
  }, []);

  const handleToggle = useCallback(async (task) => {
    const key = cardKey(task);
    try {
      const updated = await patchTask(task.namespace || ns, task.path, {
        line: task.line,
        raw: task.raw,
        checked: !task.checked,
      });
      applyUpdated(key, updated);
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message);
    }
  }, [ns, applyUpdated, reload]);

  // Toggle a sub-task (step): flip its checkbox line. Optimistic, reconciled
  // from the step ack the backend returns (keeps the step's raw line fresh).
  const handleToggleStep = useCallback(async (task, step) => {
    const key = cardKey(task);
    setTasks((cur) => cur.map((t) => (cardKey(t) === key
      ? { ...t, steps: t.steps.map((s) => (s.line === step.line ? { ...s, checked: !s.checked } : s)) }
      : t)));
    try {
      const res = await patchTask(task.namespace || ns, task.path, { line: step.line, raw: step.raw, checked: !step.checked });
      if (res && res.step) {
        setTasks((cur) => cur.map((t) => (cardKey(t) === key
          ? { ...t, steps: t.steps.map((s) => (s.line === step.line ? { ...s, checked: res.checked, raw: res.raw } : s)) }
          : t)));
      } else {
        await reload();
      }
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message); await reload();
    }
  }, [ns, reload]);

  const openEdit = useCallback((task) => { setEditorTask(task); setEditorOpen(true); }, []);
  const openCreate = useCallback(() => { setEditorTask(null); setEditorOpen(true); }, []);

  // Create (append) or replace a whole task from the editor's spec.
  const handleEditorSave = useCallback(async (spec, note) => {
    try {
      if (editorTask) {
        await patchTask(editorTask.namespace || ns, editorTask.path, { line: editorTask.line, raw: editorTask.raw, replace: spec });
      } else {
        await createTask(ns, { note: note || undefined, ...spec });
      }
      setEditorOpen(false);
      await reload();
    } catch (e) {
      if (e.status === 409) { setEditorOpen(false); await reload(); return; }
      setError(e.message);
    }
  }, [ns, editorTask, reload]);

  const handleDragStart = useCallback((event) => {
    setActiveTask(event.active?.data?.current?.task || null);
  }, []);

  const handleDragEnd = useCallback(async (event) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;
    const task = active.data?.current?.task;
    if (!task || task.column === over.id) return;
    const key = cardKey(task);
    // Optimistic move so the card lands instantly.
    setTasks((cur) => cur.map((t) => (cardKey(t) === key ? { ...t, column: over.id } : t)));
    try {
      const updated = await patchTask(task.namespace || ns, task.path, {
        line: task.line,
        raw: task.raw,
        toColumn: over.id,
      });
      applyUpdated(key, updated);
    } catch (e) {
      if (e.status === 409) { await reload(); return; }
      setError(e.message);
      await reload();
    }
  }, [ns, applyUpdated, reload]);

  const columns = board?.columns || [];

  // Distinct tags and assignees present in the loaded tasks, for the filter UI.
  const allTags = useMemo(() => {
    const s = new Set();
    for (const t of tasks) for (const tag of (t.tags || [])) s.add(tag);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [tasks]);
  const assigneeChoices = useMemo(() => {
    const s = new Set();
    for (const t of tasks) if (t.assignee) s.add(t.assignee);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  const toggleTag = useCallback((tag) => {
    setTagFilter((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]));
  }, []);
  const filtersActive = search.trim() !== '' || tagFilter.length > 0 || assigneeFilter !== '';
  const clearFilters = useCallback(() => { setSearch(''); setTagFilter([]); setAssigneeFilter(''); }, []);

  // Tasks after filters — every downstream view derives from this.
  const filteredTasks = useMemo(
    () => tasks.filter((t) => matchesTaskFilters(t, { search, tags: tagFilter, assignee: assigneeFilter, currentUser })),
    [tasks, search, tagFilter, assigneeFilter, currentUser],
  );

  // First time a board is shown (no stored collapse state), collapse the Done
  // column by default — it's usually the least-consulted.
  useEffect(() => {
    if (collapsedCols !== null || columns.length === 0) return;
    const done = new Set(columns.filter((c) => c.done || c.id === 'done').map((c) => c.id));
    setCollapsedCols(done);
    localStorage.setItem(collapseKey, JSON.stringify([...done]));
  }, [columns, collapsedCols, collapseKey]);

  const tasksByColumn = useMemo(() => {
    const map = {};
    for (const c of columns) map[c.id] = [];
    for (const t of filteredTasks) {
      (map[t.column] || (map[t.column] = [])).push(t);
    }
    return map;
  }, [columns, filteredTasks]);

  const tasksByNote = useMemo(() => {
    const groups = new Map();
    for (const t of filteredTasks) {
      // Global view can hold the same note path in two namespaces, so key the
      // group by namespace + path and label it with the namespace.
      const key = t.namespace ? `${t.namespace}\u0000${t.path}` : t.path;
      if (!groups.has(key)) groups.set(key, { ns: t.namespace || '', path: t.path, items: [] });
      groups.get(key).items.push(t);
    }
    return [...groups.values()].sort((a, b) => (a.ns + a.path).localeCompare(b.ns + b.path));
  }, [filteredTasks]);

  return (
    <div className="tb-panel" role="region" aria-label="Task board">
      <div className="tb-header">
        <div className="tb-header-left">
          <div className="tb-mode-toggle">
            <button className={mode === 'list' ? 'active' : ''} onClick={() => setModePersist('list')}>List</button>
            <button className={mode === 'board' ? 'active' : ''} onClick={() => setModePersist('board')}>Kanban</button>
          </div>
          <div className="tb-mode-toggle">
            <button className={effectiveScope === 'workspace' ? 'active' : ''} onClick={() => setScope('workspace')} title="All notes in this workspace">Workspace</button>
            {currentPath && (
              <button className={effectiveScope === 'note' ? 'active' : ''} onClick={() => setScope('note')} title="Only the current note">This note</button>
            )}
            <button className={effectiveScope === 'global' ? 'active' : ''} onClick={() => setScope('global')} title="Tasks across every workspace you can access">All workspaces</button>
          </div>
        </div>
        <div className="tb-header-right">
          {canWrite && !isGlobal && (
            <button className="tb-btn" onClick={openCreate} title="New task">+ New task</button>
          )}
          <button className="tb-btn" onClick={reload} title="Refresh">&#8635;</button>
          {canWrite && !isGlobal && (
            <button className="tb-btn" onClick={() => setEditingColumns(true)} title="Edit columns">Columns…</button>
          )}
        </div>
      </div>

      {!loading && tasks.length > 0 && (
        <div className="tb-filters">
          <input
            className="tb-filter-search"
            value={search}
            placeholder="Filter by text…"
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="tb-filter-assignee"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            title="Filter by assignee"
          >
            <option value="">All assignees</option>
            {currentUser && <option value="@me">Me ({currentUser})</option>}
            <option value="@unassigned">Unassigned</option>
            {assigneeChoices.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          {allTags.length > 0 && (
            <div className="tb-filter-tags">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`tb-filter-tag${tagFilter.includes(tag) ? ' active' : ''}`}
                  onClick={() => toggleTag(tag)}
                  title={`Filter by tag: ${tag}`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
          {filtersActive && (
            <button type="button" className="tb-filter-clear" onClick={clearFilters}>Clear</button>
          )}
        </div>
      )}

      {error && <div className="tb-error">{error}</div>}

      {loading ? (
        <div className="tb-loading">Loading tasks…</div>
      ) : tasks.length === 0 ? (
        <div className="tb-empty">No task-list items found in this namespace. Add <code>- [ ] something</code> to a note.</div>
      ) : filteredTasks.length === 0 ? (
        <div className="tb-empty">No tasks match the current filters. <button type="button" className="tb-link-btn" onClick={clearFilters}>Clear filters</button></div>
      ) : mode === 'board' ? (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveTask(null)}
        >
          <div className="tb-board">
            {columns.map((col) => (
              <BoardColumn
                key={col.id}
                column={col}
                tasks={tasksByColumn[col.id] || []}
                canWrite={canWrite}
                onOpen={onOpenNote}
                onToggleStep={handleToggleStep}
                onEdit={openEdit}
                collapsed={!!collapsedCols && collapsedCols.has(col.id)}
                onToggleCollapse={() => toggleCollapse(col.id)}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask ? (
              <div className="tb-card dragging-overlay">
                <div className="tb-card-text">{activeTask.text || '(empty)'}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="tb-list">
          {tasksByNote.map(({ ns: groupNs, path: notePath, items }) => (
            <div className="tb-list-group" key={`${groupNs}\u0000${notePath}`}>
              {isGlobal ? (
                <div className="tb-list-note tb-list-note-static" title={`${groupNs}/${notePath}`}>
                  <span className="tb-ns">🗂 {groupNs}</span> {notePath}
                </div>
              ) : (
                <button className="tb-list-note" onClick={() => onOpenNote(notePath)} title={`Open ${notePath}`}>
                  {notePath}
                </button>
              )}
              <ul className="tb-list-items">
                {items.map((t) => (
                  <li key={cardKey(t)} className={t.checked ? 'checked' : ''}>
                    <label>
                      <input
                        type="checkbox"
                        checked={t.checked}
                        disabled={!canWrite}
                        onChange={() => handleToggle(t)}
                      />
                      <span className="tb-list-text">{t.text || <em>(empty)</em>}</span>
                    </label>
                    {canWrite && (
                      <button type="button" className="tb-expand" onClick={() => openEdit(t)} title="Edit task">✎</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {editingColumns && (
        <BoardColumnsEditor
          board={board}
          onCancel={() => setEditingColumns(false)}
          onSave={async (next) => {
            try {
              const saved = await saveBoard(ns, next);
              setBoard(saved);
              setEditingColumns(false);
              await reload();
            } catch (e) {
              setError(e.message);
            }
          }}
        />
      )}
      {editorOpen && (
        <TaskEditor
          board={board}
          task={editorTask}
          defaultNote={editorTask ? editorTask.path : (board?.defaultNote || (effectiveScope === 'note' ? currentPath : '') || '')}
          defaultColumn={editorTask ? editorTask.column : ''}
          notePaths={[...new Set(tasks.map((t) => t.path))]}
          currentUser={currentUser}
          users={nsUsers}
          tagSuggestions={allTags}
          onSave={handleEditorSave}
          onCancel={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
