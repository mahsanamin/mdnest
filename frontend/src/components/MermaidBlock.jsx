import { useState, useRef, useEffect, useCallback } from 'react';
import mermaid, { fixMermaidTextColors } from '../mermaid-config.js';

function AutoSizeInput({ className, style, defaultValue, onConfirm, onCancel }) {
  const [value, setValue] = useState(defaultValue || '');
  const measureRef = useRef(null);
  const inputRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (measureRef.current) {
      const w = Math.max(measureRef.current.scrollWidth + 32, 120);
      const h = Math.max(measureRef.current.scrollHeight + 4, 32);
      setSize({ width: w, height: h });
    }
  }, [value]);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  return (
    <>
      <span
        ref={measureRef}
        className={className}
        style={{
          position: 'fixed',
          visibility: 'hidden',
          whiteSpace: 'pre-wrap',
          maxWidth: '400px',
          padding: '6px 12px',
          fontSize: '0.9rem',
        }}
      >{value || ' '}</span>
      <textarea
        ref={inputRef}
        className={className}
        style={{
          ...style,
          width: Math.min(size.width, 400),
          height: size.height,
          resize: 'none',
          overflow: 'hidden',
        }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onConfirm(value); }
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => onConfirm(value)}
        rows={1}
      />
    </>
  );
}

function MermaidBlock({ source, onChange, onFullscreen, readOnly }) {
  const [mode, setMode] = useState('preview');
  const [svgHtml, setSvgHtml] = useState('');
  const [error, setError] = useState('');
  const [editSource, setEditSource] = useState(source);
  const [editingLabel, setEditingLabel] = useState(null);
  const [zoom, setZoom] = useState(100);
  const [naturalWidth, setNaturalWidth] = useState(null);
  const [originalSvg, setOriginalSvg] = useState('');
  const previewRef = useRef(null);
  const currentSource = useRef(source);
  currentSource.current = source;

  // Render mermaid diagram
  useEffect(() => {
    if (mode !== 'preview') return;
    if (!source?.trim()) { setSvgHtml(''); return; }

    let cancelled = false;
    (async () => {
      try {
        const id = `mmd-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        let { svg } = await mermaid.render(id, source.trim());
        if (!cancelled) {
          // Extract actual diagram size from viewBox (reliable) or width attr (fallback)
          // viewBox format: "minX minY width height"
          const vbMatch = svg.match(/viewBox="[^"]*?(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+([\d.]+)"/);
          const wMatch = svg.match(/width="([\d.]+)/);
          // viewBox width (3rd value) is the real diagram width
          const natW = vbMatch ? parseFloat(vbMatch[3]) : (wMatch ? parseFloat(wMatch[1]) : 500);
          setNaturalWidth(natW);

          // Keep unmodified SVG for fullscreen viewer
          setOriginalSvg(svg);

          // Remove hardcoded width/height, set to fill container
          svg = svg.replace(/(<svg[^>]*?)(\s+width="[^"]*")/, '$1');
          svg = svg.replace(/(<svg[^>]*?)(\s+height="[^"]*")/, '$1');
          svg = svg.replace(/(<svg)/, '$1 style="width:100%;height:auto;"');

          setSvgHtml(svg);
          setError('');
          // Smart initial zoom: if natural width is very small (<300), scale up
          // If very large (>1000), scale to fit
          setZoom(100);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message || 'Mermaid syntax error');
          setSvgHtml('');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [source, mode]);

  // Fix text colors after SVG renders.
  // Instead of modifying mermaid's <style> (too aggressive — breaks backgrounds),
  // inject our own <style> at the END of the SVG that overrides text colors only.
  // Also run fixMermaidTextColors for inline style attributes.
  useEffect(() => {
    if (!svgHtml) return;
    const fix = () => {
      const container = previewRef.current;
      if (!container) return;
      const svgEl = container.querySelector('svg');
      if (!svgEl) return;

      // Inject override CSS once (check for existing)
      if (!svgEl.querySelector('#mdnest-text-override')) {
        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.id = 'mdnest-text-override';
        style.textContent = `
          text.actor, .actor text { fill: #cdd6f4 !important; }
          .messageText { fill: #cdd6f4 !important; }
          .loopText, .loopText > tspan { fill: #cdd6f4 !important; }
          .noteText > tspan { fill: #cdd6f4 !important; }
          .labelText > tspan { fill: #cdd6f4 !important; }
          .nodeLabel { color: #cdd6f4 !important; }
          .edgeLabel { color: #cdd6f4 !important; }
          .label text { fill: #cdd6f4 !important; }
        `;
        svgEl.appendChild(style);
      }

      // Also fix inline style attributes on individual elements
      fixMermaidTextColors(svgEl);
    };
    requestAnimationFrame(fix);
    const t1 = setTimeout(fix, 150);
    return () => { clearTimeout(t1); };
  }, [svgHtml]);

  // Make any mermaid text clickable — diagram-type agnostic.
  // Strategy: find the nearest <g> group, then find any text inside it.
  const handlePreviewClick = useCallback((e) => {
    if (readOnly) return;

    let el = e.target;
    let text = null;
    let textEl = null;

    // Walk up from click target to find a <g> group containing text
    for (let i = 0; i < 10 && el && el !== previewRef.current; i++) {
      const tagName = el.tagName?.toLowerCase();

      // If we hit a <text> or <tspan> directly — use it
      if (tagName === 'text' || tagName === 'tspan') {
        const root = tagName === 'tspan' ? el.parentElement : el;
        const tspans = root.querySelectorAll('tspan');
        text = tspans.length > 1
          ? Array.from(tspans).map(ts => ts.textContent.trim()).filter(Boolean).join(' ')
          : root.textContent?.trim();
        textEl = root;
        break;
      }

      // If we hit a <span> or <p> inside foreignObject — use it
      if ((tagName === 'span' || tagName === 'p') && el.closest('foreignObject')) {
        text = el.innerHTML ? el.innerHTML.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').trim() : el.textContent?.trim();
        textEl = el;
        break;
      }

      // If we hit a <g> group or shape (rect/circle/etc) — look for text inside
      if (tagName === 'g' || ['rect', 'circle', 'path', 'polygon', 'ellipse', 'line'].includes(tagName)) {
        const group = tagName === 'g' ? el : el.parentElement;
        if (!group) { el = el.parentElement; continue; }

        // Find text in this group: try foreignObject first (HTML labels), then SVG text
        const foText = group.querySelector('foreignObject span, foreignObject p');
        const svgText = group.querySelector('text');
        const found = foText || svgText;

        if (found) {
          const foundTag = found.tagName?.toLowerCase();
          if (foundTag === 'text') {
            const tspans = found.querySelectorAll('tspan');
            text = tspans.length > 1
              ? Array.from(tspans).map(ts => ts.textContent.trim()).filter(Boolean).join(' ')
              : found.textContent?.trim();
          } else {
            text = found.innerHTML ? found.innerHTML.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').trim() : found.textContent?.trim();
          }
          textEl = found;
          break;
        }
      }

      el = el.parentElement;
    }

    if (!text || !textEl || !previewRef.current) return;
    if (text.length > 300) return;

    const containerRect = previewRef.current.getBoundingClientRect();
    const elRect = textEl.getBoundingClientRect();

    setEditingLabel({
      text,
      originalText: text,
      left: elRect.left - containerRect.left,
      top: elRect.top - containerRect.top,
      width: Math.max(text.length * 8 + 50, elRect.width + 40, 200),
      height: Math.max(elRect.height + 16, 36),
    });
  }, [readOnly]);

  // Replace label in mermaid source
  const handleLabelChange = useCallback((newText) => {
    if (!editingLabel || !onChange) return;
    const oldText = editingLabel.originalText;
    if (newText === oldText || !newText.trim()) {
      setEditingLabel(null);
      return;
    }

    let src = currentSource.current;
    let replaced = false;

    // 1. Exact match
    if (src.includes(oldText)) {
      src = src.replace(oldText, newText);
      replaced = true;
    }

    // 2. Try replacing ALL spaces with a single separator type (for fully-wrapped labels)
    if (!replaced) {
      const separators = ['\\n', '<br>', '<br/>', '<br />'];
      for (const sep of separators) {
        const candidate = oldText.replace(/ /g, sep);
        if (src.includes(candidate)) {
          src = src.replace(candidate, newText);
          replaced = true;
          break;
        }
      }
    }

    // 3. Try matching where SOME spaces are line breaks (not all)
    // Each space could be a space, \n, <br>, or <br/>
    if (!replaced) {
      const words = oldText.split(' ');
      if (words.length > 1) {
        const breakVariants = ['\\n', '<br>', '<br/>', '<br />'];
        for (let mask = 1; mask < (1 << (words.length - 1)); mask++) {
          for (const brk of breakVariants) {
            let candidate = words[0];
            for (let i = 1; i < words.length; i++) {
              candidate += ((mask >> (i - 1)) & 1) ? brk : ' ';
              candidate += words[i];
            }
            if (src.includes(candidate)) {
              src = src.replace(candidate, newText);
              replaced = true;
              break;
            }
          }
          if (replaced) break;
        }
      }
    }

    setEditingLabel(null);
    if (src !== currentSource.current) {
      onChange(src);
    }
  }, [editingLabel, onChange]);

  const handleSwitchToSource = () => {
    setEditSource(source);
    setMode('source');
  };

  const handleSwitchToPreview = () => {
    if (editSource !== source && onChange) {
      onChange(editSource);
    }
    setMode('preview');
  };

  // Smart sizing: small diagrams use natural width, large ones fill container
  // Zoom applies via transform on top of the base size
  const isSmall = naturalWidth && naturalWidth < 400;
  const svgContainerStyle = {
    transformOrigin: 'top center',
  };
  if (isSmall) {
    // Small diagram: use natural width, centered, zoom scales from there
    svgContainerStyle.width = `${naturalWidth}px`;
    svgContainerStyle.maxWidth = '100%';
    svgContainerStyle.margin = '0 auto';
    if (zoom !== 100) svgContainerStyle.transform = `scale(${zoom / 100})`;
  } else {
    // Large diagram: fill container, zoom scales from there
    svgContainerStyle.width = '100%';
    if (zoom !== 100) svgContainerStyle.transform = `scale(${zoom / 100})`;
  }

  return (
    <div className="mermaid-live-block" contentEditable={false}>
      <div className="mermaid-live-toolbar">
        <button
          className={mode === 'preview' ? 'active' : ''}
          onClick={handleSwitchToPreview}
        >Preview</button>
        <button
          className={mode === 'source' ? 'active' : ''}
          onClick={handleSwitchToSource}
        >Source</button>
        {svgHtml && mode === 'preview' && (
          <>
            <span className="mermaid-toolbar-sep" />
            <button onClick={() => setZoom((z) => Math.max(20, z - 20))} title="Zoom out">−</button>
            <span className="mermaid-zoom-label">{zoom}%</span>
            <button onClick={() => setZoom((z) => Math.min(300, z + 20))} title="Zoom in">+</button>
            <button onClick={() => setZoom(100)} title="Reset zoom">Fit</button>
          </>
        )}
        {svgHtml && (
          <>
            <button onClick={() => onFullscreen && onFullscreen(originalSvg || svgHtml)} title="Fullscreen">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
            </button>
            <button
              className="mermaid-copy-btn"
              onClick={(e) => {
                const ta = document.createElement('textarea');
                ta.value = source;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                const btn = e.currentTarget;
                btn.textContent = '\u2713';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
              }}
              title="Copy mermaid code"
            >Copy</button>
          </>
        )}
        {mode === 'preview' && !readOnly && (
          <span className="mermaid-live-hint">Click any label to edit</span>
        )}
      </div>
      {mode === 'preview' ? (
        <div className="mermaid-live-preview" style={{ position: 'relative', overflow: 'auto' }} onClick={handlePreviewClick}>
          {error ? (
            <div className="mermaid-live-error">{error}</div>
          ) : svgHtml ? (
            <div ref={previewRef} style={svgContainerStyle} dangerouslySetInnerHTML={{ __html: svgHtml }} />
          ) : (
            <div className="mermaid-live-loading">Rendering...</div>
          )}
          {editingLabel && (
            <AutoSizeInput
              className="mermaid-label-input"
              style={{
                position: 'absolute',
                left: editingLabel.left,
                top: editingLabel.top,
              }}
              defaultValue={editingLabel.text}
              onConfirm={(val) => handleLabelChange(val)}
              onCancel={() => setEditingLabel(null)}
            />
          )}
        </div>
      ) : (
        <textarea
          className="mermaid-live-source"
          value={editSource}
          onChange={(e) => setEditSource(e.target.value)}
          onBlur={handleSwitchToPreview}
          readOnly={readOnly}
          rows={Math.max(4, editSource.split('\n').length)}
          spellCheck={false}
          autoFocus
        />
      )}
    </div>
  );
}

export default MermaidBlock;
