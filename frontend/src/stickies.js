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
      created_at: Number(c.created_at) || 0,
      updated_at: Number(c.updated_at) || 0,
    }));
}
