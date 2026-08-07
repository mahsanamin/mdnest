import { describe, it, expect } from 'vitest';
import { TREE_POLL_MS, shouldPollTree } from '../tree-refresh.js';

describe('tree auto-refresh policy', () => {
  it('polls a visible, authenticated session with a namespace open', () => {
    expect(shouldPollTree({ authenticated: true, namespace: 'brain', hidden: false })).toBe(true);
  });

  it('skips a backgrounded tab', () => {
    expect(shouldPollTree({ authenticated: true, namespace: 'brain', hidden: true })).toBe(false);
  });

  it('skips before login and before a namespace is chosen', () => {
    expect(shouldPollTree({ authenticated: false, namespace: 'brain', hidden: false })).toBe(false);
    expect(shouldPollTree({ authenticated: true, namespace: '', hidden: false })).toBe(false);
    expect(shouldPollTree()).toBe(false);
  });

  // The regression this module exists for. `tree-changed` only fires for writes
  // that went through the API, so a connected websocket is NOT proof the tree is
  // current — git-sync pulling another machine's commits produces no event.
  // Skipping the poll because collab is up is what left the sidebar stale until
  // the user clicked Refresh.
  it('ignores live-collab state entirely', () => {
    const base = { authenticated: true, namespace: 'brain', hidden: false };
    expect(shouldPollTree({ ...base, liveCollab: true })).toBe(true);
    expect(shouldPollTree({ ...base, liveCollab: false })).toBe(true);
    expect(shouldPollTree({ ...base, wsStatus: 'connected' })).toBe(true);
  });

  // Pins the cadence: the whole point is that an out-of-band write shows up
  // without the user doing anything, so this must stay comfortably sub-minute.
  it('polls at least twice a minute', () => {
    expect(TREE_POLL_MS).toBeLessThanOrEqual(30000);
    expect(TREE_POLL_MS).toBeGreaterThanOrEqual(10000);
  });
});
