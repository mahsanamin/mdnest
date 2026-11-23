import { useCallback, useEffect, useState } from 'react';
import { listPages, getPagePass } from '../api.js';
import './Pages.css';

// HTML pages (server: ENABLE_PAGES), loaded as its own chunk only when the
// server has pages on. A page is someone's HTML, so it is shown only inside a
// sandboxed iframe from the server's frame URL, never inserted into mdnest's
// own document. Without a pages origin the frame gets no permissions at all
// (scripts off); with one it gets allow-scripts and nothing else. Never add
// allow-same-origin, allow-top-navigation, allow-popups or allow-forms.

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function PagesList({ ns, activeSlug, onOpen, refreshKey }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);

  const load = useCallback(() => {
    if (!ns) return;
    setError('');
    listPages(ns)
      .then(setPages)
      .catch((e) => { setPages([]); setError(e.status === 403 ? '' : (e.message || 'Failed to load pages')); });
  }, [ns]);

  useEffect(() => { setPages(null); load(); }, [load, refreshKey]);

  if (!ns) return null;
  return (
    <div className="pages-section" data-testid="pages-section">
      <div className="pages-section-header">
        <button
          type="button"
          className="pages-section-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={`tree-arrow${open ? ' expanded' : ''}`} aria-hidden="true">▸</span>
          Pages
          {pages && pages.length > 0 && <span className="pages-count">{pages.length}</span>}
        </button>
        <button type="button" className="pages-refresh" onClick={load} title="Refresh pages" aria-label="Refresh pages">↻</button>
      </div>
      {open && (
        <div className="pages-list">
          {pages === null && <div className="pages-empty">Loading…</div>}
          {error && <div className="pages-empty">{error}</div>}
          {pages && !error && pages.length === 0 && <div className="pages-empty">No pages yet</div>}
          {pages && pages.map((p) => (
            <button
              type="button"
              key={p.slug}
              className={`pages-row${p.slug === activeSlug ? ' active' : ''}`}
              onClick={() => onOpen({ ...p, ns })}
              title={`${p.title}${p.author ? ` by ${p.author}` : ''}`}
              data-testid={`page-row-${p.slug}`}
            >
              <span className="pages-row-icon" aria-hidden="true" />
              <span className="pages-row-title">{p.title || p.slug}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PageView({ page, onClose }) {
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setFrame(null);
    setError('');
    getPagePass(page.ns, page.slug)
      .then((f) => { if (!cancelled) setFrame(f); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to open the page'); });
    return () => { cancelled = true; };
  }, [page.ns, page.slug, page.publishedAt]);

  const published = formatDate(page.publishedAt);
  return (
    <div className="page-view" data-testid="page-view">
      <div className="page-bar" role="banner">
        <span className="page-badge" title="A published HTML page, not part of mdnest">Page</span>
        <span className="page-bar-title">{page.title || page.slug}</span>
        <span className="page-bar-meta">
          {page.author ? `by ${page.author}` : ''}
          {page.author && published ? ' · ' : ''}
          {published ? `published ${published}` : ''}
          {frame && !frame.scripts ? ' · scripts off' : ''}
        </span>
        <button type="button" className="page-bar-close" onClick={onClose} aria-label="Close page" title="Close page">×</button>
      </div>
      {error && <div className="page-error">{error}</div>}
      {frame && (
        <iframe
          key={frame.url}
          className="page-frame"
          title={page.title || page.slug}
          src={frame.url}
          sandbox={frame.scripts ? 'allow-scripts' : ''}
          referrerPolicy="no-referrer"
          data-testid="page-frame"
        />
      )}
    </div>
  );
}
