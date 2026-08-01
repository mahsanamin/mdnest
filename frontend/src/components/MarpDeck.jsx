// MarpDeck — renders a Marp-format note as a paginated slide deck.
//
// Each slide is displayed inside a fully **sandboxed iframe** (`sandbox=""`: no
// scripts, no same-origin, opaque origin) — that is the security boundary, so no
// markup in the note can run script or reach the app. Because of the sandbox we
// can safely enable inline HTML (`html: true`) — Marp decks commonly use
// <div class="…"> layouts and <style> blocks — and we keep `script: false` so
// Marp injects no runtime of its own. The engine is imported here so it only
// loads when a Marp note is opened with the feature enabled (the parent
// lazy-loads this component).
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Marp } from '@marp-team/marp-core';
import './MarpDeck.css';

// render turns the note into per-slide HTML fragments + the theme CSS.
function render(content) {
  const marp = new Marp({ html: true, script: false });
  const { html, css } = marp.render(content);
  // Marp emits one <svg data-marpit-svg> per slide inside a .marpit wrapper.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll('svg[data-marpit-svg]');
  const slides = Array.from(nodes).map((n) => n.outerHTML);
  return { slides: slides.length ? slides : [html], css };
}

export default function MarpDeck({ content, scrollPct }) {
  const { slides, css, error } = useMemo(() => {
    try {
      return render(content);
    } catch (e) {
      return { slides: [], css: '', error: e.message };
    }
  }, [content]);

  const total = slides.length;
  const [idx, setIdx] = useState(0);
  const clamp = useCallback((i) => Math.max(0, Math.min(total - 1, i)), [total]);
  useEffect(() => { setIdx((i) => clamp(i)); }, [total, clamp]);

  // Follow the editor's position in split view: the deck isn't scrollable, so
  // the parent hands us the editor's 0..1 scroll ratio and we map it to a
  // slide. Manual navigation (arrows/keys/buttons) still works — the next
  // editor scroll simply re-syncs. Ignored when the parent passes nothing
  // (fullscreen, mobile, or preview-only where there is no editor to track).
  useEffect(() => {
    if (typeof scrollPct !== 'number' || total <= 1) return;
    setIdx(clamp(Math.round(scrollPct * (total - 1))));
  }, [scrollPct, total, clamp]);

  const rootRef = useRef(null);
  const go = useCallback((delta) => setIdx((i) => clamp(i + delta)), [clamp]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
      else if (e.key === 'Home') { e.preventDefault(); setIdx(0); }
      else if (e.key === 'End') { e.preventDefault(); setIdx(total - 1); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [go, total]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  }, []);

  const srcDoc = useMemo(() => {
    if (!total) return '';
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<style>${css}\nhtml,body{margin:0;height:100%}`
      + `body{display:flex;align-items:center;justify-content:center;background:#0b0b12}`
      + `.marpit{width:100%;max-height:100%}svg[data-marpit-svg]{display:block;width:100%;height:auto}</style>`
      + `</head><body><div class="marpit">${slides[idx]}</div></body></html>`;
  }, [slides, css, idx, total]);

  if (error || !total) {
    return <div className="marp-deck-empty">Could not render this Marp deck{error ? `: ${error}` : ''}.</div>;
  }

  return (
    <div className="marp-deck" ref={rootRef} tabIndex={0}>
      <div className="marp-deck-stage">
        <iframe
          className="marp-deck-frame"
          title="Marp slide"
          sandbox=""
          srcDoc={srcDoc}
        />
      </div>
      <div className="marp-deck-controls">
        <button type="button" onClick={() => go(-1)} disabled={idx === 0} aria-label="Previous slide">‹</button>
        <span className="marp-deck-counter">{idx + 1} / {total}</span>
        <button type="button" onClick={() => go(1)} disabled={idx === total - 1} aria-label="Next slide">›</button>
        <button type="button" className="marp-deck-fs" onClick={toggleFullscreen} aria-label="Toggle fullscreen">⛶</button>
      </div>
    </div>
  );
}
