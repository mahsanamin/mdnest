// Marp detection — a note is a slide deck when its leading YAML frontmatter
// declares `marp: true` (the standard Marp marker). Shared by App.jsx (to pick
// the deck view) so the heuristic lives in one place.

// isMarpDoc reports whether the markdown opens with a `---` frontmatter block
// that contains a `marp: true` line.
export function isMarpDoc(content) {
  if (typeof content !== 'string') return false;
  // Leading frontmatter: optional BOM, `---`, body, closing `---` on its own line.
  const m = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) return false;
  return /^[ \t]*marp[ \t]*:[ \t]*true[ \t]*$/im.test(m[1]);
}
