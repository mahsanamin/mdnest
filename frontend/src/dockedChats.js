// The chat pinned in the side panel, one per workspace. Chat follows the
// workspace picked in the main dropdown: switching workspace shows that
// workspace's pinned chat (or its chat list), and switching back brings the
// earlier one back. Stored as { [ns]: { ns, path } } under mdnest_docked_chat.

const isChat = (v) => !!v && typeof v.ns === 'string' && typeof v.path === 'string';

// parseDockedChats reads the stored value. The value from before this change
// was a single { ns, path }, which becomes that workspace's entry.
export function parseDockedChats(raw) {
  let v;
  try { v = JSON.parse(raw || 'null'); } catch { return {}; }
  if (!v || typeof v !== 'object') return {};
  if (isChat(v)) return { [v.ns]: { ns: v.ns, path: v.path } };
  const out = {};
  for (const [ns, c] of Object.entries(v)) {
    if (isChat(c) && c.ns === ns) out[ns] = { ns: c.ns, path: c.path };
  }
  return out;
}

// serializeDockedChats returns the stored string, or null when nothing is pinned.
export function serializeDockedChats(map) {
  return map && Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

// withDockedChat pins chat in workspace ns (null clears that workspace).
export function withDockedChat(map, ns, chat) {
  const next = { ...(map || {}) };
  if (isChat(chat)) next[chat.ns] = { ns: chat.ns, path: chat.path };
  else if (ns) delete next[ns];
  return next;
}

// withoutChat drops every pin of the chat at ns/path (it was deleted).
export function withoutChat(map, ns, path) {
  const cur = map?.[ns];
  if (!cur || cur.path !== path) return map;
  const next = { ...map };
  delete next[ns];
  return next;
}
