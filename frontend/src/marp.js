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

// effectiveEditorMode forces the plain-text (Basic) editor for Marp decks. The
// Live/WYSIWYG editor round-trips markdown through its document model and
// re-serializes it on every change, which rewrites Marp frontmatter (`---` →
// `***`), escapes characters, and mangles slide separators — silently breaking
// the deck on autosave. Marp notes are therefore always edited as raw text
// (with the live slide preview alongside), never through the WYSIWYG editor.
export function effectiveEditorMode(mode, marpActive) {
  return marpActive ? 'basic' : mode;
}

// slideStarts returns, from Marp source, the 0-based source line at which each
// slide begins, plus the total line count. It powers scroll-sync between the
// editor and the (paginated) deck: mapping an even scrollPct → slide breaks the
// moment content isn't evenly distributed — a large YAML frontmatter with a
// `style:` block, or one long slide, throws the mapping off. Anchoring to where
// slides *actually* begin fixes that:
//   - the leading YAML frontmatter (--- … ---) is skipped, so the real first
//     slide starts after it;
//   - each standalone `---` marks the next slide, but only when preceded by a
//     blank line (so a setext H2 underline — text directly above `---` — isn't
//     mistaken for a page break) and outside fenced code blocks.
// This mirrors Marpit's page splitting closely enough to keep the deck honest.
export function slideStarts(content) {
  const lines = (typeof content === 'string' ? content : '').split('\n');
  const n = lines.length;
  let i = 0;
  if (n > 0 && /^---\s*$/.test(lines[0])) {
    let j = 1;
    while (j < n && !/^---\s*$/.test(lines[j])) j++;
    i = Math.min(j + 1, n); // first line after the closing frontmatter ---
  }
  const starts = [i];
  let inFence = false;
  let prevBlank = true; // the first content line behaves as if preceded by a blank
  for (let k = i; k < n; k++) {
    const line = lines[k];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; prevBlank = false; continue; }
    if (!inFence && prevBlank && /^---\s*$/.test(line)) {
      starts.push(k + 1); // the next slide begins on the line after the separator
    }
    prevBlank = line.trim() === '';
  }
  return { starts, totalLines: n };
}
