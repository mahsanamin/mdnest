import { useMemo, useState } from 'react';
import './TaskBoard.css';

// TaskEditor is the full create/edit form for a task and its detail block
// (status/column, due, priority, workload, assignee, tags, steps, notes). It
// emits a spec the backend renders to markdown, so the note stays the source of
// truth.
export default function TaskEditor({ board, task, defaultNote, defaultColumn, notePaths, currentUser, users, tagSuggestions, taskTitles, taskRefs, onSave, onCancel }) {
  const isNew = !task;
  const cols = board?.columns || [];
  const [title, setTitle] = useState(task?.text || '');
  const [note, setNote] = useState(defaultNote || '');
  const [column, setColumn] = useState(task?.column || defaultColumn || (cols[0]?.id ?? ''));
  const [due, setDue] = useState(task?.due || '');
  const [priority, setPriority] = useState(task?.priority || '');
  const [workload, setWorkload] = useState(task?.workload || '');
  // Who is responsible. New tasks default to the current user; editing keeps
  // whatever the task already carries (empty stays empty).
  const [assignee, setAssignee] = useState(task ? (task.assignee || '') : (currentUser || ''));
  const [tags, setTags] = useState((task?.tags || []).join(', '));
  // Relations reference other tasks by title (comma-separated); each field is
  // autocompleted from the existing task titles.
  const [dependsOn, setDependsOn] = useState((task?.dependsOn || []).join(', '));
  const [blockedBy, setBlockedBy] = useState((task?.blockedBy || []).join(', '));
  const [relatedTo, setRelatedTo] = useState((task?.relatedTo || []).join(', '));
  const [defaultExpanded, setDefaultExpanded] = useState(!!task?.defaultExpanded);
  const [steps, setSteps] = useState((task?.steps || []).map((s) => ({ text: s.text, checked: s.checked })));
  const [notes, setNotes] = useState(task?.notes || '');
  const [err, setErr] = useState(null);

  const addStep = () => setSteps((s) => [...s, { text: '', checked: false }]);
  const updateStep = (i, patch) => setSteps((s) => s.map((st, j) => (j === i ? { ...st, ...patch } : st)));
  const removeStep = (i) => setSteps((s) => s.filter((_, j) => j !== i));

  // Existing tags offered as one-click chips next to the free-text input, so a
  // task can be dropped onto one or more established tags without retyping.
  const selectedTags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  const toggleTag = (tag) => {
    const set = selectedTags.slice();
    const i = set.indexOf(tag);
    if (i >= 0) set.splice(i, 1); else set.push(tag);
    setTags(set.join(', '));
  };

  // Assignee choices: the namespace's members, plus the current user and the
  // task's existing assignee so the pre-filled/legacy value is always
  // selectable even if that person no longer holds a grant.
  const assigneeOptions = useMemo(() => {
    const names = new Set((users || []).map((u) => u.username).filter(Boolean));
    if (currentUser) names.add(currentUser);
    if (task?.assignee) names.add(task.assignee);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [users, currentUser, task]);

  const submit = () => {
    if (!title.trim()) { setErr('A title is required'); return; }
    // A relation may be typed as a task title or a task ref; resolve refs back
    // to the referenced task's title (relations are stored by title).
    const refToTitle = new Map((taskRefs || []).map(({ ref, title: t }) => [String(ref).toLowerCase(), t]));
    const parseRels = (v) => v.split(',').map((t) => t.trim()).filter(Boolean).map((t) => refToTitle.get(t.toLowerCase()) || t);
    const spec = {
      title: title.trim(),
      column,
      due: due.trim(),
      priority,
      workload: workload.trim(),
      assignee: assignee.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      dependsOn: parseRels(dependsOn),
      blockedBy: parseRels(blockedBy),
      relatedTo: parseRels(relatedTo),
      defaultExpanded,
      steps: steps.map((s) => ({ text: s.text.trim(), checked: !!s.checked })).filter((s) => s.text),
      notes: notes.replace(/\s+$/, ''),
    };
    onSave(spec, isNew ? note.trim() : task.path);
  };

  return (
    <div className="tb-modal-backdrop" onClick={onCancel}>
      <div className="tb-modal tb-editor" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? 'New task' : 'Edit task'}</h3>
        {err && <div className="tb-error">{err}</div>}

        <label className="tb-modal-field">Title
          <input className="tb-col-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        {isNew && (
          <label className="tb-modal-field">Note
            <input
              className="tb-col-title"
              value={note}
              list="tb-editor-notes"
              placeholder={board?.defaultNote ? `default: ${board.defaultNote}` : 'tasks.md'}
              onChange={(e) => setNote(e.target.value)}
            />
            <datalist id="tb-editor-notes">
              {(notePaths || []).map((p) => <option key={p} value={p} />)}
            </datalist>
          </label>
        )}

        <div className="tb-editor-grid">
          <label className="tb-modal-field">Column
            <select value={column} onChange={(e) => setColumn(e.target.value)}>
              {cols.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </label>
          <label className="tb-modal-field">Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">—</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </label>
          <label className="tb-modal-field">Due
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label className="tb-modal-field">Workload
            <input value={workload} placeholder="easy / medium / hard" onChange={(e) => setWorkload(e.target.value)} />
          </label>
          <label className="tb-modal-field">Assignee
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">—</option>
              {assigneeOptions.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
        </div>

        <label className="tb-modal-field">Tags
          <input value={tags} placeholder="design, ui" onChange={(e) => setTags(e.target.value)} />
          {(tagSuggestions || []).length > 0 && (
            <div className="tb-editor-tag-suggest">
              {tagSuggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`tb-filter-tag${selectedTags.includes(tag) ? ' active' : ''}`}
                  onClick={() => toggleTag(tag)}
                  title={selectedTags.includes(tag) ? `Remove ${tag}` : `Add ${tag}`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </label>

        <label className="tb-check-field">
          <input type="checkbox" checked={defaultExpanded} onChange={(e) => setDefaultExpanded(e.target.checked)} />
          Expanded by default
        </label>

        <div className="tb-modal-field">Relations
          <datalist id="tb-editor-tasks">
            {(taskTitles || []).map((t) => <option key={t} value={t} />)}
            {(taskRefs || []).map(({ ref, title: t }) => <option key={'r-' + ref} value={ref}>{t}</option>)}
          </datalist>
          <div className="tb-editor-rels">
            <label className="tb-editor-rel">⬆ Depends on
              <input value={dependsOn} list="tb-editor-tasks" placeholder="title or ref, title or ref" onChange={(e) => setDependsOn(e.target.value)} />
            </label>
            <label className="tb-editor-rel">⛔ Blocked by
              <input value={blockedBy} list="tb-editor-tasks" placeholder="title or ref" onChange={(e) => setBlockedBy(e.target.value)} />
            </label>
            <label className="tb-editor-rel">🔗 Related to
              <input value={relatedTo} list="tb-editor-tasks" placeholder="title or ref" onChange={(e) => setRelatedTo(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="tb-modal-field">Steps
          <div className="tb-editor-steps">
            {steps.map((s, i) => (
              <div className="tb-editor-step" key={i}>
                <input type="checkbox" checked={s.checked} onChange={(e) => updateStep(i, { checked: e.target.checked })} />
                <input value={s.text} placeholder="Step" onChange={(e) => updateStep(i, { text: e.target.value })} />
                <button type="button" className="danger" onClick={() => removeStep(i)} title="Remove">✕</button>
              </div>
            ))}
            <button type="button" className="tb-add-col" onClick={addStep}>+ Add step</button>
          </div>
        </div>

        <label className="tb-modal-field">Notes
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="tb-modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>{isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
