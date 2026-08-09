// A task is identified across the UI by its source location, which is unique
// even when two items share the same text. In the global (cross-namespace) view
// two namespaces can share a note path + line, so the namespace is part of the
// key. The backend id is content-derived and can collide, so it is not used.
export function cardKey(t) {
  return `${t.namespace || ''}\u0000${t.path}\u0000${t.line}`;
}
