import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { marked, Renderer } from 'marked';
import mermaid from 'mermaid';
import MermaidViewer from './MermaidViewer.jsx';

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  themeVariables: {
    darkMode: true,
    background: '#1e1e2e',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',

    // Primary nodes — dark blue fill, light text
    primaryColor: '#313244',
    primaryTextColor: '#cdd6f4',
    primaryBorderColor: '#74c7ec',

    // Secondary nodes — muted green fill, dark text for contrast
    secondaryColor: '#2a4a3a',
    secondaryTextColor: '#cdd6f4',
    secondaryBorderColor: '#94e2d5',

    // Tertiary nodes — muted purple fill, dark text for contrast
    tertiaryColor: '#3a2a4a',
    tertiaryTextColor: '#cdd6f4',
    tertiaryBorderColor: '#cba6f7',

    // Global defaults
    lineColor: '#7f849c',
    textColor: '#cdd6f4',
    mainBkg: '#313244',
    nodeBorder: '#74c7ec',
    nodeTextColor: '#cdd6f4',

    // Clusters (subgraphs)
    clusterBkg: '#181825',
    clusterBorder: '#585b70',

    // Labels & misc
    titleColor: '#cdd6f4',
    edgeLabelBackground: '#313244',
    noteBkgColor: '#313244',
    noteTextColor: '#cdd6f4',
    noteBorderColor: '#585b70',

    // Sequence diagrams
    actorTextColor: '#cdd6f4',
    actorBkg: '#313244',
    actorBorder: '#74c7ec',
    signalColor: '#cdd6f4',
    loopTextColor: '#cdd6f4',
    labelBoxBkgColor: '#313244',
    labelBoxBorderColor: '#585b70',
    labelTextColor: '#cdd6f4',
  },
});

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
  let taskIndex = 0;

  const renderer = new Renderer();

  renderer.link = function ({ href, title, text }) {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  };

  renderer.image = function ({ href, title, text }) {
    let src = href || '';
    if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('/')) {
      src = baseDir + src;
    }
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img src="${src}" alt="${text || ''}"${titleAttr} />`;
  };

  renderer.code = function ({ text, lang }) {
    const codeText = text || '';
    const codeLang = (lang || '').trim().toLowerCase();
    if (codeLang === 'mermaid') {
      return `<div class="mermaid-source" data-mermaid="${encodeURIComponent(codeText)}"></div>`;
    }
    const escaped = codeText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code class="language-${codeLang}">${escaped}</code></pre>`;
  };

  const origListitem = renderer.listitem.bind(renderer);
  renderer.listitem = function (token) {
    const raw = token.raw || '';
    const isChecked = raw.trimStart().startsWith('- [x]') || raw.trimStart().startsWith('* [x]');
    const isUnchecked = raw.trimStart().startsWith('- [ ]') || raw.trimStart().startsWith('* [ ]');
    if (isChecked || isUnchecked) {
      const text = this.parser.parseInline(token.tokens);
      const idx = taskIndex++;
      const checked = isChecked ? 'checked' : '';
      const checkbox = `<input type="checkbox" class="task-checkbox" data-task-index="${idx}" ${checked} />`;
      const cleanText = text.replace(/^\[[ x]\]\s*/, '');
      return `<li class="task-item">${checkbox}${cleanText}</li>\n`;
    }
    return origListitem(token);
  };

  return marked(source, { renderer, breaks: true });
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

    // Checkbox handling
    el.querySelectorAll('.task-checkbox').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.taskIndex, 10);
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
