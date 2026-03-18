import { useEffect, useRef, useMemo } from 'react';
import { marked } from 'marked';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    darkMode: true,
    background: '#1e1e2e',
    primaryColor: '#89b4fa',
    primaryTextColor: '#cdd6f4',
    lineColor: '#585b70',
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

  const renderer = {
    listitem(token) {
      const text = this.parser.parseInline(token.tokens);
      const raw = token.raw || '';
      const isChecked = raw.trimStart().startsWith('- [x]') || raw.trimStart().startsWith('* [x]');
      const isUnchecked = raw.trimStart().startsWith('- [ ]') || raw.trimStart().startsWith('* [ ]');
      if (isChecked || isUnchecked) {
        const idx = taskIndex++;
        const checked = isChecked ? 'checked' : '';
        const checkbox = `<input type="checkbox" class="task-checkbox" data-task-index="${idx}" ${checked} />`;
        const cleanText = text.replace(/^\[[ x]\]\s*/, '');
        return `<li class="task-item">${checkbox}${cleanText}</li>\n`;
      }
      return `<li>${text}</li>\n`;
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

  return marked(source, { renderer, breaks: true });
}

function Preview({ content, currentPath, ns, onCheckboxToggle }) {
  const containerRef = useRef(null);

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

    // Mermaid rendering
    const mermaidEls = el.querySelectorAll('.mermaid-source');
    if (mermaidEls.length > 0) {
      let cancelled = false;
      (async () => {
        for (let i = 0; i < mermaidEls.length; i++) {
          if (cancelled) return;
          const mEl = mermaidEls[i];
          if (!mEl.parentNode) continue; // Already replaced
          const source = decodeURIComponent(mEl.dataset.mermaid);
          try {
            const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const { svg } = await mermaid.render(id, source);
            if (!cancelled && mEl.parentNode) {
              const wrapper = document.createElement('div');
              wrapper.className = 'mermaid-container';
              wrapper.innerHTML = svg;
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

  return <div className="preview-pane" ref={containerRef} />;
}

export default Preview;
