// Regression tests for the file-changed echo gate (issue #82).
//
// The backend broadcasts file-changed BEFORE it writes the PUT response, so
// the WebSocket echo of a tab's own save usually arrives before the response
// that carries the new etag. The old suppression (remember etags from save
// responses only) lost that race on every autosave, flashing a conflict
// banner that named the user themselves. The gate defers unrecognizable
// broadcasts while a save is in flight and re-checks them once it settles.

import { describe, it, expect } from 'vitest';
import { createEchoGate } from '../echo-gate.js';

const E1 = '"etag-one"';
const E2 = '"etag-two"';
const E3 = '"etag-three"';

describe('createEchoGate', () => {
  it('suppresses an echo matching the current etag', () => {
    const gate = createEchoGate();
    expect(gate.check({ etag: E1 }, E1)).toBe('suppress');
  });

  it('suppresses a late echo of an earlier own save (post-response ordering)', () => {
    const gate = createEchoGate();
    gate.rememberOwnEtag(E1);
    // etagRef has already moved on to E2, the E1 echo arrives late.
    expect(gate.check({ etag: E1 }, E2)).toBe('suppress');
  });

  it('processes a genuinely external change when no save is in flight', () => {
    const gate = createEchoGate();
    expect(gate.check({ etag: E2 }, E1)).toBe('process');
  });

  it('issue #82: own echo that beats the PUT response is deferred, then suppressed', () => {
    const gate = createEchoGate();
    // Autosave PUTs with etag E1; backend broadcasts the new etag E2 before
    // the response arrives.
    const token = gate.beginSave();
    const echo = { etag: E2, username: 'kangy' };
    expect(gate.check(echo, E1)).toBe('defer'); // old code said 'process' → self-banner
    // PUT response resolves and registers the etag it produced.
    gate.rememberOwnEtag(E2);
    const flushed = gate.endSave(token);
    expect(flushed).toEqual([echo]);
    // The replay now recognizes the echo as our own.
    expect(gate.check(flushed[0], E2)).toBe('suppress');
  });

  it('a real remote change during our save still lands after the save settles', () => {
    const gate = createEchoGate();
    const token = gate.beginSave();
    const remote = { etag: E3, username: 'alice' };
    expect(gate.check(remote, E1)).toBe('defer');
    gate.rememberOwnEtag(E2); // our save produced E2, not E3
    const flushed = gate.endSave(token);
    expect(flushed).toEqual([remote]);
    expect(gate.check(flushed[0], E2)).toBe('process');
  });

  it('holds deferred messages until the LAST overlapping save settles', () => {
    const gate = createEchoGate();
    const t1 = gate.beginSave();
    const t2 = gate.beginSave();
    gate.check({ etag: E2 }, E1);
    expect(gate.endSave(t1)).toEqual([]); // one save still outstanding
    gate.rememberOwnEtag(E2);
    expect(gate.endSave(t2)).toEqual([{ etag: E2 }]);
  });

  it('repeated autosaves never surface their own echoes', () => {
    const gate = createEchoGate();
    let current = E1;
    for (const next of [E2, E3]) {
      const token = gate.beginSave();
      const echo = { etag: next };
      expect(gate.check(echo, current)).toBe('defer');
      gate.rememberOwnEtag(next);
      current = next;
      for (const m of gate.endSave(token)) {
        expect(gate.check(m, current)).toBe('suppress');
      }
    }
  });

  it('reset drops deferred messages (file switch)', () => {
    const gate = createEchoGate();
    const token = gate.beginSave();
    gate.check({ etag: E2 }, E1);
    gate.reset();
    expect(gate.endSave(token)).toEqual([]);
  });

  it('reset clears the in-flight window — a stale save must not defer the new note', () => {
    const gate = createEchoGate();
    gate.beginSave(); // note A's autosave, never settles before the switch
    gate.reset(); // user switches to note B
    // A genuine broadcast for note B must be processed immediately, not
    // deferred behind note A's abandoned save.
    expect(gate.check({ etag: E2 }, E1)).toBe('process');
  });

  it("a stale save settling after reset can't decrement or flush the new note's window", () => {
    const gate = createEchoGate();
    const staleToken = gate.beginSave(); // note A's save, still in flight...
    gate.reset(); // ...when the user switches to note B
    const freshToken = gate.beginSave(); // note B's own autosave
    const echo = { etag: E2 };
    expect(gate.check(echo, E1)).toBe('defer'); // held by B's window
    // Note A's save finally settles: its epoch is closed, so it must not
    // flush B's deferred echo early (that would re-open the #82 race).
    expect(gate.endSave(staleToken)).toEqual([]);
    expect(gate.check({ etag: E3 }, E1)).toBe('defer'); // window still armed
    gate.rememberOwnEtag(E2);
    const flushed = gate.endSave(freshToken);
    expect(flushed).toEqual([echo, { etag: E3 }]);
    expect(gate.check(flushed[0], E2)).toBe('suppress');
  });

  it('endSave never goes negative and keeps flushing when unbalanced', () => {
    const gate = createEchoGate();
    gate.endSave(0); // extra endSave must not wedge the counter below zero
    const token = gate.beginSave();
    gate.check({ etag: E2 }, E1);
    expect(gate.endSave(token)).toEqual([{ etag: E2 }]);
  });

  it('the own-etag ring is bounded and evicts oldest first', () => {
    const gate = createEchoGate({ capacity: 2 });
    gate.rememberOwnEtag(E1);
    gate.rememberOwnEtag(E2);
    gate.rememberOwnEtag(E3); // evicts E1
    expect(gate.check({ etag: E1 }, E3)).toBe('process'); // evicted from the ring
    expect(gate.check({ etag: E2 }, E3)).toBe('suppress'); // still in the ring
  });

  it('a message without an etag is processed, not suppressed', () => {
    const gate = createEchoGate();
    expect(gate.check({ username: 'alice' }, E1)).toBe('process');
  });
});
