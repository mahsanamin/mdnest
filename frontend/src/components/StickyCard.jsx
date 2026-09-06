import { useState, useRef, useEffect } from 'react';
import {
  STICKY_COLORS,
  MAX_TITLE,
  MAX_BODY,
  MAX_ITEM_LEN,
  MAX_ITEMS,
  newItem,
  addItem,
  editItem,
  removeItem,
  isCardDone,
  cardProgress,
  isCardFull,
} from '../stickies.js';

// One sticky, shared by the drawer and the full-screen corkboard.
//
// The two differ only in where the card sits: the drawer stacks them in a
// column, the board positions them absolutely and lets you drag them. Keeping
// one component means a change to the card cannot land in one view and be
// forgotten in the other.
//
// A card is a title, some text, and a checklist — all three optional, so the
// same card covers a scribbled note, a titled note and a to-do list without
// three kinds of card. "Done" lives on the checklist item rather than on the
// card: a single card-level flag forces "buy milk, call bank, post form" to be
// either three separate notes or one note you can only tick when all of it is
// finished.
function StickyCard({ card, onCardChange, onDelete, style, dragHandleProps, draggable, onResizeStart }) {
  const [showColors, setShowColors] = useState(false);
  const focusItemRef = useRef(null);

  const progress = cardProgress(card);
  const allDone = isCardDone(card);

  // A newly added item's input does not exist until React has rendered it.
  useEffect(() => {
    if (!focusItemRef.current) return;
    const node = document.querySelector(`[data-item-id="${focusItemRef.current}"] input[type=text]`);
    focusItemRef.current = null;
    if (node) node.focus();
  }, [card.items]);

  const appendItem = () => {
    if (isCardFull(card)) return;
    const item = newItem();
    focusItemRef.current = item.id;
    onCardChange(addItem(card, item));
  };

  return (
    <div
      data-sticky-id={card.id}
      className={`sticky-card sticky-${card.color}${allDone ? ' done' : ''}${draggable ? ' draggable' : ''}`}
      style={style}
    >
      {/* The drag handle. Its controls have to opt OUT of the drag: a
          pointerdown here calls setPointerCapture, which redirects the
          following pointerup to this bar, so the browser fires `click` on the
          bar instead of on the button that was pressed — and the colour and
          delete buttons silently stopped working on the board. Bailing out
          when the press lands on a control is what keeps them clickable. */}
      <div
        className="sticky-card-top"
        {...(dragHandleProps || {})}
        onPointerDown={(e) => {
          if (e.target.closest('button, input, label, .sticky-colors')) return;
          if (dragHandleProps?.onPointerDown) dragHandleProps.onPointerDown(e);
        }}
      >
        <span className="sticky-progress">
          {progress.total > 0 ? `${progress.done}/${progress.total}` : ''}
        </span>
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
              onClick={() => { onCardChange({ ...card, color: col }); setShowColors(false); }}
              title={col}
              aria-label={col}
            />
          ))}
        </div>
      )}

      <input
        className="sticky-title"
        type="text"
        value={card.title}
        maxLength={MAX_TITLE}
        placeholder="Title"
        onChange={(e) => onCardChange({ ...card, title: e.target.value })}
      />

      <textarea
        className="sticky-body"
        value={card.body}
        maxLength={MAX_BODY}
        placeholder="Notes…"
        rows={2}
        onChange={(e) => onCardChange({ ...card, body: e.target.value })}
        // Grow with the content. A sticky is short by nature, so a fixed box
        // would hide the end of half of them, and a scrollbar inside a 60px
        // card is worse than a taller card.
        ref={(el) => {
          if (!el) return;
          el.style.height = 'auto';
          el.style.height = `${el.scrollHeight}px`;
        }}
      />

      {card.items.length > 0 && (
        <ul className="sticky-items">
          {card.items.map((item) => (
            <li key={item.id} data-item-id={item.id} className={item.done ? 'done' : ''}>
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => onCardChange(editItem(card, item.id, { done: !item.done }))}
                aria-label={item.text || 'checklist item'}
              />
              {/* A textarea, not a text input. An input cannot wrap, so any
                  to-do longer than the card was silently cut off at the edge
                  — the text was still there, but you could only read the
                  first few words of it. This grows instead. */}
              <textarea
                rows={1}
                value={item.text}
                maxLength={MAX_ITEM_LEN}
                placeholder="To do…"
                onChange={(e) => onCardChange(editItem(card, item.id, { text: e.target.value }))}
                onKeyDown={(e) => {
                  // Enter adds the next line, the way any list behaves. A
                  // textarea would insert a newline instead, which the card
                  // has no way to render as anything but a taller row.
                  if (e.key === 'Enter') { e.preventDefault(); appendItem(); }
                  // Backspace in an already-empty row removes it, so an item
                  // added by mistake goes away without reaching for the ×.
                  if (e.key === 'Backspace' && item.text === '') {
                    e.preventDefault();
                    onCardChange(removeItem(card, item.id));
                  }
                }}
                ref={(el) => {
                  if (!el) return;
                  el.style.height = 'auto';
                  el.style.height = `${el.scrollHeight}px`;
                }}
              />
              <button
                className="sticky-item-remove"
                onClick={() => onCardChange(removeItem(card, item.id))}
                title="Remove item"
                aria-label="Remove item"
              >&times;</button>
            </li>
          ))}
        </ul>
      )}

      {/* Only on the board: in the drawer a card is as wide as the panel, and
          the panel already has its own resize handle. */}
      {onResizeStart && (
        <div
          className="sticky-resize"
          onPointerDown={(e) => onResizeStart(card, e)}
          title="Drag to resize"
          aria-hidden="true"
        />
      )}

      <button
        className="sticky-add-item"
        onClick={appendItem}
        disabled={isCardFull(card)}
        title={isCardFull(card) ? `A sticky holds at most ${MAX_ITEMS} items` : 'Add a to-do'}
      >
        + to-do
      </button>
    </div>
  );
}

export default StickyCard;
