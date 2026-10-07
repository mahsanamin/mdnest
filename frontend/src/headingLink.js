// Links to one heading of a note: what "Copy link" puts on the clipboard,
// and how an opened link finds its heading again. Pure apart from the DOM
// nodes it is handed; no React.
//
// A heading is matched by its visible text, case-insensitively, the same
// rule [[note#Heading]] wikilinks already use. Preview decorates headings
// with a fold glyph in front and a copy button behind; headingText strips
// both so Preview and the Live editor read the same text.
import { formatRoute } from './hashRoute.js';

export const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

export function headingText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.heading-toggle, .heading-copy, .heading-link').forEach((n) => n.remove());
  return clone.textContent.replace(/^[▸▾]\s*/, '').replace(/\u{1F4CB}$/u, '').replace(/\s+/g, ' ').trim();
}

// The first heading under root whose text matches, or null.
export function findHeading(root, heading) {
  const want = String(heading || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!root || !want) return null;
  for (const h of root.querySelectorAll(HEADING_SELECTOR)) {
    if (headingText(h).toLowerCase() === want) return h;
  }
  return null;
}

// A full URL that opens the note scrolled to the heading.
export function headingUrl(base, ns, path, heading) {
  return base + formatRoute({ ns, path, heading });
}

// [[dir/note#Heading]] for pasting into another note of the same namespace.
// The target drops ".md", like a hand-written wikilink; "]" and "|" would
// end or split the link, so a heading containing them gets no wikilink.
export function headingWikilink(path, heading) {
  if (/[\]|]/.test(heading)) return null;
  return `[[${path.replace(/\.md$/i, '')}#${heading}]]`;
}
