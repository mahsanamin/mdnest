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
  const [editingLabel, setEditingLabel] = useState(null); // {text, rect, originalText}
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
          // Remove hardcoded width/height so SVG scales to container
          svg = svg.replace(/(<svg[^>]*?)(\s+width="[^"]*")/, '$1');
          svg = svg.replace(/(<svg[^>]*?)(\s+height="[^"]*")/, '$1');
          // Ensure it has width:100% style
          svg = svg.replace(/(<svg)/, '$1 style="width:100%;height:auto;"');
          setSvgHtml(svg);
          setError('');
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

  // Make node labels clickable — use click delegation on the preview container
  const handlePreviewClick = useCallback((e) => {
    if (readOnly) return;

    // Walk up from the click target to find a text/label element
    let el = e.target;
    let text = null;
    for (let i = 0; i < 5 && el && el !== previewRef.current; i++) {
      // Check if this is a label element
      const tagName = el.tagName?.toLowerCase();
      const cls = el.className?.baseVal || el.className || '';
      if (
        tagName === 'text' ||
        tagName === 'span' ||
        tagName === 'p' ||
        tagName === 'div' ||
        cls.includes('nodeLabel') ||
        cls.includes('edgeLabel') ||
        cls.includes('label')
      ) {
        const t = el.textContent?.trim();
        if (t && t.length > 0 && t.length < 200) {
          text = t;
          break;
        }
      }
      el = el.parentElement;
    }

    if (!text || !previewRef.current) return;

    const containerRect = previewRef.current.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    setEditingLabel({
      text,
      originalText: text,
      left: elRect.left - containerRect.left,
      top: elRect.top - containerRect.top,
      width: Math.max(text.length * 10 + 40, elRect.width + 60, 200),
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
        {svgHtml && (
          <button onClick={() => onFullscreen && onFullscreen(svgHtml)} title="Fullscreen">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
          </button>
        )}
        {mode === 'preview' && !readOnly && (
          <span className="mermaid-live-hint">Click any label to edit</span>
        )}
      </div>
      {mode === 'preview' ? (
        <div className="mermaid-live-preview" style={{ position: 'relative' }} onClick={handlePreviewClick}>
          {error ? (
            <div className="mermaid-live-error">{error}</div>
          ) : svgHtml ? (
            <div ref={previewRef} dangerouslySetInnerHTML={{ __html: svgHtml }} />
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
