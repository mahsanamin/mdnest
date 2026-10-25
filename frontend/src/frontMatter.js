// Front matter split and join, with no dependencies: the Live editor and the
// shared editing chunk both use it.
//
// Front matter is kept out of the shared editor. The Live editor does not
// understand YAML front matter: on save it turns the `---` fences into `***`
// and a setext heading, which breaks the note for every tool that reads it.
// So the block is split off before the text goes into the editor, kept as its
// own value in the shared document, and put back in front on every save.
//
// The split keeps the blank lines after the closing fence with the front
// matter, so "front matter + serialized body" gives back the same separation
// the file had.

const FM_OPEN = /^---[ \t]*\r?\n/;
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(text) {
  const s = typeof text === 'string' ? text : '';
  const open = s.match(FM_OPEN);
  if (!open) return { frontMatter: '', body: s };
  let pos = open[0].length;
  while (pos <= s.length) {
    const rest = s.slice(pos);
    const close = rest.match(FM_CLOSE);
    if (close) {
      let end = pos + close[0].length;
      // Blank lines after the fence belong to the separation.
      const blanks = s.slice(end).match(/^(?:[ \t]*\r?\n)*/);
      if (blanks) end += blanks[0].length;
      return { frontMatter: s.slice(0, end), body: s.slice(end) };
    }
    const nl = s.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  // An opening fence with no close is not front matter.
  return { frontMatter: '', body: s };
}

export function joinFrontMatter(frontMatter, body) {
  if (!frontMatter) return body || '';
  // A close fence at the very end of the file has no newline after it.
  const fm = /\n$/.test(frontMatter) ? frontMatter : frontMatter + '\n';
  return fm + (body || '');
}

