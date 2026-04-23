import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { marked } from 'marked';
import mermaid, { fixMermaidTextColors } from '../mermaid-config.js';
import MermaidViewer from './MermaidViewer.jsx';

function getBaseDir(ns, notePath) {
  const nsPrefix = ns ? encodeURIComponent(ns) + '/' : '';
  if (!notePath) return `/api/files/${nsPrefix}`;
  const parts = notePath.split('/');
  parts.pop();
  const dir = parts.length > 0 ? parts.join('/') + '/' : '';
  return `/api/files/${nsPrefix}${dir}`;
}

function renderMarkdown(source, ns, notePath) {
  const baseDir = getBaseDir(ns, notePath);

  // marked v15 requires a plain-object renderer (not `new Renderer()`).
  // We do NOT override `listitem` — marked already renders GFM task lists
  // as <li><input type="checkbox" disabled>. The previous override called
  // parseInline on block-level token.tokens and blew up whenever a task
  // item contained a nested list ("Token with 'list' type was not found").
  // Task checkboxes are re-enabled + wired up in the DOM post-pass.
  const renderer = {
    link({ href, title, text }) {
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image({ href, title, text }) {
      let src = href || '';
      if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('/')) {
        src = baseDir + src;
      }
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
  };

  return marked(source, { renderer, breaks: true, gfm: true });
}

function Preview({ content, currentPath, ns, onCheckboxToggle }) {
  const containerRef = useRef(null);
  const [viewerSvg, setViewerSvg] = useState(null);

  const html = useMemo(
    () => renderMarkdown(content || '', ns, currentPath),
    [content, ns, currentPath]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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

    // Force all links to open in new tab (safety net)
    el.querySelectorAll('a[href]').forEach((a) => {
      if (!a.getAttribute('target')) a.setAttribute('target', '_blank');
      if (!a.getAttribute('rel')) a.setAttribute('rel', 'noopener noreferrer');
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
              // Keep original SVG for the fullscreen viewer
              const originalSvg = svg;
              const wrapper = document.createElement('div');
              wrapper.className = 'mermaid-container';
              wrapper.innerHTML = svg;
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
              wrapper.style.position = 'relative';
              wrapper.appendChild(expandBtn);
              mEl.replaceWith(wrapper);
            }
          } catch (err) {
            if (!cancelled && mEl.parentNode) {
              mEl.innerHTML = `<pre style="color:#f38ba8;">Mermaid error: ${err.message || String(err)}</pre>`;
            }
          }
        }
      })();
      return () => { cancelled = true; };
    }
  }, [html, content, onCheckboxToggle]);

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
  .mermaid-container svg [fill="#313244"] { fill: #f8f9fa !important; }
  .mermaid-container svg [fill="#1e1e2e"] { fill: #ffffff !important; }
  .mermaid-container svg [stroke="#74c7ec"] { stroke: #2563eb !important; }
  .mermaid-container svg [stroke="#7f849c"] { stroke: #6b7280 !important; }
  .mermaid-container svg text { fill: #1a1a1a !important; }
  .mermaid-container svg .nodeLabel { color: #1a1a1a !important; }
  .heading-copy, .heading-toggle, .code-copy-btn, .mermaid-expand-btn { display: none !important; }
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

export default Preview;
