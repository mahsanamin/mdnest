import { useRef, useEffect, useCallback, useState } from 'react';
import {
  STICKY_COLORS,
  MAX_BODY,
  newSticky,
  addSticky,
  editSticky,
  removeSticky,
  isBoardFull,
  MAX_STICKIES,
} from '../stickies.js';

// The sticky board drawer. Mirrors CommentSidebar's slide-out: a fixed panel
// on the right that the main column makes room for, and only one of the two is
// open at a time.
//
// It renders and nothing else — every board mutation goes through the pure
// functions in stickies.js, and persistence is the caller's debounced save.
// That split is what lets the interesting rules be tested without a DOM.
function StickiesPanel({ stickies, onChange, onClose, saveState, width, onWidthChange }) {
  const [pickerFor, setPickerFor] = useState(null); // card id whose swatches are open
  const focusIdRef = useRef(null);                  // card to focus after the next render

  const full = isBoardFull(stickies);

  const handleAdd = useCallback(() => {
    if (full) return;
    const card = newSticky();
    // Focus is deferred to an effect rather than done here: the textarea does
    // not exist until React has rendered the new card.
    focusIdRef.current = card.id;
    onChange(addSticky(stickies, card));
  }, [stickies, onChange, full]);

  useEffect(() => {
    if (!focusIdRef.current) return;
    const node = document.querySelector(`[data-sticky-id="${focusIdRef.current}"] textarea`);
    focusIdRef.current = null;
    if (node) node.focus();
  }, [stickies]);

  return (
    <div className="stickies-panel" style={width ? { width } : undefined}>
      {onWidthChange && (
        <div
          className="stickies-resize-handle"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = width || 320;
            const onMove = (ev) => {
              // Anchored to the right edge, so dragging left widens it.
              onWidthChange(Math.min(760, Math.max(260, startWidth + startX - ev.clientX)));
            };
            const onUp = () => {
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            };
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        />
      )}

      <div className="stickies-header">
        <h3>Stickies</h3>
        {/* The save state is shown, not hidden behind a silent autosave. The
            board is the one place in mdnest holding content that exists
            nowhere else — no namespace, no git remote — so "did that land?"
            is a fair question and an error must be visible, not console-only. */}
        <span className={`stickies-save-state ${saveState}`}>
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'error' && 'Not saved'}
        </span>
        <button className="stickies-close" onClick={onClose} aria-label="Close stickies">&times;</button>
      </div>

      <div className="stickies-add-row">
        <button
          className="stickies-add"
          onClick={handleAdd}
          disabled={full}
          title={full ? `A board holds at most ${MAX_STICKIES} stickies` : 'Add a sticky'}
        >
          + New sticky
        </button>
      </div>

      <div className="stickies-list">
        {stickies.length === 0 && (
          <div className="stickies-empty">
            <p>No stickies yet.</p>
            {/* Said here rather than in the docs alone: this is the one place
                in mdnest where content is deliberately not backed up, and the
                moment to know that is before you paste something into it. */}
            <p className="stickies-empty-note">
              Private to you and kept on this server only — stickies are never
              synced to a git remote. Anything you need backed up belongs in a note.
            </p>
          </div>
        )}

        {stickies.map((c) => (
          <div
            key={c.id}
            data-sticky-id={c.id}
            className={`sticky-card sticky-${c.color}${c.done ? ' done' : ''}`}
          >
            <div className="sticky-card-top">
              <label className="sticky-check">
                <input
                  type="checkbox"
                  checked={c.done}
                  onChange={() => onChange(editSticky(stickies, c.id, { done: !c.done }))}
                />
                <span className="sticky-check-label">{c.done ? 'Done' : 'Mark done'}</span>
              </label>
              <div className="sticky-card-actions">
                <button
                  className="sticky-color-btn"
                  onClick={() => setPickerFor(pickerFor === c.id ? null : c.id)}
                  title="Change colour"
                  aria-label="Change colour"
                >
                  <span className={`sticky-swatch sticky-${c.color}`} />
                </button>
                <button
                  className="sticky-delete"
                  onClick={() => onChange(removeSticky(stickies, c.id))}
                  title="Delete sticky"
                  aria-label="Delete sticky"
                >&times;</button>
              </div>
            </div>

            {pickerFor === c.id && (
              <div className="sticky-colors">
                {STICKY_COLORS.map((col) => (
                  <button
                    key={col}
                    className={`sticky-swatch sticky-${col}${col === c.color ? ' active' : ''}`}
                    onClick={() => {
                      onChange(editSticky(stickies, c.id, { color: col }));
                      setPickerFor(null);
                    }}
                    title={col}
                    aria-label={col}
                  />
                ))}
              </div>
            )}

            <textarea
              value={c.body}
              maxLength={MAX_BODY}
              placeholder="Write something…"
              rows={2}
              onChange={(e) => onChange(editSticky(stickies, c.id, { body: e.target.value }))}
              // Grow with the content. A sticky is short by nature, so a fixed
              // two-row box would hide the end of half of them and a scrollbar
              // inside a 60px card is worse than a taller card.
              ref={(el) => {
                if (!el) return;
                el.style.height = 'auto';
                el.style.height = `${el.scrollHeight}px`;
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default StickiesPanel;
