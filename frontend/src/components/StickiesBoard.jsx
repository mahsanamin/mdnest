import { useRef, useState, useEffect, useCallback } from 'react';
import StickyCard from './StickyCard.jsx';
import {
  newSticky,
  addSticky,
  editSticky,
  removeSticky,
  isBoardFull,
  layoutBoard,
  boardExtent,
  clampToBoard,
  hasPosition,
  CARD_W,
  GAP,
  MAX_STICKIES,
} from '../stickies.js';

// The full-screen corkboard: the same cards as the drawer, laid out in space
// and draggable.
//
// Two things are deliberately NOT here. Opening the board never writes to the
// server — a card that has never been dragged is laid out on a grid at render
// time and only gains a stored position when you actually move it, so merely
// looking at the board cannot dirty it. And dragging is off below the mobile
// breakpoint: free positioning on a 380px screen produces a board you have to
// pan around to read, so there it falls back to a plain flowing grid.

// A pointer has to travel this far before it counts as a drag. Without it, the
// tiny movement inside an ordinary click lands as a 1px move that overwrites a
// carefully placed card's position and marks the board unsaved.
const DRAG_THRESHOLD = 4;

function StickiesBoard({ stickies, onChange, onCollapse, onClose, saveState, isMobile }) {
  const canvasRef = useRef(null);
  const focusIdRef = useRef(null);
  const [boardWidth, setBoardWidth] = useState(() => window.innerWidth);
  // The card being dragged and where it currently is. Held locally so the drag
  // is smooth: committing to the board state on every pointermove would rerun
  // the debounced save on every frame.
  const [drag, setDrag] = useState(null);

  const full = isBoardFull(stickies);

  useEffect(() => {
    const onResize = () => setBoardWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const positions = layoutBoard(stickies, boardWidth);
  const extent = boardExtent(positions, boardWidth, window.innerHeight);

  const handleAdd = useCallback(() => {
    if (full) return;
    const card = newSticky();
    focusIdRef.current = card.id;
    // Added unplaced, exactly like one created in the drawer — layoutBoard
    // deals it onto the first free slot, so it never lands underneath a card
    // that is already there.
    onChange(addSticky(stickies, card));
  }, [stickies, onChange, full]);

  useEffect(() => {
    if (!focusIdRef.current) return;
    const node = document.querySelector(`[data-sticky-id="${focusIdRef.current}"] textarea`);
    focusIdRef.current = null;
    if (node) node.focus();
  }, [stickies]);

  // Escape leaves the board. It covers the whole app, so without a keyboard
  // way out a user who opened it by accident has to find the small × .
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !drag) onCollapse(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCollapse, drag]);

  // Pointer events rather than mouse events: the same handler covers mouse,
  // trackpad and pen, and setPointerCapture keeps the card following even when
  // the pointer outruns it and leaves the element.
  const startDrag = useCallback((card, e) => {
    if (isMobile || e.button > 0) return;
    const start = positions.get(card.id) || { x: 0, y: 0 };
    const originX = e.clientX;
    const originY = e.clientY;
    const scroller = canvasRef.current?.parentElement;
    const scrollX0 = scroller ? scroller.scrollLeft : 0;
    const scrollY0 = scroller ? scroller.scrollTop : 0;
    e.currentTarget.setPointerCapture(e.pointerId);

    let moved = false;
    let latest = start;

    const onMove = (ev) => {
      // Account for the board scrolling under the pointer mid-drag, which it
      // does whenever a card is dragged toward an edge.
      const dx = ev.clientX - originX + ((scroller ? scroller.scrollLeft : 0) - scrollX0);
      const dy = ev.clientY - originY + ((scroller ? scroller.scrollTop : 0) - scrollY0);
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      moved = true;
      latest = clampToBoard(start.x + dx, start.y + dy);
      setDrag({ id: card.id, ...latest });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDrag(null);
      // A click that never became a drag must not write a position — that
      // would mark the board unsaved every time someone tapped a card.
      if (moved) onChange(editSticky(stickies, card.id, { x: latest.x, y: latest.y }));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [positions, stickies, onChange, isMobile]);

  // Tidy up: drop every stored position so layoutBoard deals the whole board
  // back onto the grid. Clearing x/y rather than computing and storing grid
  // coordinates keeps "never placed" as the resting state — the cards reflow
  // with the window afterwards instead of being frozen at one width's layout.
  const tidyUp = useCallback(() => {
    let next = stickies;
    for (const c of stickies) {
      if (hasPosition(c)) next = editSticky(next, c.id, { x: null, y: null });
    }
    onChange(next);
  }, [stickies, onChange]);

  return (
    <div className="stickies-board">
      <div className="stickies-board-header">
        <h2>Stickies</h2>
        <span className={`stickies-save-state ${saveState}`}>
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'error' && 'Not saved'}
        </span>
        <button
          className="stickies-add board"
          onClick={handleAdd}
          disabled={full}
          title={full ? `A board holds at most ${MAX_STICKIES} stickies` : 'Add a sticky'}
        >
          + New sticky
        </button>
        {/* Only offered once something has actually been dragged — on an
            untouched board it would do nothing visible and read as broken. */}
        {!isMobile && stickies.some(hasPosition) && (
          <button className="stickies-tidy" onClick={tidyUp} title="Line every sticky back up on the grid">
            Tidy up
          </button>
        )}
        <button
          className="stickies-collapse"
          onClick={onCollapse}
          title="Back to the side panel"
          aria-label="Back to the side panel"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
        <button className="stickies-close" onClick={onClose} aria-label="Close stickies">&times;</button>
      </div>

      <div className={`stickies-canvas-scroll${isMobile ? ' flow' : ''}`}>
        {stickies.length === 0 && (
          <div className="stickies-empty">
            <p>No stickies yet.</p>
            <p className="stickies-empty-note">
              Private to you and kept on this server only — stickies are never
              synced to a git remote. Anything you need backed up belongs in a note.
            </p>
          </div>
        )}

        <div
          ref={canvasRef}
          className="stickies-canvas"
          style={isMobile ? undefined : { width: extent.width, height: extent.height }}
        >
          {stickies.map((c) => {
            const live = drag && drag.id === c.id ? drag : positions.get(c.id);
            return (
              <StickyCard
                key={c.id}
                card={c}
                draggable={!isMobile}
                style={isMobile ? undefined : {
                  position: 'absolute',
                  left: live.x,
                  top: live.y,
                  width: CARD_W,
                  // The card being dragged rides above the rest, or it slides
                  // under whatever it is being dropped next to.
                  zIndex: drag && drag.id === c.id ? 10 : 1,
                }}
                dragHandleProps={isMobile ? undefined : {
                  onPointerDown: (e) => startDrag(c, e),
                }}
                onPatch={(patch) => onChange(editSticky(stickies, c.id, patch))}
                onDelete={() => onChange(removeSticky(stickies, c.id))}
              />
            );
          })}
        </div>
      </div>

      {!isMobile && stickies.length > 0 && (
        <div className="stickies-board-hint" style={{ left: GAP }}>
          Drag a sticky by its top bar to move it.
        </div>
      )}
    </div>
  );
}

export default StickiesBoard;
