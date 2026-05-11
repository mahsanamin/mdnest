// looksLikeMarkdown — fast heuristic for "this clipboard payload should be
// parsed as markdown rather than dropped in as plain text." Used by the
// paste handlers in both editors (Basic textarea + Live Milkdown).
//
// The heuristic is intentionally loose: a leading line that starts with
// any markdown structural character (heading hash, list dash/star, blockquote,
// table pipe, fenced-code backtick, link bracket, image bang) is enough to
// route the paste through the markdown parser. False positives are cheap
// (parser handles them fine); the dangerous failure mode is a false
// *negative* — that's what dropped task-list checkboxes in v3.8.0 era
// pastes when both text/plain and text/html were on the clipboard.
//
// Single source of truth, consumed by Editor.jsx and LiveEditor.jsx so the
// two paste paths can't drift again (Editor previously had `!` for image
// detection; LiveEditor didn't — union covers both).
export function looksLikeMarkdown(text) {
  if (!text) return false;
  return /^[\s]*[#\-*>|`\[!]/.test(text);
}
