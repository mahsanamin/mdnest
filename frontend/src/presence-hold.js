// Presence with a grace period.
//
// Live-collab presence arrives as snapshots plus explicit leave messages, and
// both were applied to the UI the instant they landed. A brief gap — a
// reconnect, a snapshot that races a join, a note switch that rejoins the room
// — therefore showed up as a collaborator vanishing and immediately returning.
// With the presence bar in the document flow, each of those blips also shoved
// the editor up and down.
//
// This holds a departure for `graceMs` before believing it, and cancels the
// hold outright if the person reappears in that window. Someone who has really
// gone still disappears, just a few seconds later — which is the right trade:
// presence is ambient information, and being briefly wrong about a leaver is
// much cheaper than flickering at everyone.
//
// Pure and time-injectable so the behaviour can be tested without timers.
export function createPresenceHold({ graceMs = 6000, now = () => Date.now() } = {}) {
  // id -> user, for people the server currently reports.
  let present = new Map();
  // id -> { user, since }, for people we are not yet willing to call gone.
  let leaving = new Map();

  const idOf = (u) => (u && u.id !== undefined ? u.id : u);

  // setAll applies a presence snapshot. Anyone missing from it starts their
  // grace period rather than disappearing; anyone in it has any pending
  // departure cancelled.
  function setAll(users) {
    const next = new Map();
    for (const u of users || []) next.set(idOf(u), u);
    for (const [id] of next) leaving.delete(id);
    for (const [id, u] of present) {
      if (!next.has(id) && !leaving.has(id)) leaving.set(id, { user: u, since: now() });
    }
    present = next;
  }

  // remove applies an explicit leave. Same grace treatment: a leave that is
  // immediately followed by a rejoin should never reach the screen.
  function remove(id) {
    const u = present.get(id);
    present.delete(id);
    if (u && !leaving.has(id)) leaving.set(id, { user: u, since: now() });
  }

  // visible is what the UI should draw: everyone present, plus everyone whose
  // grace period is still running. Expired holds are dropped as a side effect,
  // so callers do not need to prune.
  function visible() {
    const t = now();
    const out = [...present.values()];
    for (const [id, entry] of [...leaving]) {
      if (t - entry.since >= graceMs) leaving.delete(id);
      else if (!present.has(id)) out.push(entry.user);
    }
    return out;
  }

  // msUntilNextChange tells the caller when visible() would next differ, so it
  // can schedule exactly one timer instead of polling. null means nothing is
  // pending.
  function msUntilNextChange() {
    if (leaving.size === 0) return null;
    const t = now();
    let soonest = Infinity;
    for (const { since } of leaving.values()) soonest = Math.min(soonest, graceMs - (t - since));
    return soonest === Infinity ? null : Math.max(0, soonest);
  }

  function reset() {
    present = new Map();
    leaving = new Map();
  }

  return { setAll, remove, visible, msUntilNextChange, reset };
}
