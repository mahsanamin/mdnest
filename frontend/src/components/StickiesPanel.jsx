import { useRef, useEffect, useCallback } from 'react';
import StickyCard from './StickyCard.jsx';
import {
  newSticky,
  addSticky,
  editSticky,
  removeSticky,
  isBoardFull,
  MAX_STICKIES,
} from '../stickies.js';

// The sticky board as a right-edge drawer — the quick way in, for jotting one
// down without leaving the note you are reading. The full-screen corkboard
// (StickiesBoard) is the same cards laid out spatially; the Expand button
// swaps between them.
function StickiesPanel({ stickies, onChange, onClose, onExpand, saveState, width, onWidthChange }) {
  const focusIdRef = useRef(null); // card to focus after the next render

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
        <button
          className="stickies-expand"
          onClick={onExpand}
          title="Open the full board"
          aria-label="Open the full board"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
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
          <StickyCard
            key={c.id}
            card={c}
            onPatch={(patch) => onChange(editSticky(stickies, c.id, patch))}
            onDelete={() => onChange(removeSticky(stickies, c.id))}
          />
        ))}
      </div>
    </div>
  );
}

export default StickiesPanel;
