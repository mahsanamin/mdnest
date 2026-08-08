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
import { slideStarts } from '../marp.js';
import { getMarpThemes } from '../api.js';
import { exportHtml } from '../marpExport.js';
import './MarpDeck.css';

// Centralized Marp themes are fetched once and shared across every deck (a
// global catalog, not scoped to any namespace). The admin theme editor calls
// clearMarpThemeCache() after a change so the next deck render picks it up.
let themeCache = null;
let themePromise = null;

export function clearMarpThemeCache() {
  themeCache = null;
  themePromise = null;
}

function loadThemes() {
  if (themeCache) return Promise.resolve(themeCache);
  if (!themePromise) {
    themePromise = getMarpThemes()
      .then((t) => { themeCache = Array.isArray(t) ? t : []; return themeCache; })
      .catch(() => { themeCache = []; return themeCache; });
  }
  return themePromise;
}

// render turns the note into per-slide HTML fragments + the theme CSS. The
// centralized themes are registered into the engine first, so a deck can select
// one with `theme: <name>` instead of embedding a per-deck style block.
function render(content, themes) {
  const marp = new Marp({ html: true, script: false });
  for (const t of themes || []) {
    try { marp.themeSet.add(t.css); } catch { /* skip a malformed theme */ }
  }
  const { html, css } = marp.render(content);
  // Marp emits one <svg data-marpit-svg> per slide inside a .marpit wrapper.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll('svg[data-marpit-svg]');
  const slides = Array.from(nodes).map((n) => n.outerHTML);
  return { slides: slides.length ? slides : [html], css };
}

// slideStarts returns, from Marp source, the 0-based source line at which each
// slide begins, plus the total line count. It powers scroll-sync: an even
// scrollPct → slide split breaks the moment content isn't evenly distributed —
// a large YAML frontmatter with a `style:` block, or one long slide, throws the
// mapping off. Instead we anchor to where slides *actually* begin;
// see marp.js for the exact rules.

export default function MarpDeck({ content, scrollPct, title }) {
  // Centralized themes load asynchronously; until then we render with the
  // built-in themes only (a deck that selects a custom theme falls back to
  // `default` for one frame, then re-renders once the catalog arrives).
  const [themes, setThemes] = useState(() => themeCache || []);
  useEffect(() => {
    let cancelled = false;
    loadThemes().then((t) => { if (!cancelled) setThemes(t); });
    return () => { cancelled = true; };
  }, []);

  const { slides, css, error } = useMemo(() => {
    try {
      return render(content, themes);
    } catch (e) {
      return { slides: [], css: '', error: e.message };
    }
  }, [content, themes]);

  const total = slides.length;
  const [idx, setIdx] = useState(0);
  const clamp = useCallback((i) => Math.max(0, Math.min(total - 1, i)), [total]);
  useEffect(() => { setIdx((i) => clamp(i)); }, [total, clamp]);

  // Source line where each slide begins, used to map the editor position to a
  // slide by *where the breaks really are* rather than an even split.
  const { starts, totalLines } = useMemo(() => slideStarts(content), [content]);

  // Follow the editor's position in split view: the deck isn't scrollable, so
  // the parent hands us the editor's 0..1 scroll ratio. We turn that ratio into
  // a source line and pick the slide whose range contains it — this keeps the
  // deck aligned even with a huge frontmatter/style block or an uneven slide at
  // the top. Manual navigation (arrows/keys/buttons) still works; the next
  // editor scroll re-syncs. Ignored when the parent passes nothing (fullscreen,
  // mobile, or preview-only where there is no editor to track).
  useEffect(() => {
    if (typeof scrollPct !== 'number' || total <= 1) return;
    const line = scrollPct * Math.max(0, totalLines - 1);
    let s = 0;
    while (s + 1 < starts.length && starts[s + 1] <= line) s++;
    setIdx(clamp(s));
  }, [scrollPct, total, clamp, starts, totalLines]);

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

  const [exporting, setExporting] = useState('');
  const doExport = useCallback(async () => {
    if (exporting) return;
    setExporting('html');
    try {
      await exportHtml(content, themes, title);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Marp export failed:', e);
    } finally {
      setExporting('');
    }
  }, [content, themes, title, exporting]);

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
        <button type="button" className="marp-deck-export" onClick={() => doExport()} disabled={!!exporting} title="Export as a standalone Marp presentation (navigation, fullscreen, presenter)">{exporting ? '…' : 'HTML'}</button>
        <button type="button" className="marp-deck-fs" onClick={toggleFullscreen} aria-label="Toggle fullscreen">⛶</button>
      </div>
    </div>
  );
}
