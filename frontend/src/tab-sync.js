// Cross-tab messaging for same-browser tabs, over the BroadcastChannel API.
//
// Why: in single-user mode there is no live-collab WebSocket, so a change made
// in one tab (create/delete/move a note, or a git-sync) only reaches another
// open tab via the 60s tree poll — the user sees a stale tree until they hit
// Refresh. BroadcastChannel closes that gap instantly for tabs of the SAME
// browser + origin, in every mode (single included), with no backend work. It
// complements — does not replace — the poll (external CLI/git changes) and the
// WebSocket `tree-changed` broadcast (other clients / devices).
//
// Pure module, no React — a thin, best-effort wrapper. If BroadcastChannel is
// unavailable (very old browser) every call is a graceful no-op and the app
// falls back to the existing 60s poll.

const CHANNEL = 'mdnest-tabs';

let channel;
function getChannel() {
  if (channel !== undefined) return channel; // already resolved (object or null)
  if (typeof BroadcastChannel === 'undefined') {
    channel = null;
  } else {
    try {
      channel = new BroadcastChannel(CHANNEL);
    } catch {
      channel = null;
    }
  }
  return channel;
}

// Broadcast a message to every OTHER tab of this browser on the same origin.
// (BroadcastChannel does not echo to the sender, so no self-loop.)
export function broadcastTabMessage(msg) {
  const c = getChannel();
  if (!c) return;
  try {
    c.postMessage(msg);
  } catch {
    /* channel closed / structured-clone failure — ignore, poll still covers it */
  }
}

// Subscribe to messages from other tabs. Returns an unsubscribe function.
export function onTabMessage(handler) {
  const c = getChannel();
  if (!c) return () => {};
  const listener = (e) => {
    if (e && e.data) handler(e.data);
  };
  c.addEventListener('message', listener);
  return () => c.removeEventListener('message', listener);
}
