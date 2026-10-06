// The mdnest:// address of a note, as the CLI and agents take it:
// mdnest://@alias/namespace/path/to/note.md
//
// Each path segment is percent-encoded so a space or other special character
// cannot make the address ambiguous (a raw space in "19 Jun 2026.md" read as
// three tokens to an LLM or a shell). Slashes, the scheme and the alias stay
// readable. Without a server alias the @alias/ part is left out.
export function mdnestUri(alias, ns, path) {
  const at = alias ? `@${alias}/` : '';
  const encPath = String(path).split('/').map(encodeURIComponent).join('/');
  return `mdnest://${at}${encodeURIComponent(ns)}/${encPath}`;
}
