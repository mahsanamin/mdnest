import { useEffect, useRef, useState } from 'react';
import { HEADING_SELECTOR, headingText, headingUrl, headingWikilink } from '../headingLink.js';
import { copyPlainText } from '../mermaid-text.js';

// Hover a heading in Preview or the Live editor and a link button appears
// after its text: Copy link (opens this note at this heading) or Copy as
// [[wikilink]]. One overlay serves both views. It sits beside the content,
// never inside it, so the Live editor's document is never touched and
// Preview's own heading buttons keep working.
//
// rootRef is the positioned box the overlay is drawn in (.split-view).
const CONTENT = '.preview-pane, .ProseMirror';

function HeadingLinks({ rootRef, ns, path }) {
  const [target, setTarget] = useState(null); // { heading, text, top, left }
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const hideTimer = useRef(null);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !ns || !path) return undefined;
    const cancelHide = () => { clearTimeout(hideTimer.current); };
    const hideSoon = () => {
      cancelHide();
      hideTimer.current = setTimeout(() => { if (!menuOpenRef.current) setTarget(null); }, 250);
    };
    const onOver = (e) => {
      if (e.target.closest?.('.heading-link')) { cancelHide(); return; }
      const h = e.target.closest?.(HEADING_SELECTOR);
      if (!h || !h.closest(CONTENT) || !root.contains(h)) { hideSoon(); return; }
      const text = headingText(h);
      if (!text) return;
      cancelHide();
      // Just after the end of the heading's text, vertically centred on it.
      const range = document.createRange();
      range.selectNodeContents(h);
      const textBox = range.getBoundingClientRect();
      const box = h.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      const left = Math.min(textBox.right - rootBox.left + 6, rootBox.width - 30);
      const top = box.top - rootBox.top + box.height / 2 - 12;
      setTarget((cur) => (cur && cur.heading === h ? cur : { heading: h, text, top, left }));
      setMenuOpen(false);
    };
    // Anything that moves the content moves the heading out from under the
    // button, so a scroll simply hides it until the next hover.
    const onScroll = () => { if (!menuOpenRef.current) setTarget(null); };
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseleave', hideSoon);
    root.addEventListener('scroll', onScroll, true);
    return () => {
      cancelHide();
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseleave', hideSoon);
      root.removeEventListener('scroll', onScroll, true);
    };
  }, [rootRef, ns, path]);

  // A different note, or the heading left the page: start over.
  useEffect(() => { setTarget(null); setMenuOpen(false); }, [ns, path]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => { if (!e.target.closest?.('.heading-link')) { setMenuOpen(false); setTarget(null); } };
    const esc = (e) => { if (e.key === 'Escape') { setMenuOpen(false); setTarget(null); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menuOpen]);

  if (!target || !target.heading.isConnected) return null;
  const base = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  const url = headingUrl(base, ns, path, target.text);
  const wiki = headingWikilink(path, target.text);
  const copy = (what, text) => {
    copyPlainText(text);
    setCopied(what);
    setTimeout(() => { setCopied(''); setMenuOpen(false); setTarget(null); }, 900);
  };

  return (
    <div className="heading-link" style={{ top: target.top, left: target.left }}
      onMouseDown={(e) => e.preventDefault() /* keep the editor's selection */}>
      <button
        className="heading-link-btn"
        title={`Link to "${target.text}"`}
        aria-label={`Link to heading ${target.text}`}
        aria-expanded={menuOpen}
        data-testid="heading-link-btn"
        onClick={() => setMenuOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
          <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
        </svg>
      </button>
      {menuOpen && (
        <div className="heading-link-menu" role="menu" data-testid="heading-link-menu">
          <button role="menuitem" onClick={() => copy('link', url)}>
            {copied === 'link' ? 'Copied' : 'Copy link'}
          </button>
          {wiki && (
            <button role="menuitem" onClick={() => copy('wiki', wiki)} title={wiki}>
              {copied === 'wiki' ? 'Copied' : 'Copy as [[wikilink]]'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default HeadingLinks;
