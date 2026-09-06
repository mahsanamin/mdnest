import { useState } from 'react';
import { STICKY_COLORS, MAX_BODY } from '../stickies.js';

// One sticky, shared by the drawer and the full-screen corkboard.
//
// The two differ only in where the card sits: the drawer stacks them in a
// column, the board positions them absolutely and lets you drag them. Keeping
// one component means a change to the card — a new control, a colour, the done
// behaviour — cannot land in one view and be forgotten in the other.
//
// `dragHandleProps` is what makes it draggable, and it is applied to the top
// bar rather than the whole card on purpose: dragging from anywhere would mean
// a click into the text to fix a typo starts a drag instead of placing the
// cursor.
function StickyCard({ card, onPatch, onDelete, style, dragHandleProps, draggable }) {
  const [showColors, setShowColors] = useState(false);

  return (
    <div
      data-sticky-id={card.id}
      className={`sticky-card sticky-${card.color}${card.done ? ' done' : ''}${draggable ? ' draggable' : ''}`}
      style={style}
    >
      <div className="sticky-card-top" {...(dragHandleProps || {})}>
        <label className="sticky-check">
          <input
            type="checkbox"
            checked={card.done}
            onChange={() => onPatch({ done: !card.done })}
          />
          <span className="sticky-check-label">{card.done ? 'Done' : 'Mark done'}</span>
        </label>
        <div className="sticky-card-actions">
          <button
            className="sticky-color-btn"
            onClick={() => setShowColors((v) => !v)}
            title="Change colour"
            aria-label="Change colour"
          >
            <span className={`sticky-swatch sticky-${card.color}`} />
          </button>
          <button
            className="sticky-delete"
            onClick={onDelete}
            title="Delete sticky"
            aria-label="Delete sticky"
          >&times;</button>
        </div>
      </div>

      {showColors && (
        <div className="sticky-colors">
          {STICKY_COLORS.map((col) => (
            <button
              key={col}
              className={`sticky-swatch sticky-${col}${col === card.color ? ' active' : ''}`}
              onClick={() => { onPatch({ color: col }); setShowColors(false); }}
              title={col}
              aria-label={col}
            />
          ))}
        </div>
      )}

      <textarea
        value={card.body}
        maxLength={MAX_BODY}
        placeholder="Write something…"
        rows={2}
        onChange={(e) => onPatch({ body: e.target.value })}
        // Grow with the content. A sticky is short by nature, so a fixed box
        // would hide the end of half of them, and a scrollbar inside a 60px
        // card is worse than a taller card.
        ref={(el) => {
          if (!el) return;
          el.style.height = 'auto';
          el.style.height = `${el.scrollHeight}px`;
        }}
      />
    </div>
  );
}

export default StickyCard;
