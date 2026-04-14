import { useState, useRef, useEffect, useCallback } from 'react';
import mermaid from 'mermaid';

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

  // Fix text colors after SVG renders — mermaid's dark theme produces
  // low-contrast text on dark node fills. Use the same fixMermaidTextColors
  // approach as Preview.jsx but via getComputedStyle for reliable fill detection.
  useEffect(() => {
    if (!svgHtml) return;
    requestAnimationFrame(() => {
      const container = previewRef.current;
      if (!container) return;
      const svgEl = container.querySelector('svg');
      if (!svgEl) return;

      const lightText = '#cdd6f4';
      const darkText = '#1e1e2e';

      function getBrightness(color) {
        if (!color || color === 'none' || color === 'transparent') return -1;
        try {
          const ctx = document.createElement('canvas').getContext('2d');
          ctx.fillStyle = color;
          const hex = ctx.fillStyle;
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          return (r * 299 + g * 587 + b * 114) / 1000;
        } catch { return -1; }
      }

      // Use getComputedStyle to get the ACTUAL rendered fill, including CSS-applied fills
      function getNodeFill(el) {
        let node = el.closest ? el.closest('.node, .cluster, .actor, .note') : null;
        if (!node) node = el.parentElement;
        while (node && node !== svgEl) {
          const shapes = node.querySelectorAll('rect, circle, polygon, path');
          for (const shape of shapes) {
            // Try computed style first (catches CSS-applied fills)
            try {
              const computed = window.getComputedStyle(shape);
              const fill = computed.fill;
              if (fill && fill !== 'none') return fill;
            } catch {}
            // Fallback to attribute
            const attr = shape.getAttribute('fill');
            if (attr && attr !== 'none' && attr !== 'transparent') return attr;
          }
          node = node.parentElement;
        }
        return null;
      }

      // SVG text/tspan
      svgEl.querySelectorAll('text, tspan').forEach((t) => {
        const fill = getNodeFill(t);
        const b = getBrightness(fill);
        // If can't determine fill, default to light text (dark bg assumed)
        const color = b > 140 ? darkText : lightText;
        t.setAttribute('fill', color);
        t.style.fill = color;
      });

      // HTML inside foreignObject
      svgEl.querySelectorAll('foreignObject span, foreignObject div, foreignObject p').forEach((t) => {
        const fill = getNodeFill(t.closest('foreignObject') || t);
        const b = getBrightness(fill);
        const color = b > 140 ? darkText : lightText;
        t.style.setProperty('color', color, 'important');
      });
    });
  }, [svgHtml]);

  // Make node labels clickable — use click delegation on the preview container
  const handlePreviewClick = useCallback((e) => {
    if (readOnly) return;

    // Walk up from the click target to find any text-bearing element
    let el = e.target;
    let text = null;
    let textEl = null;

    for (let i = 0; i < 8 && el && el !== previewRef.current; i++) {
      const tagName = el.tagName?.toLowerCase();
      const cls = el.className?.baseVal || el.className || '';

      // Match: SVG text/tspan, HTML span/p/div, or any mermaid label class
      const isTextElement = (
        tagName === 'text' ||
        tagName === 'tspan' ||
        tagName === 'span' ||
        tagName === 'p' ||
        tagName === 'div' ||
        cls.includes('nodeLabel') ||
        cls.includes('edgeLabel') ||
        cls.includes('label') ||
        cls.includes('messageText') ||
        cls.includes('actor') ||
        cls.includes('loopText') ||
        cls.includes('noteText') ||
        cls.includes('labelText')
      );

      if (isTextElement) {
        // For tspan, use parent <text> for positioning but tspan's text
        const t = el.textContent?.trim();
        if (t && t.length > 0 && t.length < 300) {
          text = t;
          // Use the closest block-level element for positioning
          textEl = (tagName === 'tspan' && el.parentElement?.tagName?.toLowerCase() === 'text')
            ? el.parentElement : el;
          break;
        }
      }
      el = el.parentElement;
    }

    if (!text || !textEl || !previewRef.current) return;

    // Skip if it's a very long multi-line text (probably a Note block)
    if (text.includes('\n') && text.length > 100) return;

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

    // Replace the label in the source
    // Mermaid labels appear in patterns like: A[Label], A(Label), A{Label}, A((Label)), A>Label], A[/Label/]
    // Also edge labels: -->|Label|, -- Label -->
    let newSource = currentSource.current;

    // Try bracket patterns: [old], (old), {old}, ((old)), [/old/], [\old\]
    const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(\\[)${escaped}(\\])`, 'g'),           // [Label]
      new RegExp(`(\\()${escaped}(\\))`, 'g'),           // (Label)
      new RegExp(`(\\{)${escaped}(\\})`, 'g'),           // {Label}
      new RegExp(`(\\(\\()${escaped}(\\)\\))`, 'g'),     // ((Label))
      new RegExp(`(\\[/)${escaped}(/\\])`, 'g'),         // [/Label/]
      new RegExp(`(\\|)${escaped}(\\|)`, 'g'),           // |Label|
      new RegExp(`(-- )${escaped}( -->)`, 'g'),          // -- Label -->
      new RegExp(`(-- )${escaped}( ---)`, 'g'),          // -- Label ---
    ];

    let replaced = false;
    for (const pattern of patterns) {
      if (pattern.test(newSource)) {
        newSource = newSource.replace(pattern, `$1${newText}$2`);
        replaced = true;
        break;
      }
    }

    // Fallback: simple string replace (first occurrence)
    if (!replaced && newSource.includes(oldText)) {
      newSource = newSource.replace(oldText, newText);
    }

    setEditingLabel(null);
    if (newSource !== currentSource.current) {
      onChange(newSource);
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
