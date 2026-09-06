// Sticky-board state, as pure functions.
//
// No React imports on purpose, the same way echo-gate.js and tree-refresh.js
// are written: the panel is a thin renderer over these, so the rules that
// actually matter (a new card goes on top, an edit never reorders the board,
// a delete removes exactly one card) can be tested without mounting anything.
//
// Every function returns a NEW array. The board is saved by PUTting it whole,
// so a mutation in place would leave the debounced save writing an array the
// component has already forgotten it changed.

// The palette the server accepts. Kept in sync with store.StickyColors in
// backend/store/stickies.go — the server rejects anything else, so adding one
// here alone would produce a 400 the user cannot act on.
export const STICKY_COLORS = ['yellow', 'pink', 'blue', 'green', 'grey'];

export const DEFAULT_COLOR = 'yellow';

// Matches store.MaxStickies / MaxStickyBody. Checked client-side too, so the
// user is stopped at the point of the action rather than by a failed save
// several hundred milliseconds later.
export const MAX_STICKIES = 200;
export const MAX_BODY = 4096;

// coord accepts only a real, finite number as a position. Anything else — a
// missing field, a string, NaN from a hand-edited stickies.json — means "not
// placed", because a NaN reaching the layout maths turns the whole board's
// size into NaN and collapses it, not just the one card.
function coord(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// newSticky builds an empty card. The id is generated client-side because the
// client owns the array — the server only ever stores what it is given — and
// it has to be unique within one board, not globally, so time plus a random
// suffix is enough. crypto.randomUUID would be nicer but is unavailable on
// plain HTTP in some browsers, which is exactly how mdnest is often reached.
export function newSticky(color = DEFAULT_COLOR, now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    id: `s-${now}-${rand}`,
    body: '',
    done: false,
    color: STICKY_COLORS.includes(color) ? color : DEFAULT_COLOR,
    // Unplaced. The board deals it onto the first free grid slot; it gains a
    // real position only if the user drags it.
    x: null,
    y: null,
    created_at: Math.floor(now / 1000),
    updated_at: Math.floor(now / 1000),
  };
}

// addSticky puts a new card at the TOP. Newest-first is the only order that
// makes an "add" visible without scrolling once a board has more than a
// screenful, and the button that creates it sits at the top too.
export function addSticky(cards, card) {
  return [card, ...cards];
}

// editSticky applies a patch to one card and stamps updated_at. Position is
// deliberately untouched: re-sorting on edit would move a card out from under
// the cursor mid-sentence.
export function editSticky(cards, id, patch, now = Date.now()) {
  return cards.map((c) =>
    c.id === id ? { ...c, ...patch, updated_at: Math.floor(now / 1000) } : c,
  );
}

export function removeSticky(cards, id) {
  return cards.filter((c) => c.id !== id);
}

// --- Corkboard layout -------------------------------------------------------
//
// On the full-screen board a card sits wherever it was dropped. A card that
// has never been dragged has no position at all (x/y are null, not 0 — see the
// Sticky struct in Go for why that distinction is a pointer), so the board has
// to place it somewhere sensible without writing to the server just for being
// looked at.

// Nominal card footprint used for grid placement and for sizing the scrollable
// canvas. Cards grow taller with their content; this is the slot they are
// placed on, not a clamp on how big they render.
export const CARD_W = 210;
export const CARD_H = 150;
export const GAP = 18;

export const hasPosition = (c) => typeof c.x === 'number' && typeof c.y === 'number';

// layoutBoard resolves every card to an {x, y}.
//
// Placed cards keep exactly what they were given. Unplaced ones are dealt onto
// the first free grid slot in reading order, SKIPPING slots a placed card is
// already sitting on — otherwise adding a card to a board whose corner is
// occupied drops the new one directly underneath an existing note, where it is
// invisible and looks lost.
//
// Deliberately pure and deliberately not persisted: opening the board must not
// write to the server. A card only gains a stored position when it is dragged.
export function layoutBoard(cards, boardWidth) {
  const cols = Math.max(1, Math.floor((boardWidth - GAP) / (CARD_W + GAP)));
  const slot = (i) => ({
    x: GAP + (i % cols) * (CARD_W + GAP),
    y: GAP + Math.floor(i / cols) * (CARD_H + GAP),
  });

  // Which grid slots the placed cards overlap. A placed card rarely lands on
  // an exact slot, so occupancy is by nearest cell.
  const taken = new Set();
  for (const c of cards) {
    if (!hasPosition(c)) continue;
    const col = Math.round((c.x - GAP) / (CARD_W + GAP));
    const row = Math.round((c.y - GAP) / (CARD_H + GAP));
    if (col >= 0 && col < cols && row >= 0) taken.add(row * cols + col);
  }

  const out = new Map();
  let next = 0;
  for (const c of cards) {
    if (hasPosition(c)) {
      out.set(c.id, { x: c.x, y: c.y });
      continue;
    }
    while (taken.has(next)) next++;
    taken.add(next);
    out.set(c.id, slot(next));
    next++;
  }
  return out;
}

// clampToBoard keeps a dropped card inside the board. Without the floor a card
// dragged off the top-left is unreachable — the canvas cannot scroll to
// negative coordinates — and the server rejects a negative position anyway, so
// the save would fail silently after the card had already moved.
export function clampToBoard(x, y, maxCoord = 20000) {
  const fix = (v) => Math.round(Math.min(maxCoord, Math.max(0, Number.isFinite(v) ? v : 0)));
  return { x: fix(x), y: fix(y) };
}

// boardExtent sizes the scrollable canvas: far enough to show every card plus
// room to drop another one, and never smaller than the viewport.
export function boardExtent(positions, viewportW, viewportH) {
  let w = viewportW;
  let h = viewportH;
  for (const { x, y } of positions.values()) {
    w = Math.max(w, x + CARD_W + GAP);
    h = Math.max(h, y + CARD_H + GAP);
  }
  return { width: w, height: h };
}

// undoneCount drives the toolbar badge. An empty card is not a task yet — it
// is the row the user is about to type into — so it does not count, otherwise
// clicking "+" bumps the badge before anything has been written.
export function undoneCount(cards) {
  return cards.filter((c) => !c.done && c.body.trim() !== '').length;
}

// isBoardFull is asked before adding, so the "+" can be disabled with a reason
// instead of the save failing after the fact.
export function isBoardFull(cards) {
  return cards.length >= MAX_STICKIES;
}

// normalizeBoard makes whatever the server returned safe to render. It is not
// paranoia about our own backend: an older stored board (or one hand-edited in
// stickies.json, which is a plain file the owner can open) can be missing
// fields the panel reads, and a card with `body: undefined` throws on .trim().
export function normalizeBoard(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.id === 'string' && c.id !== '')
    .map((c) => ({
      id: c.id,
      body: typeof c.body === 'string' ? c.body : '',
      done: c.done === true,
      color: STICKY_COLORS.includes(c.color) ? c.color : DEFAULT_COLOR,
      // null, not 0, for a card that has never been dragged — the board lays
      // those out on a grid, and coercing them to 0 would stack every one of
      // them in the top-left corner.
      x: coord(c.x),
      y: coord(c.y),
      created_at: Number(c.created_at) || 0,
      updated_at: Number(c.updated_at) || 0,
    }));
}
