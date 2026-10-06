// Attributes that tell grammar-checking browser extensions (Grammarly and the
// tools that copy its convention) not to attach to an editing surface.
//
// On the Live editor such an extension mirrors the text in an overlay to draw
// its underlines. That overlay changed where lines wrapped when a word was
// selected and added empty scroll space under the note until the next click,
// both reported with the extension's badge visible in the screenshots. The
// ProseMirror community recommends exactly these attributes for this. The
// browser's own spell-check is unaffected.
export const NO_GRAMMAR_ASSIST = Object.freeze({
  'data-gramm': 'false',
  'data-gramm_editor': 'false',
  'data-enable-grammarly': 'false',
});

// For an element we do not render with JSX (the Live editor's contenteditable).
export function markNoGrammarAssist(el) {
  if (!el || typeof el.setAttribute !== 'function') return;
  for (const [k, v] of Object.entries(NO_GRAMMAR_ASSIST)) el.setAttribute(k, v);
}
