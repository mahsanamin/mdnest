import { useState, useRef, useEffect } from 'react';
import mermaid from 'mermaid';

// Inline mermaid block for the live editor.
// Shows rendered diagram by default with Source/Fullscreen buttons.
function MermaidBlock({ source, onChange, onFullscreen, readOnly }) {
  const [mode, setMode] = useState('preview');
  const [svgHtml, setSvgHtml] = useState('');
  const [error, setError] = useState('');
  const [editSource, setEditSource] = useState(source);
  const previewRef = useRef(null);

  // Render mermaid diagram
  useEffect(() => {
    if (mode !== 'preview') return;
    const src = mode === 'preview' ? source : editSource;
    if (!src?.trim()) { setSvgHtml(''); return; }

    let cancelled = false;
    (async () => {
      try {
        const id = `mmd-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg } = await mermaid.render(id, src.trim());
        if (!cancelled) {
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
      </div>
      {mode === 'preview' ? (
        <div className="mermaid-live-preview">
          {error ? (
            <div className="mermaid-live-error">{error}</div>
          ) : svgHtml ? (
            <div ref={previewRef} dangerouslySetInnerHTML={{ __html: svgHtml }} />
          ) : (
            <div className="mermaid-live-loading">Rendering...</div>
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
