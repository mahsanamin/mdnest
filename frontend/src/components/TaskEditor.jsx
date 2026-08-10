import { useMemo, useState } from 'react';
import './TaskBoard.css';
import { buildRelationLookup, toRef, relLabel, isKnownOption } from '../relations';

// RelationField edits one relation kind (depends-on / blocked-by / related-to)
// as a list of removable chips plus an add-input: picking a datalist suggestion
// or pressing Enter appends a task, so several dependencies can be added without
// any comma juggling.
function RelationField({ icon, label, values, listId, isOption, labelFor, onAdd, onRemove }) {
  const [input, setInput] = useState('');
  const commit = (raw) => { const v = raw.trim(); if (v) onAdd(v); setInput(''); };
  return (
    <div className="tb-editor-rel">
      <span className="tb-editor-rel-label">{icon} {label}</span>
      {values.length > 0 && (
        <div className="tb-rel-chips">
          {values.map((v, i) => (
            <span key={v + '\u0000' + i} className="tb-rel-chip">
              {labelFor(v)}
              <button type="button" className="tb-rel-chip-x" aria-label={`Remove ${labelFor(v)}`} onClick={() => onRemove(i)}>×</button>
            </span>
          ))}
        </div>
      )}
      <input
        value={input}
        list={listId}
        placeholder="add a task (title or ref)"
        onChange={(e) => { const val = e.target.value; if (isOption(val)) commit(val); else setInput(val); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(input); } }}
      />
    </div>
  );
}

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
  // Relations are stored by stable ref (comma-free, rename-proof) as a list, so
  // a task can carry several dependencies. Kept as arrays here; entered
  // titles/refs are resolved to refs on add and again on save.
  const [dependsOn, setDependsOn] = useState(task?.dependsOn || []);
  const [blockedBy, setBlockedBy] = useState(task?.blockedBy || []);
  const [relatedTo, setRelatedTo] = useState(task?.relatedTo || []);
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

  // Relation lookup: resolve an entered title/ref to a stable ref, back to a
  // title for the chip label, and tell whether a typed value matches a known
  // task (so a datalist pick auto-commits).
  const relLookup = useMemo(() => buildRelationLookup([
    ...(taskRefs || []).map(({ ref, title: t }) => ({ ref, title: t })),
    ...(taskTitles || []).map((t) => ({ title: t })),
  ]), [taskRefs, taskTitles]);
  const resolveRef = (v) => toRef(relLookup, v);
  const relationLabel = (v) => relLabel(relLookup, v);
  const isOption = (v) => isKnownOption(relLookup, v);
  const addRel = (setter) => (raw) => { const tok = resolveRef(raw); setter((cur) => (cur.includes(tok) ? cur : [...cur, tok])); };
  const removeRel = (setter) => (i) => setter((cur) => cur.filter((_, j) => j !== i));

  const submit = () => {
    if (!title.trim()) { setErr('A title is required'); return; }
    const spec = {
      title: title.trim(),
      column,
      due: due.trim(),
      priority,
      workload: workload.trim(),
      assignee: assignee.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      dependsOn: dependsOn.map(resolveRef),
      blockedBy: blockedBy.map(resolveRef),
      relatedTo: relatedTo.map(resolveRef),
      defaultExpanded,
      steps: steps.map((s) => ({ text: s.text.trim(), checked: !!s.checked })).filter((s) => s.text),
      notes: notes.replace(/\s+$/, ''),
    };
    Promise.resolve(onSave(spec, isNew ? note.trim() : task.path)).catch((e) => setErr(e?.message || 'Failed to save task'));
  };

  return (
    <div className="tb-modal-backdrop" onClick={onCancel}>
      <div className="tb-modal tb-editor" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? 'New task' : 'Edit task'}</h3>

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
            <RelationField icon="⬆" label="Depends on" values={dependsOn} listId="tb-editor-tasks"
              isOption={isOption} labelFor={relationLabel} onAdd={addRel(setDependsOn)} onRemove={removeRel(setDependsOn)} />
            <RelationField icon="⛔" label="Blocked by" values={blockedBy} listId="tb-editor-tasks"
              isOption={isOption} labelFor={relationLabel} onAdd={addRel(setBlockedBy)} onRemove={removeRel(setBlockedBy)} />
            <RelationField icon="🔗" label="Related to" values={relatedTo} listId="tb-editor-tasks"
              isOption={isOption} labelFor={relationLabel} onAdd={addRel(setRelatedTo)} onRemove={removeRel(setRelatedTo)} />
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

        {err && <div className="tb-error">{err}</div>}
        <div className="tb-modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>{isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
