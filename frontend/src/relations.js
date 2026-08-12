// Shared helpers for task relations (depends-on / blocked-by / related-to).
// Relations reference other tasks by their stable ref (comma-free, rename-proof),
// so both the board (resolve a ref to a live task for display/blocked state) and
// the editor (resolve an entered title/ref to a ref, and back to a title for the
// chip) need the same lookup. Matching is case-insensitive; a title fallback
// keeps notes written before relations moved to refs working.

// buildRelationLookup indexes entries by ref and by title. Each entry is
// { ref?, title?, task? }; pass the task when a resolved relation should yield
// the live task object (board), omit it when only ref/title mapping is needed
// (editor).
export function buildRelationLookup(entries) {
  const refToTitle = new Map(); // refLC   -> original title
  const refCanon = new Map();   // refLC   -> original-case ref
  const refToTask = new Map();  // refLC   -> task
  const titleToRef = new Map(); // titleLC -> ref
  const titleToTask = new Map(); // titleLC -> task
  const optionSet = new Set();  // every known refLC + titleLC (datalist-pick detection)
  for (const e of entries || []) {
    const ref = e && e.ref != null ? String(e.ref).trim() : '';
    const title = e && e.title != null ? String(e.title) : '';
    const rl = ref.toLowerCase();
    const tl = title.trim().toLowerCase();
    if (rl) {
      if (!refToTitle.has(rl)) refToTitle.set(rl, title);
      if (!refCanon.has(rl)) refCanon.set(rl, ref);
      if (e.task && !refToTask.has(rl)) refToTask.set(rl, e.task);
      optionSet.add(rl);
    }
    if (tl) {
      if (ref && !titleToRef.has(tl)) titleToRef.set(tl, ref);
      if (e.task && !titleToTask.has(tl)) titleToTask.set(tl, e.task);
      optionSet.add(tl);
    }
  }
  return { refToTitle, refCanon, refToTask, titleToRef, titleToTask, optionSet };
}

// resolveTask returns the live task a relation value points at: ref first, then
// title as a fallback. Null when nothing matches in the loaded set.
export function resolveTask(lookup, value) {
  const k = String(value || '').trim().toLowerCase();
  return lookup.refToTask.get(k) || lookup.titleToTask.get(k) || null;
}

// toRef maps an entered title or ref to the canonical ref for storage; unmatched
// free text is returned trimmed as-is.
export function toRef(lookup, value) {
  const k = String(value || '').trim().toLowerCase();
  return lookup.refCanon.get(k) || lookup.titleToRef.get(k) || String(value || '').trim();
}

// relLabel returns the human title for a stored relation value (ref -> title),
// falling back to the value itself for unresolved refs/legacy titles.
export function relLabel(lookup, value) {
  const k = String(value || '').trim().toLowerCase();
  return lookup.refToTitle.get(k) || value;
}

// isKnownOption reports whether a typed value exactly matches a known task title
// or ref, so a datalist selection can be auto-committed.
export function isKnownOption(lookup, value) {
  return lookup.optionSet.has(String(value || '').trim().toLowerCase());
}
