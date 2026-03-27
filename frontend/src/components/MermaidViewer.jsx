import { useRef, useState, useEffect, useCallback } from 'react';

function MermaidViewer({ svgContent, onClose }) {
  const containerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });

  // Auto-fit on open: measure actual SVG render size and scale to fill viewport
  useEffect(() => {
    setTranslate({ x: 0, y: 0 });
    setScale(1);
    if (!svgContent) return;
    // Wait for DOM to render at scale=1, then measure and fit
    const timer = setTimeout(() => {
      const canvas = containerRef.current;
      if (!canvas) return;
      const svgEl = canvas.querySelector('svg');
      if (!svgEl) return;
      const svgRect = svgEl.getBoundingClientRect();
      const canvasW = canvas.clientWidth - 40;
      const canvasH = canvas.clientHeight - 40;
      if (svgRect.width > 0 && svgRect.height > 0 && canvasW > 0 && canvasH > 0) {
        setScale(Math.min(canvasW / svgRect.width, canvasH / svgRect.height));
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [svgContent]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Wheel zoom
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((s) => Math.max(0.1, Math.min(10, s + delta)));
  }, []);

  // Mouse pan
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translate };
  }, [translate]);

  const handleMouseMove = useCallback((e) => {
    if (!dragging) return;
    setTranslate({
      x: translateStart.current.x + (e.clientX - dragStart.current.x),
      y: translateStart.current.y + (e.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handleMouseUp = useCallback(() => { setDragging(false); }, []);

  // Touch pan
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    dragStart.current = { x: t.clientX, y: t.clientY };
    translateStart.current = { ...translate };
    setDragging(true);
  }, [translate]);

  const handleTouchMove = useCallback((e) => {
    if (!dragging || e.touches.length !== 1) return;
    const t = e.touches[0];
    setTranslate({
      x: translateStart.current.x + (t.clientX - dragStart.current.x),
      y: translateStart.current.y + (t.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handleTouchEnd = useCallback(() => { setDragging(false); }, []);

  const zoomIn = () => setScale((s) => Math.min(10, s + 0.25));
  const zoomOut = () => setScale((s) => Math.max(0.1, s - 0.25));
  const fitView = useCallback(() => {
    setTranslate({ x: 0, y: 0 });
    const canvas = containerRef.current;
    if (!canvas) { setScale(1); return; }
    const svgEl = canvas.querySelector('svg');
    if (!svgEl) { setScale(1); return; }
    // Temporarily reset scale to measure natural SVG size
    setScale(1);
    requestAnimationFrame(() => {
      const svgRect = svgEl.getBoundingClientRect();
      const canvasW = canvas.clientWidth - 40;
      const canvasH = canvas.clientHeight - 40;
      if (svgRect.width > 0 && svgRect.height > 0 && canvasW > 0 && canvasH > 0) {
        setScale(Math.min(canvasW / svgRect.width, canvasH / svgRect.height));
      }
    });
  }, []);
  const resetView = () => { setScale(1); setTranslate({ x: 0, y: 0 }); };

  const handlePrint = useCallback(() => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Mermaid Diagram</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: white;
  }
  svg {
    max-width: 95vw;
    max-height: 95vh;
  }
  @page {
    size: landscape;
    margin: 0.5in;
  }
  @media print {
    html, body { background: white; }
  }
</style>
</head>
<body>${svgContent}</body>
</html>`);
    w.document.close();
    setTimeout(() => { w.print(); }, 400);
  }, [svgContent]);

  if (!svgContent) return null;

  return (
    <div className="mermaid-viewer-backdrop" onClick={onClose}>
      <div className="mermaid-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="mermaid-viewer-toolbar">
          <button onClick={zoomIn} title="Zoom in">+</button>
          <span className="mermaid-viewer-zoom">{Math.round(scale * 100)}%</span>
          <button onClick={zoomOut} title="Zoom out">-</button>
          <button onClick={fitView} title="Fit to screen">Fit</button>
          <button onClick={resetView} title="Reset to 100%">100%</button>
          <div className="mermaid-viewer-spacer" />
          <button onClick={handlePrint} title="Print diagram">Print</button>
          <button onClick={onClose} title="Close">Close</button>
        </div>
        <div
          className="mermaid-viewer-canvas"
          ref={containerRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        >
          <div
            className="mermaid-viewer-content"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
            }}
            dangerouslySetInnerHTML={{ __html: svgContent }}
          />
        </div>
      </div>
    </div>
  );
}

export default MermaidViewer;
