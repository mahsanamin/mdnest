// Board rules that a rendering test would not reach.
//
// Every one of these is a behaviour someone would notice immediately if it
// broke, and none of them is visible from the component: the panel just maps
// over whatever array it is handed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  STICKY_COLORS,
  DEFAULT_COLOR,
  MAX_STICKIES,
  newSticky,
  addSticky,
  editSticky,
  removeSticky,
  undoneCount,
  isBoardFull,
  normalizeBoard,
} from '../stickies.js';

const card = (over = {}) => ({ ...newSticky(), ...over });

describe('newSticky', () => {
  it('starts empty, undone, and in the default colour', () => {
    const c = newSticky();
    expect(c.body).toBe('');
    expect(c.done).toBe(false);
    expect(c.color).toBe(DEFAULT_COLOR);
  });

  it('refuses a colour the server would reject', () => {
    // The panel only ever passes a value from STICKY_COLORS, but a bad colour
    // here would fail the PUT — i.e. the board would stop saving entirely
    // because of one card. Falling back is the recoverable behaviour.
    expect(newSticky('rainbow').color).toBe(DEFAULT_COLOR);
  });

  it('gives every card a distinct id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSticky().id));
    expect(ids.size).toBe(200);
  });
});

describe('addSticky', () => {
  it('puts the new card on top', () => {
    const a = card({ id: 'a' });
    const b = card({ id: 'b' });
    expect(addSticky([a], b).map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the array it was given', () => {
    // The debounced save reads the latest array by reference. A mutation in
    // place would let the timer send a board the component has already moved
    // on from — and, worse, would not re-render.
    const before = [card({ id: 'a' })];
    addSticky(before, card({ id: 'b' }));
    expect(before).toHaveLength(1);
  });
});

describe('editSticky', () => {
  it('changes only the targeted card', () => {
    const cards = [card({ id: 'a', body: 'one' }), card({ id: 'b', body: 'two' })];
    const out = editSticky(cards, 'b', { body: 'changed' });
    expect(out[0].body).toBe('one');
    expect(out[1].body).toBe('changed');
  });

  it('keeps the card in place', () => {
    // Sorting by updated_at would move the card out from under the cursor
    // mid-sentence — the edit is a keystroke, not a reordering event.
    const cards = [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c' })];
    expect(editSticky(cards, 'b', { done: true }).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('stamps updated_at', () => {
    const cards = [card({ id: 'a', updated_at: 1 })];
    expect(editSticky(cards, 'a', { body: 'x' }, 5_000_000)[0].updated_at).toBe(5000);
  });

  it('is a no-op for an id that is not on the board', () => {
    const cards = [card({ id: 'a', body: 'one' })];
    expect(editSticky(cards, 'gone', { body: 'x' })).toEqual(cards);
  });
});

describe('removeSticky', () => {
  it('removes exactly one card', () => {
    const cards = [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c' })];
    expect(removeSticky(cards, 'b').map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('undoneCount', () => {
  it('ignores done cards', () => {
    expect(undoneCount([card({ done: true }), card({ body: 'x' })])).toBe(1);
  });

  it('ignores a card that is still empty', () => {
    // Clicking "+" creates an empty card. Counting it would bump the toolbar
    // badge before the user has written anything — the badge would say there
    // is a task when there is only a blank box.
    expect(undoneCount([card({ body: '' }), card({ body: '   ' })])).toBe(0);
  });
});

describe('isBoardFull', () => {
  it('stops at the server limit rather than after a failed save', () => {
    expect(isBoardFull(Array.from({ length: MAX_STICKIES - 1 }, () => card()))).toBe(false);
    expect(isBoardFull(Array.from({ length: MAX_STICKIES }, () => card()))).toBe(true);
  });
});

describe('normalizeBoard', () => {
  it('fills in missing fields so the panel cannot throw', () => {
    // stickies.json is a plain file in the secrets volume — the owner of the
    // box can and will open it. A card missing `body` would crash the panel
    // on .trim(), taking the whole app down with it.
    const [c] = normalizeBoard([{ id: 'a' }]);
    expect(c).toEqual({
      id: 'a', body: '', done: false, color: DEFAULT_COLOR, created_at: 0, updated_at: 0,
    });
  });

  it('drops entries with no usable id', () => {
    expect(normalizeBoard([{ id: '' }, { body: 'x' }, null, { id: 'ok' }])).toHaveLength(1);
  });

  it('replaces an unknown colour instead of dropping the card', () => {
    // The card is the user's content; the colour is decoration. Losing a note
    // because its colour is unrecognised would be the wrong trade.
    expect(normalizeBoard([{ id: 'a', body: 'keep', color: 'rainbow' }])[0])
      .toMatchObject({ body: 'keep', color: DEFAULT_COLOR });
  });

  it('survives a response that is not an array', () => {
    expect(normalizeBoard(null)).toEqual([]);
    expect(normalizeBoard({ stickies: [] })).toEqual([]);
  });

  it('coerces done to a real boolean', () => {
    expect(normalizeBoard([{ id: 'a', done: 'true' }])[0].done).toBe(false);
    expect(normalizeBoard([{ id: 'b', done: true }])[0].done).toBe(true);
  });
});

// The palette exists in three places — this module, store.StickyColors in Go,
// and one CSS rule per colour. A colour added to only one of them fails at PUT
// time with a 400 on the WHOLE board, so one unrecognised colour stops every
// sticky from saving. Read the other two rather than restating them.
describe('the palette agrees across the stack', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('matches store.StickyColors in the Go backend', () => {
    const go = readFileSync(join(root, '..', '..', 'backend', 'store', 'stickies.go'), 'utf-8');
    const block = go.match(/var StickyColors = map\[string\]bool\{([\s\S]*?)\}/);
    expect(block, 'StickyColors was renamed or restructured').not.toBeNull();
    const server = [...block[1].matchAll(/"(\w+)":\s*true/g)].map((m) => m[1]).sort();
    expect([...STICKY_COLORS].sort()).toEqual(server);
  });

  it('has a fill rule for every colour', () => {
    const css = readFileSync(join(root, 'App.css'), 'utf-8');
    for (const c of STICKY_COLORS) {
      expect(css, `.sticky-${c} paints nothing`)
        .toMatch(new RegExp(`\\.sticky-${c}\\s*\\{[^}]*background:\\s*var\\(--sticky-${c}\\)`));
    }
  });
});
