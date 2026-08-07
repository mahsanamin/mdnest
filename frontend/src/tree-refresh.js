// Sidebar tree auto-refresh policy.
//
// Pure module (no React) so the decision can be unit-tested on its own — it is
// the decision, not the fetching, that went wrong.
//
// The rule that matters: **the live-collab websocket is not an input here.**
// Its `tree-changed` event is emitted by the backend's mutating-HTTP wrapper
// (see the invalidateSearch wrapper in main.go), so it fires only for changes
// that arrived through the API. A write that lands on the filesystem directly
// — git-sync pulling another machine's commits, an editor on the host, a
// restored backup — produces no event at all. The old code treated a connected
// websocket as full coverage and skipped polling entirely, so on exactly the
// installs that have BOTH collab and git-sync, a newly synced file never
// appeared in the tree until the user clicked Refresh.
//
// If you are here to make the poll conditional again: the condition you want is
// almost certainly not "is the websocket up".

// How often a visible session re-reads the tree. Halved from the old 60s
// (which only ran with collab off) because the symptom is measured in seconds
// of staring at a stale sidebar. Not lower: each poll is a full recursive walk
// of the namespace plus, in multi mode, a grants lookup, once per visible
// session.
export const TREE_POLL_MS = 30000;

// Should a tick of the poll actually fetch?
//
// `hidden` is the only reason to skip: a backgrounded tab nobody is looking at
// shouldn't cost a directory walk a minute, and App.jsx refreshes on
// visibilitychange so it catches up the instant it's foregrounded again.
// Extra properties on the argument are ignored by design.
export function shouldPollTree({ authenticated, namespace, hidden } = {}) {
  if (!authenticated) return false;
  if (!namespace) return false;
  if (hidden) return false;
  return true;
}
