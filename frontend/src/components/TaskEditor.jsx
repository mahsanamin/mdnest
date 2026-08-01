import { useState } from 'react';
import './TaskBoard.css';

// TaskEditor is the full create/edit form for a task and its detail block
// (status/column, due, priority, workload, tags, steps, notes). It emits a spec
// the backend renders to markdown, so the note stays the source of truth.
export default function TaskEditor({ board, task, defaultNote, defaultColumn, notePaths, onSave, onCancel }) {
  const isNew = !task;
  const cols = board?.columns || [];
  const [title, setTitle] = useState(task?.text || '');
  const [note, setNote] = useState(defaultNote || '');
  const [column, setColumn] = useState(task?.column || defaultColumn || (cols[0]?.id ?? ''));
  const [due, setDue] = useState(task?.due || '');
  const [priority, setPriority] = useState(task?.priority || '');
  const [workload, setWorkload] = useState(task?.workload || '');
  const [tags, setTags] = useState((task?.tags || []).join(', '));
  const [defaultExpanded, setDefaultExpanded] = useState(!!task?.defaultExpanded);
  const [steps, setSteps] = useState((task?.steps || []).map((s) => ({ text: s.text, checked: s.checked })));
  const [notes, setNotes] = useState(task?.notes || '');
  const [err, setErr] = useState(null);

  const addStep = () => setSteps((s) => [...s, { text: '', checked: false }]);
  const updateStep = (i, patch) => setSteps((s) => s.map((st, j) => (j === i ? { ...st, ...patch } : st)));
  const removeStep = (i) => setSteps((s) => s.filter((_, j) => j !== i));

  const submit = () => {
    if (!title.trim()) { setErr('A title is required'); return; }
    const spec = {
      title: title.trim(),
      column,
      due: due.trim(),
      priority,
      workload: workload.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
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
        </div>

        <label className="tb-modal-field">Tags
          <input value={tags} placeholder="design, ui" onChange={(e) => setTags(e.target.value)} />
        </label>

        <label className="tb-check-field">
          <input type="checkbox" checked={defaultExpanded} onChange={(e) => setDefaultExpanded(e.target.checked)} />
          Expanded by default
        </label>

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
