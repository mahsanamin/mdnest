import { useState } from 'react';
import './TaskBoard.css';

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// BoardColumnsEditor is a small modal for editing the per-namespace kanban
// column layout (.mdnest/board.json). Column ids are stable once created; the
// user edits the title, the status value written into a task's `status:` field,
// and which column holds checked ("done") items.
export default function BoardColumnsEditor({ board, onCancel, onSave }) {
  const [columns, setColumns] = useState(() =>
    (board?.columns || []).map((c) => ({ ...c }))
  );
  const [defaultNote, setDefaultNote] = useState(board?.defaultNote || '');
  const [err, setErr] = useState(null);

  const update = (idx, patch) => {
    setColumns((cur) => cur.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const move = (idx, delta) => {
    setColumns((cur) => {
      const next = [...cur];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return cur;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const remove = (idx) => setColumns((cur) => cur.filter((_, i) => i !== idx));

  const add = () => {
    setColumns((cur) => {
      const ids = new Set(cur.map((c) => c.id));
      let id = `col-${cur.length + 1}`;
      while (ids.has(id)) id = `${id}-x`;
      return [...cur, { id, title: 'New column', status: '', done: false }];
    });
  };

  const handleSave = () => {
    // Assign a stable id to any column that lacks one, derived from its title.
    const ids = new Set();
    const normalized = columns.map((c, i) => {
      let id = c.id || slugify(c.title) || `col-${i + 1}`;
      while (ids.has(id)) id += '-x';
      ids.add(id);
      return {
        id,
        title: c.title.trim(),
        status: slugify(c.status || c.tag || ''),
        done: !!c.done,
      };
    });
    if (normalized.length === 0) { setErr('At least one column is required'); return; }
    if (normalized.some((c) => !c.title)) { setErr('Every column needs a title'); return; }
    onSave({ version: board?.version || 1, columns: normalized, defaultNote: defaultNote.trim() });
  };

  return (
    <div className="tb-modal-backdrop" onClick={onCancel}>
      <div className="tb-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Board settings</h3>
        <label className="tb-modal-field">Default note for new tasks
          <input
            className="tb-col-title"
            value={defaultNote}
            placeholder="tasks.md"
            onChange={(e) => setDefaultNote(e.target.value)}
          />
        </label>
        <p className="tb-modal-hint">
          The <strong>status</strong> is written into a task's
          <code>status:</code> field when you drop it here. Mark one column
          <strong>Done</strong> to hold checked items.
        </p>
        {err && <div className="tb-error">{err}</div>}
        <div className="tb-col-editor">
          {columns.map((c, i) => (
            <div className="tb-col-row" key={i}>
              <input
                className="tb-col-title"
                value={c.title}
                placeholder="Title"
                onChange={(e) => update(i, { title: e.target.value })}
              />
              <input
                className="tb-col-tag"
                value={c.status ?? c.tag ?? ''}
                placeholder="status"
                onChange={(e) => update(i, { status: e.target.value })}
              />
              <label className="tb-col-done" title="Holds checked items">
                <input
                  type="checkbox"
                  checked={!!c.done}
                  onChange={(e) => update(i, { done: e.target.checked })}
                />
                Done
              </label>
              <span className="tb-col-actions">
                <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === columns.length - 1} title="Move down">↓</button>
                <button onClick={() => remove(i)} className="danger" title="Remove">✕</button>
              </span>
            </div>
          ))}
        </div>
        <button className="tb-add-col" onClick={add}>+ Add column</button>
        <div className="tb-modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
