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
    gate.beginSave();
    const echo = { etag: E2, username: 'kangy' };
    expect(gate.check(echo, E1)).toBe('defer'); // old code said 'process' → self-banner
    // PUT response resolves and registers the etag it produced.
    gate.rememberOwnEtag(E2);
    const flushed = gate.endSave();
    expect(flushed).toEqual([echo]);
    // The replay now recognizes the echo as our own.
    expect(gate.check(flushed[0], E2)).toBe('suppress');
  });

  it('a real remote change during our save still lands after the save settles', () => {
    const gate = createEchoGate();
    gate.beginSave();
    const remote = { etag: E3, username: 'alice' };
    expect(gate.check(remote, E1)).toBe('defer');
    gate.rememberOwnEtag(E2); // our save produced E2, not E3
    const flushed = gate.endSave();
    expect(flushed).toEqual([remote]);
    expect(gate.check(flushed[0], E2)).toBe('process');
  });

  it('holds deferred messages until the LAST overlapping save settles', () => {
    const gate = createEchoGate();
    gate.beginSave();
    gate.beginSave();
    gate.check({ etag: E2 }, E1);
    expect(gate.endSave()).toEqual([]); // one save still outstanding
    gate.rememberOwnEtag(E2);
    expect(gate.endSave()).toEqual([{ etag: E2 }]);
  });

  it('repeated autosaves never surface their own echoes', () => {
    const gate = createEchoGate();
    let current = E1;
    for (const next of [E2, E3]) {
      gate.beginSave();
      const echo = { etag: next };
      expect(gate.check(echo, current)).toBe('defer');
      gate.rememberOwnEtag(next);
      current = next;
      for (const m of gate.endSave()) {
        expect(gate.check(m, current)).toBe('suppress');
      }
    }
  });

  it('reset drops deferred messages (file switch)', () => {
    const gate = createEchoGate();
    gate.beginSave();
    gate.check({ etag: E2 }, E1);
    gate.reset();
    expect(gate.endSave()).toEqual([]);
  });

  it('endSave never goes negative and keeps flushing when unbalanced', () => {
    const gate = createEchoGate();
    gate.endSave(); // extra endSave must not wedge the counter below zero
    gate.beginSave();
    gate.check({ etag: E2 }, E1);
    expect(gate.endSave()).toEqual([{ etag: E2 }]);
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
