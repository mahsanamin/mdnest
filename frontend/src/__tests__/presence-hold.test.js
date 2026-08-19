// Presence must not flicker.
//
// Snapshots and leave messages were applied instantly, so any momentary gap —
// a reconnect, a snapshot racing a join — showed a collaborator vanishing and
// returning. These pin the grace period, and in particular that a reappearance
// inside the window cancels the departure outright rather than merely delaying
// it.
import { describe, it, expect } from 'vitest';
import { createPresenceHold } from '../presence-hold.js';

const A = { id: 1, username: 'ana' };
const B = { id: 2, username: 'bo' };

function at(t) { return { now: () => t.value, graceMs: 5000 }; }

describe('createPresenceHold', () => {
  it('shows whoever the server reports', () => {
    const t = { value: 0 };
    const p = createPresenceHold(at(t));
    p.setAll([A, B]);
    expect(p.visible().map((u) => u.id).sort()).toEqual([1, 2]);
  });

  it('keeps someone visible during the grace period after they vanish', () => {
    const t = { value: 0 };
    const p = createPresenceHold(at(t));
    p.setAll([A, B]);
    t.value = 1000;
    p.setAll([A]);                       // B missing from the snapshot
    expect(p.visible().map((u) => u.id).sort()).toEqual([1, 2]);
    t.value = 4000;
    expect(p.visible().map((u) => u.id).sort()).toEqual([1, 2]);
    t.value = 6001;                      // grace elapsed
    expect(p.visible().map((u) => u.id)).toEqual([1]);
  });

  it('cancels the departure when they come back in time — the flicker case', () => {
    const t = { value: 0 };
    const p = createPresenceHold(at(t));
    p.setAll([A, B]);
    t.value = 500;
    p.setAll([A]);                       // blip
    t.value = 900;
    p.setAll([A, B]);                    // back again
    t.value = 60_000;                    // long past the grace window
    expect(p.visible().map((u) => u.id).sort(), 'B should never have been dropped').toEqual([1, 2]);
  });

  it('holds an explicit leave too, and still lets a real leave through', () => {
    const t = { value: 0 };
    const p = createPresenceHold(at(t));
    p.setAll([A, B]);
    p.remove(2);
    expect(p.visible().map((u) => u.id).sort()).toEqual([1, 2]);
    t.value = 5001;
    expect(p.visible().map((u) => u.id)).toEqual([1]);
  });

  it('a rejoin after an explicit leave cancels the hold', () => {
    const t = { value: 0 };
    const p = createPresenceHold(at(t));
    p.setAll([A, B]);
    p.remove(2);
    t.value = 200;
    p.setAll([A, B]);
    t.value = 10_000;
    expect(p.visible().map((u) => u.id).sort()).toEqual([1, 2]);
  });

  it('reports when the view would next change, so the caller sets one timer', () => {
    const t = { value: 0 };
    const p = createPresenceHold(at(t));
    expect(p.msUntilNextChange()).toBeNull();
    p.setAll([A, B]);
    expect(p.msUntilNextChange()).toBeNull();
    p.remove(2);
    expect(p.msUntilNextChange()).toBe(5000);
    t.value = 2000;
    expect(p.msUntilNextChange()).toBe(3000);
    t.value = 9999;
    p.visible();
    expect(p.msUntilNextChange()).toBeNull();
  });

  it('reset clears everything (note switch / disconnect)', () => {
    const t = { value: 0 };
    const p = createPresenceHold(at(t));
    p.setAll([A, B]);
    p.reset();
    expect(p.visible()).toEqual([]);
  });
});
