import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { getTasks, patchTask, saveBoard, createTask, getNamespaceUsers, getAllTasks, deleteTask } from '../api';
import { matchesTaskFilters } from '../taskFilters';
import { buildRelationLookup, resolveTask } from '../relations';
import { cardKey } from './cardKey';
import TaskCard from './TaskCard';
import BoardColumn from './BoardColumn';
import BoardColumnsEditor from './BoardColumnsEditor';
import TaskEditor from './TaskEditor';
import './TaskBoard.css';

// TaskBoard is a namespace-level overlay presenting every markdown task-list
// item in the namespace, either as a flat list (with checkbox toggling) or as
// a kanban board (drag a card between columns). Both views project the same
// data — the notes themselves — so a change in one is reflected in the other.
export default function TaskBoard({ ns, canWrite, onOpenNote, onClose, currentPath, currentUser, refreshSignal }) {
  const [board, setBoard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem('mdnest_taskboard_mode') || 'board');
  const [editingColumns, setEditingColumns] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  // Mirror of activeTask for the auto-refresh effect, so a background poll can
  // bail out mid-drag without re-subscribing on every drag.
  const activeTaskRef = useRef(null);
  useEffect(() => { activeTaskRef.current = activeTask; }, [activeTask]);
  const [scope, setScope] = useState(() => localStorage.getItem('mdnest_taskboard_scope') || 'workspace');
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
  const [priorityFilter, setPriorityFilter] = useState(''); // '' | high | medium | low
  const [relationFilter, setRelationFilter] = useState(''); // '' | any | depends-on | blocked-by | related-to
  const [dueFilter, setDueFilter] = useState(''); // '' | overdue | today | week | month | has | none
  // Done tasks are hidden by default so the views focus on active work; a
  // toggle brings them back. (Kanban's Done column is also collapsed by default.)
  const [showDone, setShowDone] = useState(false);
  // The filter bar folds behind a single toggle — expanded on wide screens,
  // collapsed on mobile where horizontal room is scarce.
  const [filtersOpen, setFiltersOpen] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return !window.matchMedia('(max-width: 640px)').matches;
  });
  // The header action buttons fold into a ⋯ menu on mobile (see CSS).
  const [actionsOpen, setActionsOpen] = useState(false);

  // The note-scoped view only makes sense with a note open; the global view
  // spans every workspace and ignores the current note/namespace for reads.
  const effectiveScope = scope === 'note' && !currentPath ? 'workspace' : scope;
  const isGlobal = effectiveScope === 'global';

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // reload refetches the board. `silent` skips the loading/error UI so a
  // background auto-refresh doesn't flash the spinner or clobber the view.
  const reload = useCallback(async (opts = {}) => {
    if (!ns && !isGlobal) return;
    if (!opts.silent) setLoading(true);
    if (!opts.silent) setError(null);
    try {
      const data = isGlobal
        ? await getAllTasks()
        : await getTasks(ns, effectiveScope === 'note' ? currentPath : undefined);
      setBoard(data.board);
      setTasks(data.tasks || []);
      setError(null);
    } catch (e) {
      if (!opts.silent) setError(e.message || 'Failed to load tasks');
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, [ns, effectiveScope, isGlobal, currentPath]);

  useEffect(() => { reload(); }, [reload]);

  // Auto-refresh: keep the board current without a manual refresh. Poll every
  // 20s and refetch the moment the tab regains focus. Both are silent (no
  // spinner), so an in-progress drag or scroll isn't disrupted.
  useEffect(() => {
    const POLL_MS = 20000;
    const silentReload = () => {
      if (activeTaskRef.current) return; // don't disrupt an in-progress drag
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        reload({ silent: true });
      }
    };
    const id = setInterval(silentReload, POLL_MS);
    const onVisible = () => {
      if (activeTaskRef.current) return;
      if (document.visibilityState === 'visible') reload({ silent: true });
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  // Load the namespace's members once per namespace for the assignee picker.
  useEffect(() => {
    let cancelled = false;
    if (!ns) { setNsUsers([]); return undefined; }
    getNamespaceUsers(ns)
      .then((u) => { if (!cancelled) setNsUsers(Array.isArray(u) ? u : []); })
      .catch(() => { if (!cancelled) setNsUsers([]); });
    return () => { cancelled = true; };
  }, [ns]);

  // Toolbar Refresh: reload the board on demand. Skip the initial value so we
  // don't double-load on mount (the effect above already does the first load).
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    reload();
    // Only react to the external refresh signal, not to reload's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const setModePersist = useCallback((m) => {
    setMode(m);
    localStorage.setItem('mdnest_taskboard_mode', m);
  }, []);

  const setScopePersist = useCallback((s) => {
    setScope(s);
    localStorage.setItem('mdnest_taskboard_scope', s);
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

  // Delete a task: optimistic removal, resync from the server on any error.
  const handleDelete = useCallback(async (task) => {
    const key = cardKey(task);
    setTasks((cur) => cur.filter((t) => cardKey(t) !== key));
    try {
      await deleteTask(task.namespace || ns, task.path, task.line, task.raw);
    } catch (e) {
      setError(e.message);
      await reload();
    }
  }, [ns, reload]);

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

  // Column ids that count as "done" — used to hide finished tasks by default.
  const doneColumnIds = useMemo(
    () => columns.filter((c) => c.done || c.id === 'done').map((c) => c.id),
    [columns],
  );

  // Distinct tags and assignees present in the loaded tasks, for the filter UI.
  // Tags carried only by done tasks are omitted while done tasks are hidden, so
  // the tag list doesn't advertise labels you can't currently see.
  const allTags = useMemo(() => {
    const s = new Set();
    // Tags carried only by done tasks are dropped from the filter (unless the
    // user opts into showing done), regardless of the current view.
    for (const t of tasks) {
      if (!showDone && doneColumnIds.includes(t.column)) continue;
      for (const tag of (t.tags || [])) s.add(tag);
    }
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [tasks, showDone, doneColumnIds]);
  const assigneeChoices = useMemo(() => {
    const s = new Set();
    for (const t of tasks) if (t.assignee) s.add(t.assignee);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [tasks]);
  const priorityChoices = useMemo(() => {
    const s = new Set();
    for (const t of tasks) if (t.priority) s.add(String(t.priority));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [tasks]);
  // Relation filtering only makes sense once tasks carry relation metadata
  // (depends-on / blocked-by / related-to); the control stays hidden otherwise.
  const hasAnyRelations = useMemo(
    () => tasks.some((t) => (t.dependsOn?.length || t.blockedBy?.length || t.relatedTo?.length)),
    [tasks],
  );

  // Distinct task titles (for relation pickers) + a title→task index so cards
  // can resolve a relation reference to its current status (best-effort, by
  // title; first match wins across the loaded set).
  const taskTitles = useMemo(() => {
    const s = new Set();
    for (const t of tasks) if (t.text) s.add(t.text);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  // Relations are stored by stable ref; resolve by ref first, then fall back to
  // title so notes written before the switch still light up.
  const relationLookup = useMemo(
    () => buildRelationLookup(tasks.map((t) => ({ ref: t.ref, title: t.text, task: t }))),
    [tasks],
  );
  const resolveRelation = useCallback((value) => resolveTask(relationLookup, value), [relationLookup]);
  // {ref, title} pairs so the relations editor can search/pick a task by its
  // stable ref or its title, then store the ref (comma-free, rename-proof).
  const taskRefs = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const t of tasks) {
      if (t.ref && t.text && !seen.has(t.ref)) { seen.add(t.ref); out.push({ ref: t.ref, title: t.text }); }
    }
    return out.sort((a, b) => a.ref.localeCompare(b.ref));
  }, [tasks]);

  const toggleTag = useCallback((tag) => {
    setTagFilter((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]));
  }, []);
  const activeFilterCount =
    (search.trim() !== '' ? 1 : 0) +
    (tagFilter.length > 0 ? 1 : 0) +
    (assigneeFilter !== '' ? 1 : 0) +
    (priorityFilter !== '' ? 1 : 0) +
    (relationFilter !== '' ? 1 : 0) +
    (dueFilter !== '' ? 1 : 0) +
    (showDone && mode === 'list' ? 1 : 0);
  const filtersActive = activeFilterCount > 0;
  const clearFilters = useCallback(() => {
    setSearch(''); setTagFilter([]); setAssigneeFilter(''); setPriorityFilter(''); setRelationFilter(''); setDueFilter(''); setShowDone(false);
  }, []);

  // Hiding done tasks only applies to the flat list — the kanban board keeps
  // them in the (collapsed-by-default) Done column so a card dragged there
  // doesn't silently vanish.
  const effectiveShowDone = mode === 'board' ? true : showDone;

  // Tasks after filters — every downstream view derives from this.
  const filteredTasks = useMemo(
    () => tasks.filter((t) => matchesTaskFilters(t, {
      search, tags: tagFilter, assignee: assigneeFilter, priority: priorityFilter,
      relation: relationFilter, due: dueFilter, showDone: effectiveShowDone, doneColumns: doneColumnIds, currentUser,
    })),
    [tasks, search, tagFilter, assigneeFilter, priorityFilter, relationFilter, dueFilter, effectiveShowDone, doneColumnIds, currentUser],
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
            <button className={effectiveScope === 'workspace' ? 'active' : ''} onClick={() => setScopePersist('workspace')} title="All notes in this workspace">Workspace</button>
            {currentPath && (
              <button className={effectiveScope === 'note' ? 'active' : ''} onClick={() => setScopePersist('note')} title="Only the current note">This note</button>
            )}
            <button className={effectiveScope === 'global' ? 'active' : ''} onClick={() => setScopePersist('global')} title="Tasks across every workspace you can access">All workspaces</button>
          </div>
        </div>
        <div className="tb-header-right">
          <button
            type="button"
            className="tb-actions-toggle"
            onClick={() => setActionsOpen((v) => !v)}
            aria-expanded={actionsOpen}
            title="Actions"
          >⋯</button>
          <div className={`tb-actions${actionsOpen ? ' open' : ''}`}>
            {canWrite && !isGlobal && (
              <button className="tb-btn" onClick={() => { setActionsOpen(false); openCreate(); }} title="New task">+ New task</button>
            )}
            <button className="tb-btn" onClick={() => { setActionsOpen(false); reload(); }} title="Refresh">&#8635;</button>
            {canWrite && !isGlobal && (
              <button className="tb-btn" onClick={() => { setActionsOpen(false); setEditingColumns(true); }} title="Edit columns">Columns…</button>
            )}
          </div>
        </div>
      </div>

      {!loading && tasks.length > 0 && (
        <div className={`tb-filters${filtersOpen ? ' open' : ''}`}>
          <button
            type="button"
            className="tb-filters-toggle"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            title={filtersOpen ? 'Hide filters' : 'Show filters'}
          >
            {filtersOpen ? '\u25BE' : '\u25B8'} Filters{!filtersOpen && activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
          {filtersOpen && (
            <div className="tb-filters-body">
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
              {priorityChoices.length > 0 && (
                <select
                  className="tb-filter-priority"
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                  title="Filter by priority"
                >
                  <option value="">Any priority</option>
                  {priorityChoices.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              )}
              {hasAnyRelations && (
                <select
                  className="tb-filter-priority"
                  value={relationFilter}
                  onChange={(e) => setRelationFilter(e.target.value)}
                  title="Filter by relations"
                >
                  <option value="">Any relations</option>
                  <option value="any">Has relations</option>
                  <option value="depends-on">Has depends-on</option>
                  <option value="blocked-by">Has blocked-by</option>
                  <option value="related-to">Has related-to</option>
                </select>
              )}
              <select
                className="tb-filter-priority"
                value={dueFilter}
                onChange={(e) => setDueFilter(e.target.value)}
                title="Filter by due date"
              >
                <option value="">Any due date</option>
                <option value="overdue">Overdue</option>
                <option value="today">Due today</option>
                <option value="week">Due in 7 days</option>
                <option value="month">Due in 30 days</option>
                <option value="has">Has a due date</option>
                <option value="none">No due date</option>
              </select>
              <label className="tb-filter-showdone" title="Include tasks in Done columns (list view)">
                <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} disabled={mode === 'board'} />
                Show done
              </label>
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
                resolve={resolveRelation}
                onDelete={handleDelete}
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
                    {canWrite && (
                      <button type="button" className="tb-card-delete" title="Delete task"
                        onClick={() => { if (confirm(`Delete task “${t.text || '(empty)'}”? This removes it from ${t.path}.`)) handleDelete(t); }}>🗑</button>
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
          taskTitles={taskTitles}
          taskRefs={taskRefs}
          onSave={handleEditorSave}
          onCancel={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
