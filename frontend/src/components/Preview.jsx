import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { marked, Renderer } from 'marked';
import mermaid from 'mermaid';
import MermaidViewer from './MermaidViewer.jsx';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    darkMode: true,
    background: '#1e1e2e',
    primaryColor: '#89b4fa',
    primaryTextColor: '#cdd6f4',
    primaryBorderColor: '#74c7ec',
    secondaryColor: '#a6e3a1',
    secondaryTextColor: '#1e1e2e',
    secondaryBorderColor: '#94e2d5',
    tertiaryColor: '#f5c2e7',
    tertiaryTextColor: '#1e1e2e',
    tertiaryBorderColor: '#cba6f7',
    lineColor: '#7f849c',
    textColor: '#cdd6f4',
    mainBkg: '#313244',
    nodeBorder: '#74c7ec',
    clusterBkg: '#1e1e2e',
    clusterBorder: '#585b70',
    titleColor: '#cdd6f4',
    edgeLabelBackground: '#313244',
    nodeTextColor: '#cdd6f4',
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
              wrapper.className = 'mermaid-container mermaid-clickable';
              wrapper.title = 'Click to expand';
              wrapper.innerHTML = svg;
              // Remove hardcoded width/height so inline SVG fits container
              const svgEl = wrapper.querySelector('svg');
              if (svgEl) {
                svgEl.removeAttribute('width');
                svgEl.style.maxWidth = '100%';
                svgEl.style.height = 'auto';
              }
              wrapper.addEventListener('click', () => {
                setViewerSvg(originalSvg);
              });
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
  @media print { body { padding: 0; } }
</style>
</head>
<body>${el.innerHTML}</body>
</html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 500);
  }, [currentPath]);

  return (
    <div className="preview-pane-wrapper">
      <div className="preview-toolbar">
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
