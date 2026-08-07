// Getting the words back out of a rendered mermaid diagram.
//
// A diagram's labels are the part people actually want to reuse — node names,
// step descriptions, actor names — but by the time mermaid has drawn it they are
// scattered across SVG <text> nodes and <foreignObject> islands, laid out for
// the eye rather than for a selection gesture. Dragging across a diagram
// selects erratically or not at all, so "copy the text" needs to be a button,
// the same way code blocks and headings already have one.
//
// Pure module (no React, no DOM creation) so the extraction is unit-testable.

// Pulls the diagram's text out of a rendered SVG in document order, one label
// per line.
export function extractDiagramText(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return '';

  const lines = [];
  const push = (raw) => {
    // Mermaid wraps and pads label text for layout; collapse it back to a
    // single line so what lands on the clipboard is what the box reads as.
    const text = (raw || '').replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
  };

  // Two kinds of text to collect: <foreignObject> holds the HTML mermaid uses
  // for flowchart and edge labels, while <text> covers everything drawn as
  // native SVG text (sequence messages, actors, axis and gantt labels). A
  // <text> nested inside a foreignObject would be counted twice, so skip it.
  root.querySelectorAll('foreignObject, text').forEach((node) => {
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'text' && typeof node.closest === 'function' && node.closest('foreignObject')) return;
    push(node.textContent);
  });

  // Mermaid emits some labels twice — a visible copy plus a hidden one used to
  // measure width — which shows up as an immediate repeat.
  return lines.filter((line, i) => line !== lines[i - 1]).join('\n');
}

// Puts text on the clipboard. Uses the hidden-textarea + execCommand route
// rather than navigator.clipboard because mdnest is commonly reached over plain
// HTTP on a LAN address, where the async Clipboard API is unavailable — the
// same reason the code-block copy button does it this way.
export function copyPlainText(text) {
  if (!text) return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
