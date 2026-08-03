// Echo gate: decides what a tab should do with an incoming `file-changed`
// broadcast, relative to that tab's own saves.
//
// The backend fans `file-changed` out to every connection on a note —
// including the tab that just saved (an HTTP PUT has no *Conn to exclude) —
// and it broadcasts BEFORE it writes the PUT response. So the WebSocket echo
// of our own save usually arrives before the fetch that would tell us the new
// etag has resolved. A suppression scheme that only remembers etags from save
// responses loses that race every time, and the tab pops a conflict banner
// naming its own user (issue #82).
//
// The gate closes the race with two mechanisms:
//   1. A ring of etags this tab's saves produced (`rememberOwnEtag`). Echoes
//      carrying any of them are suppressed, even when a later save already
//      moved the current etag on (HA broadcasts can arrive out of order).
//   2. An in-flight save window (`beginSave`/`endSave`). While one of our
//      PUTs is outstanding, any broadcast we can't yet vouch for is deferred
//      instead of acted on. When the save settles, `endSave` hands the
//      deferred messages back to be re-checked — by then the response has
//      registered its etag, so our own echo is recognized and dropped, while
//      a genuine change by someone else still comes out as 'process'.
//
// Pure module, no React — unit-tested standalone (echo-gate.test.js).

export function createEchoGate({ capacity = 20 } = {}) {
  let inFlight = 0;
  let deferred = [];
  let epoch = 0;
  const ownEtags = [];

  return {
    // Record an etag one of our own saves produced (from the PUT response).
    rememberOwnEtag(etag) {
      if (!etag) return;
      if (ownEtags.includes(etag)) return;
      ownEtags.push(etag);
      if (ownEtags.length > capacity) ownEtags.shift();
    },

    // Mark a save as outstanding. Call right before issuing the PUT.
    // Returns a token to hand back to endSave: it ties the save to the
    // current epoch, so a save that was still settling when the user
    // switched notes (reset() bumps the epoch) can't touch the new
    // note's window when it finally lands.
    beginSave() {
      inFlight++;
      return epoch;
    },

    // Mark a save as settled (success OR failure — call from `finally`
    // with the token beginSave returned). Returns the messages deferred
    // while saves were in flight, but only once the last outstanding save
    // settles; the caller must run each one through its file-changed
    // handler again so `check` gets a second look. A token from a closed
    // epoch is ignored outright — that save's window was already torn
    // down by reset(), and its late settle must neither decrement the new
    // note's in-flight count nor flush the new note's deferred messages.
    endSave(token) {
      if (token !== epoch) return [];
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight > 0) return [];
      const flushed = deferred;
      deferred = [];
      return flushed;
    },

    // Classify an incoming file-changed message.
    //   'suppress' — an echo of our own save; drop it.
    //   'defer'    — can't tell yet (a save is in flight); the message is
    //                queued and will be returned by endSave for re-checking.
    //   'process'  — a genuinely external change; act on it.
    check(msg, currentEtag) {
      if (msg && msg.etag && (msg.etag === currentEtag || ownEtags.includes(msg.etag))) {
        return 'suppress';
      }
      if (inFlight > 0) {
        deferred.push(msg);
        return 'defer';
      }
      return 'process';
    },

    // Tear down the window on file switch: drop deferred messages (they
    // target the previous note), clear the in-flight count (an old note's
    // outstanding save must not defer the new note's broadcasts), and
    // open a new epoch so that stale save's eventual endSave is a no-op.
    reset() {
      epoch++;
      inFlight = 0;
      deferred = [];
    },
  };
}
