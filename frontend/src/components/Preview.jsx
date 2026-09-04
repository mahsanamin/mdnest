import { Component, useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { Marked } from 'marked';
import mermaid, { fixMermaidTextColors, applyMermaidTheme } from '../mermaid-config.js';
import { useTheme } from '../useTheme.js';
import MermaidViewer from './MermaidViewer.jsx';
import { resolveWikiLink, wikiLinkExtension, internalMdLinkHtml } from '../wikilink.js';
import { sanitizeHtml, sanitizeSvg } from '../sanitize.js';
import { extractDiagramText, copyPlainText } from '../mermaid-text.js';
import { isExcalidrawDoc, noteRelativePath } from '../excalidraw.js';
import { getNote, getToken } from '../api.js';
import { resolveImgSrc } from '../img-src.js';


// Safety net for any render-time exception inside Preview (mostly marked, but
// also mermaid rendering, task-checkbox DOM work, etc.). Without this, a
// thrown error propagates up the tree and unmounts the whole app until reload.
class PreviewErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('Preview crashed:', error, info);
  }
  componentDidUpdate(prevProps) {
    // Reset the boundary when the user navigates to a different note so a
    // bad file doesn't permanently black out the preview pane.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error.message || String(this.state.error);
      return (
        <div className="preview-pane-wrapper">
          <div className="preview-pane">
            <div className="preview-render-error">
              <strong>Preview crashed.</strong>
              <p>{msg}</p>
              <p className="preview-render-error-hint">
                Switch to <em>Editor</em> view above to keep working, or pick another file.
              </p>
              <button
                className="preview-export-btn"
                onClick={() => this.setState({ error: null })}
                style={{ marginTop: 8 }}
              >Try again</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function getBaseDir(ns, notePath) {
  const nsPrefix = ns ? encodeURIComponent(ns) + '/' : '';
  if (!notePath) return `/api/files/${nsPrefix}`;
  const parts = notePath.split('/');
  parts.pop();
  const dir = parts.length > 0 ? parts.join('/') + '/' : '';
  return `/api/files/${nsPrefix}${dir}`;
}

function renderMarkdown(source, ns, notePath, pathIndex) {
  try {
    // Note bodies are user-controlled and shared between users; scrub the
    // rendered HTML (raw-HTML passthrough, javascript: hrefs, on* handlers)
    // before it is injected via innerHTML below.
    return sanitizeHtml(renderMarkdownUnsafe(source, ns, notePath, pathIndex));
  } catch (err) {
    // Never let a malformed note take the whole app down. Log for devs,
    // show a readable placeholder so the user can switch modes or edit.
    console.error('Preview render failed:', err);
    const msg = err && err.message ? err.message : String(err);
    const safe = msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="preview-render-error">
      <strong>Preview could not render this file.</strong>
      <p>${safe}</p>
      <p class="preview-render-error-hint">Switch to <em>Editor</em> view to see the raw markdown, or report this file.</p>
    </div>`;
  }
}

function renderMarkdownUnsafe(source, ns, notePath, pathIndex) {
  const baseDir = getBaseDir(ns, notePath);

  // marked v15 notes:
  //  - The Renderer class is gone / works differently. Use a plain object.
  //  - Passing `renderer: {...}` as a per-call option REPLACES the entire
  //    renderer with no fallback — any token type whose method you don't
  //    supply (heading, paragraph, table, blockquote, …) blows up at render
  //    time with "this.renderer.X is not a function".
  //  - new Marked().use({ renderer: {...} }) MERGES your partial renderer
  //    with the built-in defaults, which is what we want.
  // We also do NOT override `listitem`. Marked v15 already renders GFM task
  // lists as <li><input type="checkbox" disabled>. The old override called
  // parseInline on block-level token.tokens and blew up whenever a task
  // item contained a nested list ("Token with 'list' type was not found").
  // Task checkboxes are re-enabled + wired up in the DOM post-pass.
  const inst = new Marked({ breaks: true, gfm: true });
  // Obsidian-style [[wikilinks]], resolved against the namespace tree.
  // Registered as an inline extension so code spans and fenced blocks
  // keep their normal precedence (no links inside code).
  inst.use(wikiLinkExtension({
    resolve: (page) => resolveWikiLink(page, pathIndex, notePath),
    ns,
  }));
  inst.use({
    renderer: {
      link({ href, title, text }) {
        // Relative links to .md files navigate inside the app, like
        // wikilinks. Everything else keeps the open-in-new-tab behavior.
        const internal = internalMdLinkHtml({ href, title, text }, ns, notePath);
        if (internal) return internal;
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
      image({ href, title, text }) {
        // An Excalidraw drawing embeds as a rendered, read-only SVG (loaded
        // lazily post-render), not an <img>.
        if (isExcalidrawDoc(href)) {
          const p = noteRelativePath(notePath, href);
          return `<div class="excalidraw-embed" data-excalidraw-src="${encodeURIComponent(p)}">Loading drawing…</div>`;
        }
        // Relative srcs resolve under /api/files/ and need the JWT as a
        // query param — an <img> GET can't carry an Authorization header,
        // so without it every image in Preview 401s (the Live editor's
        // proxyDomURL already does this).
        const src = resolveImgSrc(href, baseDir, getToken());
        const titleAttr = title ? ` title="${title}"` : '';
        return `<img src="${src}" alt="${text || ''}"${titleAttr} />`;
      },
      code({ text, lang }) {
        const codeText = text || '';
        const codeLang = (lang || '').trim().toLowerCase();
        if (codeLang === 'mermaid') {
          return `<div class="mermaid-source" data-mermaid="${encodeURIComponent(codeText)}"></div>`;
        }
        const escaped = codeText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre><code class="language-${codeLang}">${escaped}</code></pre>`;
      },
    },
  });

  return inst.parse(source);
}

// Scroll the preview to the heading whose visible text matches `heading`
// (case-insensitive). Headings carry a prepended toggle glyph and an
// appended copy button: strip both, same as the heading-copy handler.
function scrollToHeading(el, heading) {
  const want = heading.trim().toLowerCase();
  if (!want) return false;
  for (const h of el.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = h.textContent
      .replace(/^[▸▾]\s*/, '')
      .replace(/\u{1F4CB}$/u, '')
      .trim()
      .toLowerCase();
    if (text === want) {
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
  }
  return false;
}

function Preview({ content, currentPath, ns, onCheckboxToggle, pathIndex, onWikiLink }) {
  const containerRef = useRef(null);
  const [viewerSvg, setViewerSvg] = useState(null);

  const html = useMemo(
    () => renderMarkdown(content || '', ns, currentPath, pathIndex),
    [content, ns, currentPath, pathIndex]
  );

  // Diagrams are drawn imperatively into `el`, so a theme change has to be a
  // dependency of this effect or they keep the previous palette.
  const theme = useTheme();
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    applyMermaidTheme(theme);
    el.innerHTML = html;

    // Task checkbox handling. marked v15 emits GFM task lists as
    // <li><input type="checkbox" disabled [checked]> text</li> — we re-enable
    // those here, style their parent <li>, and wire a click handler that
    // walks the source markdown to find the matching line to toggle.
    let taskIdx = 0;
    el.querySelectorAll('li > input[type="checkbox"]').forEach((cb) => {
      if (onCheckboxToggle) {
        cb.removeAttribute('disabled');
      }
      cb.classList.add('task-checkbox');
      const li = cb.parentElement;
      if (li) li.classList.add('task-item');
      const idx = taskIdx++;
      if (!onCheckboxToggle) return;
      cb.addEventListener('change', () => {
        const lines = (content || '').split('\n');
        let taskCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trimStart();
          if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]') ||
              trimmed.startsWith('* [ ]') || trimmed.startsWith('* [x]')) {
            if (taskCount === idx) { onCheckboxToggle(i); return; }
            taskCount++;
          }
        }
      });
    });

    // In-cell task checkboxes — marked emits `[ ]` / `[x]` inside table
    // cells as plain text (GFM only renders task syntax inside list
    // items). Walk every td/th text node, replace each match with an
    // <input type="checkbox">, and wire a click handler that finds the
    // matching N-th `[ ]`/`[x]` literal in the source markdown and
    // toggles it. Indexed left-to-right top-to-bottom across the whole
    // document for deterministic mapping.
    if (onCheckboxToggle) {
      let cellTaskIdx = 0;
      el.querySelectorAll('td, th').forEach((cell) => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
        const targets = [];
        let n;
        while ((n = walker.nextNode())) targets.push(n);
        targets.forEach((textNode) => {
          const text = textNode.nodeValue || '';
          if (!/\[[ xX]\]/.test(text)) return;
          const frag = document.createDocumentFragment();
          let last = 0;
          const re = /\[([ xX])\]/g;
          let mm;
          while ((mm = re.exec(text)) !== null) {
            if (mm.index > last) frag.appendChild(document.createTextNode(text.slice(last, mm.index)));
            const checked = mm[1].toLowerCase() === 'x';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'task-cell-checkbox';
            cb.checked = checked;
            const myIdx = cellTaskIdx++;
            cb.addEventListener('change', () => {
              const lines = (content || '').split('\n');
              let count = 0;
              for (let i = 0; i < lines.length; i++) {
                const localRe = /\[([ xX])\]/g;
                let lm;
                while ((lm = localRe.exec(lines[i])) !== null) {
                  if (count === myIdx) {
                    onCheckboxToggle(i, lm.index);
                    return;
                  }
                  count++;
                }
              }
            });
            frag.appendChild(cb);
            last = mm.index + mm[0].length;
          }
          if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
          textNode.parentNode.replaceChild(frag, textNode);
        });
      });
    }

    // Force all links to open in new tab (safety net). Internal wikilink
    // anchors are excluded; they navigate inside the app.
    el.querySelectorAll('a[href]').forEach((a) => {
      if (a.classList.contains('wikilink')) return;
      if (!a.getAttribute('target')) a.setAttribute('target', '_blank');
      if (!a.getAttribute('rel')) a.setAttribute('rel', 'noopener noreferrer');
    });

    // Internal navigation for wikilinks and relative .md links. Plain
    // click opens the note in-app (no reload); modified clicks and
    // middle-click fall through to the #ns/path href so open-in-new-tab
    // still works. A same-note heading link just scrolls.
    el.querySelectorAll('a.wikilink').forEach((a) => {
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        const path = a.dataset.path;
        const heading = a.dataset.heading || '';
        if (path && path !== currentPath) {
          if (onWikiLink) onWikiLink(path);
        } else if (heading) {
          scrollToHeading(el, heading);
        }
      });
    });

    // Collapsible headings — only toggle icon triggers collapse
    el.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
      const level = parseInt(heading.tagName[1]);
      const toggle = document.createElement('span');
      toggle.className = 'heading-toggle';
      toggle.textContent = '\u25BE'; // ▾
      heading.prepend(toggle);
      heading.classList.add('collapsible-heading');

      const doToggle = () => {
        const collapsed = heading.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '\u25B8' : '\u25BE';
        let sib = heading.nextElementSibling;
        while (sib) {
          if (/^H[1-6]$/.test(sib.tagName) && parseInt(sib.tagName[1]) <= level) break;
          sib.style.display = collapsed ? 'none' : '';
          sib = sib.nextElementSibling;
        }
      };

      // Only the toggle icon triggers collapse
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        doToggle();
      });

      // Copy heading button (appears on hover)
      const copyBtn = document.createElement('span');
      copyBtn.className = 'heading-copy';
      copyBtn.title = 'Copy heading';
      copyBtn.innerHTML = '&#128203;'; // clipboard emoji as fallback
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = heading.textContent.replace(/^[\u25B8\u25BE]\s*/, '').replace(/\u{1F4CB}$/u, '').trim();
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyBtn.innerHTML = '&#10003;';
        setTimeout(() => { copyBtn.innerHTML = '&#128203;'; }, 1500);
      });
      heading.appendChild(copyBtn);
    });

    // Copy button on code blocks
    el.querySelectorAll('pre').forEach((preEl) => {
      if (preEl.querySelector('.code-copy-btn')) return;
      if (preEl.closest('.mermaid-container')) return; // skip mermaid
      const codeEl = preEl.querySelector('code');
      if (!codeEl) return;

      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.title = 'Copy code';
      btn.textContent = 'Copy';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = codeEl.textContent;
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
      preEl.style.position = 'relative';
      preEl.appendChild(btn);
    });

    // Mermaid rendering
    const mermaidEls = el.querySelectorAll('.mermaid-source');
    if (mermaidEls.length > 0) {
      let cancelled = false;
      (async () => {
        for (let i = 0; i < mermaidEls.length; i++) {
          if (cancelled) return;
          const mEl = mermaidEls[i];
          if (!mEl.parentNode) continue;
          const source = decodeURIComponent(mEl.dataset.mermaid);
          try {
            const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const { svg } = await mermaid.render(id, source);
            if (!cancelled && mEl.parentNode) {
              // Scrub the rendered SVG (defense-in-depth over mermaid's strict
              // mode) before injecting it or handing it to the fullscreen viewer.
              const cleanSvg = sanitizeSvg(svg);
              // Keep sanitized SVG for the fullscreen viewer
              const originalSvg = cleanSvg;
              const wrapper = document.createElement('div');
              wrapper.className = 'mermaid-container';
              wrapper.innerHTML = cleanSvg;
              // Remove hardcoded width/height so inline SVG fits container
              const svgEl = wrapper.querySelector('svg');
              if (svgEl) {
                svgEl.removeAttribute('width');
                svgEl.style.height = 'auto';
                // Force readable text on all elements — mermaid sets inline styles
                // based on node fill colors, often producing invisible text on dark mode
                fixMermaidTextColors(svgEl);
              }
              // Add expand button instead of click-anywhere
              const expandBtn = document.createElement('button');
              expandBtn.className = 'mermaid-expand-btn';
              expandBtn.title = 'Expand fullscreen';
              expandBtn.innerHTML = '&#x26F6;';
              expandBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setViewerSvg(originalSvg);
              });
              // Copy the diagram's labels. Dragging a selection across an SVG
              // is unreliable at best, so give the text the same one-click
              // affordance code blocks and headings already have.
              const copyBtn = document.createElement('button');
              copyBtn.className = 'mermaid-copy-btn';
              copyBtn.title = 'Copy diagram text';
              copyBtn.textContent = 'Copy text';
              copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                copyPlainText(extractDiagramText(wrapper.querySelector('svg')));
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy text'; }, 1500);
              });
              wrapper.style.position = 'relative';
              wrapper.appendChild(copyBtn);
              wrapper.appendChild(expandBtn);
              mEl.replaceWith(wrapper);
            }
          } catch (err) {
            if (!cancelled && mEl.parentNode) {
              // Render mermaid's error (which can echo the diagram source) as
              // text, not HTML, to avoid a second injection path.
              const pre = document.createElement('pre');
              pre.style.color = 'var(--danger)';
              pre.textContent = `Mermaid error: ${err.message || String(err)}`;
              mEl.replaceChildren(pre);
            }
          }
        }
      })();
      return () => { cancelled = true; };
    }
  }, [html, content, onCheckboxToggle, currentPath, onWikiLink, theme]);

  // Render embedded Excalidraw drawings (`![alt](x.excalidraw.md)`) as read-only
  // SVG. Kept in its own effect (the mermaid pass returns early) and lazy: the
  // Excalidraw export bundle only loads when a note actually embeds a drawing.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const embeds = el.querySelectorAll('.excalidraw-embed:not(.done)');
    if (embeds.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const [{ parseExcalidraw }, mod] = await Promise.all([
        import('../excalidraw.js'),
        import('@excalidraw/excalidraw'),
      ]);
      if (cancelled) return;
      for (const d of embeds) {
        if (cancelled) return;
        d.classList.add('done');
        const path = decodeURIComponent(d.dataset.excalidrawSrc || '');
        try {
          const { text } = await getNote(ns, path);
          if (cancelled) return;
          const scene = parseExcalidraw(text);
          if (!scene || scene.elements.length === 0) {
            d.textContent = 'Empty drawing';
            d.classList.add('excalidraw-embed-msg');
            continue;
          }
          const svg = await mod.exportToSvg({
            elements: scene.elements,
            files: scene.files,
            appState: { ...scene.appState, exportBackground: true },
          });
          if (cancelled) return;
          d.innerHTML = sanitizeSvg(svg.outerHTML);
          const svgEl = d.querySelector('svg');
          if (svgEl) {
            svgEl.removeAttribute('width');
            svgEl.removeAttribute('height');
            svgEl.style.maxWidth = '100%';
            svgEl.style.height = 'auto';
          }
          d.classList.add('loaded');
        } catch {
          if (cancelled) return;
          d.textContent = 'Could not load drawing';
          d.classList.add('excalidraw-embed-msg');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [html, ns]);

  const handleExportPdf = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const filename = currentPath
      ? currentPath.split('/').pop().replace(/\.md$/, '')
      : 'note';

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${filename}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1a1a1a;
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    line-height: 1.6;
  }
  h1 { font-size: 1.8rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; margin-top: 1.5rem; }
  h2 { font-size: 1.4rem; margin-top: 1.2rem; }
  h3 { font-size: 1.15rem; margin-top: 1rem; }
  code { background: #f4f4f4; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.85em; }
  pre { background: #f4f4f4; padding: 1rem; border-radius: 6px; overflow-x: auto; border: 1px solid #ddd; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #ccc; padding: 0.3rem 1rem; margin: 0.5rem 0; color: #555; }
  img { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.7rem; text-align: left; }
  th { background: #f4f4f4; }
  .task-checkbox { margin-right: 0.4rem; }
  li.task-item { list-style: none; margin-left: -1.2rem; }
  .mermaid-container svg { max-width: 100%; height: auto; }
  /* Force a dark-theme diagram onto white paper. These match the Mocha
     fills mermaid emits in dark mode; in light mode they simply do not
     match, which is correct — a Latte diagram already prints legibly. */
  .mermaid-container svg [fill="#313244"] { fill: #f8f9fa !important; }
  .mermaid-container svg [fill="#1e1e2e"] { fill: #ffffff !important; }
  .mermaid-container svg [stroke="#74c7ec"] { stroke: #2563eb !important; }
  .mermaid-container svg [stroke="#7f849c"] { stroke: #6b7280 !important; }
  .mermaid-container svg text { fill: #1a1a1a !important; }
  .mermaid-container svg .nodeLabel { color: #1a1a1a !important; }
  .heading-copy, .heading-toggle, .code-copy-btn, .mermaid-expand-btn, .mermaid-copy-btn { display: none !important; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>${el.innerHTML}</body>
</html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 500);
  }, [currentPath]);

  const expandAllHeadings = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // Remove all collapsed states and show everything
    el.querySelectorAll('.collapsible-heading.collapsed').forEach((h) => {
      h.classList.remove('collapsed');
      const toggle = h.querySelector('.heading-toggle');
      if (toggle) toggle.textContent = '\u25BE';
    });
    // Show all hidden elements
    el.querySelectorAll('[style*="display: none"]').forEach((e) => {
      e.style.display = '';
    });
  }, []);

  const collapseAllHeadings = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // Collapse all headings and hide non-heading content
    el.querySelectorAll('.collapsible-heading').forEach((h) => {
      h.classList.add('collapsed');
      const toggle = h.querySelector('.heading-toggle');
      if (toggle) toggle.textContent = '\u25B8';
    });
    // Hide everything that's not a heading
    const children = el.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child.classList.contains('collapsible-heading')) {
        child.style.display = 'none';
      }
    }
  }, []);


  return (
    <div className="preview-pane-wrapper">
      <div className="preview-toolbar">
        <button className="preview-fold-btn" onClick={expandAllHeadings} title="Expand all sections">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/><line x1="6" y1="4" x2="18" y2="4"/></svg>
        </button>
        <button className="preview-fold-btn" onClick={collapseAllHeadings} title="Collapse all sections">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 15 12 9 18 15"/><line x1="6" y1="20" x2="18" y2="20"/></svg>
        </button>
        <button className="preview-export-btn" onClick={handleExportPdf} title="Export as PDF">
          Export PDF
        </button>
      </div>
      <div className="preview-pane" ref={containerRef} />
      {viewerSvg && (
        <MermaidViewer svgContent={viewerSvg} onClose={() => setViewerSvg(null)} />
      )}
    </div>
  );
}

// Default export is the boundary-wrapped component. resetKey is derived from
// the note identity so switching files clears any previous error state.
function PreviewWithBoundary(props) {
  const resetKey = `${props.ns || ''}|${props.currentPath || ''}`;
  return (
    <PreviewErrorBoundary resetKey={resetKey}>
      <Preview {...props} />
    </PreviewErrorBoundary>
  );
}

export default PreviewWithBoundary;
