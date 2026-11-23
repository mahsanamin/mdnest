import { useCallback, useEffect, useState } from 'react';
import { listPages, getPagePass, deleteUnlinkedPage } from '../api.js';
import './Pages.css';

// HTML pages (server: ENABLE_PAGES), loaded as its own chunk only when the
// server has pages on. A page lives in the notes tree as a handle file,
// <name>.page.md; opening the handle shows the page. A page is someone's
// HTML, so it is shown only inside a sandboxed iframe from the server's frame
// URL, never inserted into mdnest's own document. Without a pages origin the
// frame gets no permissions at all (scripts off); with one it gets
// allow-scripts and nothing else. Never add allow-same-origin,
// allow-top-navigation, allow-popups or allow-forms.

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const handleName = (p) => p.split('/').pop().replace(/\.page\.md$/, '');

// The "Pages" section under the notes tree: every page handle in the
// namespace the user can read, and, for writers of the namespace root, the
// pages no handle points to any more.
export function PagesList({ ns, currentPath, onOpen, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);

  const load = useCallback(() => {
    if (!ns) return;
    setError('');
    listPages(ns)
      .then(setData)
      .catch((e) => { setData({ pages: [] }); setError(e.status === 403 ? '' : (e.message || 'Failed to load pages')); });
  }, [ns]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const removeUnlinked = async (p) => {
    if (!window.confirm(`Delete the unlinked page "${p.title || p.id}"? No handle points to it, and this cannot be undone.`)) return;
    try {
      await deleteUnlinkedPage(ns, p.id);
      load();
    } catch (e) {
      window.alert(e.message);
    }
  };

  if (!ns) return null;
  const pages = data?.pages || [];
  const unlinked = data?.unlinked || [];
  return (
    <div className="pages-section" data-testid="pages-section">
      <div className="pages-section-header">
        <button type="button" className="pages-section-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`tree-arrow${open ? ' expanded' : ''}`} aria-hidden="true">▸</span>
          Pages
          {pages.length > 0 && <span className="pages-count">{pages.length}</span>}
        </button>
        <button type="button" className="pages-refresh" onClick={load} title="Refresh pages" aria-label="Refresh pages">↻</button>
      </div>
      {open && (
        <div className="pages-list">
          {data === null && <div className="pages-empty">Loading…</div>}
          {error && <div className="pages-empty">{error}</div>}
          {data && !error && pages.length === 0 && <div className="pages-empty">No pages yet</div>}
          {pages.map((p) => (
            <button
              type="button"
              key={p.path}
              className={`pages-row${p.path === currentPath ? ' active' : ''}${p.missing ? ' missing' : ''}`}
              onClick={() => onOpen(p.path)}
              title={`${p.title || handleName(p.path)}\n${p.path}${p.author ? `\nby ${p.author}` : ''}`}
              data-testid={`page-row-${p.path}`}
            >
              <span className="tree-icon-svg page" aria-hidden="true" />
              <span className="pages-row-title">{p.title || handleName(p.path)}</span>
            </button>
          ))}
          {unlinked.length > 0 && (
            <div className="pages-unlinked" data-testid="pages-unlinked">
              <div className="pages-unlinked-label" title="Pages whose handle file was removed outside mdnest (for example by git sync). Only writers of the whole namespace see this list.">Unlinked</div>
              {unlinked.map((p) => (
                <div key={p.id} className="pages-unlinked-row" data-testid={`unlinked-${p.id}`}>
                  <span className="pages-row-title" title={`${p.title}${p.author ? ` by ${p.author}` : ''}, ${formatDate(p.publishedAt)}`}>{p.title || p.id}</span>
                  <button type="button" className="pages-unlinked-delete" onClick={() => removeUnlinked(p)} aria-label={`Delete unlinked page ${p.title || p.id}`}>Delete</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The page a handle names, full size, under a bar that says what it is.
// Keyed on the handle path: after a move the app passes the new path and the
// view asks for a fresh frame URL.
export function PageView({ ns, path }) {
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setFrame(null);
    setError('');
    getPagePass(ns, path)
      .then((f) => { if (!cancelled) setFrame(f); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to open the page'); });
    return () => { cancelled = true; };
  }, [ns, path]);

  const published = formatDate(frame?.publishedAt);
  return (
    <div className="page-view" data-testid="page-view">
      <div className="page-bar" role="banner">
        <span className="page-badge" title="A published HTML page, not part of mdnest">Page</span>
        <span className="page-bar-title">{frame?.title || handleName(path)}</span>
        <span className="page-bar-meta">
          {frame?.author ? `by ${frame.author}` : ''}
          {frame?.author && published ? ' · ' : ''}
          {published ? `published ${published}` : ''}
          {frame && !frame.scripts ? ' · scripts off' : ''}
        </span>
      </div>
      {error && <div className="page-error" data-testid="page-error">{error}</div>}
      {frame && (
        <iframe
          key={frame.url}
          className="page-frame"
          title={frame.title || handleName(path)}
          src={frame.url}
          sandbox={frame.scripts ? 'allow-scripts' : ''}
          referrerPolicy="no-referrer"
          data-testid="page-frame"
        />
      )}
    </div>
  );
}
