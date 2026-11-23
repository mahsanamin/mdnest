import { useCallback, useEffect, useState } from 'react';
import { listPages, getPagePass, deleteUnlinkedPage } from '../pagesApi.js';
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

const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

const SORTS = {
  newest: (a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.path.localeCompare(b.path),
  title: (a, b) => (a.title || handleName(a.path)).localeCompare(b.title || handleName(b.path), undefined, { sensitivity: 'base' }),
  folder: (a, b) => folderOf(a.path).localeCompare(folderOf(b.path), undefined, { sensitivity: 'base' }) || (a.title || '').localeCompare(b.title || ''),
};

const LOCATE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <line x1="12" y1="2" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="2" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="22" y2="12" />
  </svg>
);

// The Pages view (toolbar "Pages" button): a card for every page in the
// namespace the user can read. No live previews on purpose: opening this
// view never runs a page's scripts. Writers of the namespace root also get an
// Unlinked tab, for pages whose handle was removed outside mdnest.
export function PagesView({ ns, onOpen, onReveal, initialTab = 'pages' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [tab, setTab] = useState(initialTab);

  const load = useCallback((q) => {
    if (!ns) return;
    setError('');
    listPages(ns, q)
      .then(setData)
      .catch((e) => { setData({ pages: [] }); setError(e.message || 'Failed to load pages'); });
  }, [ns]);

  // The search runs on the server, over the stored text, title and
  // description; a short pause keeps it from running on every key.
  useEffect(() => {
    const q = query.trim();
    if (!q) { load(''); return undefined; }
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [load, query]);

  const removeUnlinked = async (p) => {
    if (!window.confirm(`Delete the unlinked page "${p.title || p.id}"? No handle points to it, and this cannot be undone.`)) return;
    try {
      await deleteUnlinkedPage(ns, p.id);
      load(query.trim());
    } catch (e) {
      window.alert(e.message);
    }
  };

  const pages = [...(data?.pages || [])].sort(SORTS[sort]);
  const unlinked = data?.unlinked;
  const showUnlinked = tab === 'unlinked' && Array.isArray(unlinked);
  return (
    <div className="pages-view" data-testid="pages-view">
      <div className="pages-view-head">
        <div className="pages-view-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!showUnlinked} className={!showUnlinked ? 'active' : ''} onClick={() => setTab('pages')}>
            Pages{data ? ` (${pages.length})` : ''}
          </button>
          {Array.isArray(unlinked) && (
            <button type="button" role="tab" aria-selected={showUnlinked} className={showUnlinked ? 'active' : ''} onClick={() => setTab('unlinked')} data-testid="pages-unlinked-tab"
              title="Pages whose handle file was removed outside mdnest (for example by git sync). Only writers of the whole namespace see this.">
              Unlinked ({unlinked.length})
            </button>
          )}
        </div>
        {!showUnlinked && (
          <div className="pages-view-tools">
            <input type="search" className="pages-view-search" placeholder="Search pages" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search pages" data-testid="pages-search" />
            <select className="pages-view-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort pages" data-testid="pages-sort">
              <option value="newest">Newest</option>
              <option value="title">Title</option>
              <option value="folder">Folder</option>
            </select>
          </div>
        )}
      </div>
      {error && <div className="pages-view-empty">{error}</div>}
      {data === null && <div className="pages-view-empty">Loading...</div>}
      {!showUnlinked && data && !error && pages.length === 0 && (
        <div className="pages-view-empty">{query ? 'No pages match.' : 'No pages yet. Drop an .html file on a folder, or use mdnest page publish.'}</div>
      )}
      {!showUnlinked && (
        <div className="pages-grid">
          {pages.map((p) => (
            <div key={p.path} className={`page-card${p.missing ? ' missing' : ''}`} data-testid={`page-card-${p.path}`}>
              <div className="page-card-title">
                <span className="tree-icon-svg page" aria-hidden="true" />
                <span>{p.title || handleName(p.path)}</span>
              </div>
              <div className="page-card-folder" title={p.path}>{folderOf(p.path) || '/'}</div>
              {p.description && <div className="page-card-desc" data-testid="page-card-desc">{p.description}</div>}
              <div className="page-card-meta">
                {p.missing ? 'Not in this namespace' : [p.author && `by ${p.author}`, formatDate(p.publishedAt), `${p.files} file${p.files === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
              </div>
              <div className="page-card-actions">
                <button type="button" className="page-card-open" onClick={() => onOpen(p.path)}>Open</button>
                <button type="button" className="page-card-locate" onClick={() => onReveal(p.path)} title="Show in tree" aria-label={`Show ${p.path} in the tree`}>{LOCATE_ICON}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showUnlinked && (
        <div className="pages-grid" data-testid="pages-unlinked">
          {unlinked.length === 0 && <div className="pages-view-empty">No unlinked pages.</div>}
          {unlinked.map((p) => (
            <div key={p.id} className="page-card unlinked" data-testid={`unlinked-${p.id}`}>
              <div className="page-card-title"><span>{p.title || p.id}</span></div>
              {p.description && <div className="page-card-desc">{p.description}</div>}
              <div className="page-card-meta">{[p.author && `by ${p.author}`, formatDate(p.publishedAt), `${p.files} file${p.files === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>
              <div className="page-card-actions">
                <button type="button" className="page-card-delete" onClick={() => removeUnlinked(p)} aria-label={`Delete unlinked page ${p.title || p.id}`}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The Pages tab of the right side panel: a compact list for working beside
// notes. Clicking a row opens the HTML page in the main area and leaves the
// panel open, so pages can be flipped through quickly. No delete here; the
// unlinked pages are only a link into the full view (root writers only).
export function PagesPanel({ ns, currentPath, refreshKey, onOpen, onReveal, onFullView }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback((q) => {
    if (!ns) return;
    setError('');
    listPages(ns, q)
      .then(setData)
      .catch((e) => { setData({ pages: [] }); setError(e.message || 'Failed to load pages'); });
  }, [ns]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { load(''); return undefined; }
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [load, query, refreshKey]);

  const pages = [...(data?.pages || [])].sort(SORTS.newest);
  const unlinked = data?.unlinked;
  return (
    <div className="pages-panel" data-testid="pages-panel">
      <input type="search" className="pages-view-search pages-panel-search" placeholder="Search pages" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search pages" data-testid="pages-panel-search" />
      <div className="pages-panel-list">
        {data === null && <div className="pages-view-empty">Loading...</div>}
        {error && <div className="pages-view-empty">{error}</div>}
        {data && !error && pages.length === 0 && <div className="pages-view-empty">{query ? 'No pages match.' : 'No pages yet.'}</div>}
        {pages.map((p) => (
          <div key={p.path} className={`pages-panel-row${p.path === currentPath ? ' active' : ''}`} data-testid={`pages-panel-row-${p.path}`}>
            <button type="button" className="pages-panel-open" onClick={() => onOpen(p.path)} title={`${p.title || handleName(p.path)}\n${p.path}`}>
              <span className="tree-icon-svg page" aria-hidden="true" />
              <span className="pages-panel-text">
                <span className="pages-panel-title">{p.title || handleName(p.path)}</span>
                <span className="pages-panel-folder">{folderOf(p.path) || '/'}</span>
              </span>
            </button>
            <button type="button" className="pages-panel-locate" onClick={() => onReveal(p.path)} title="Show in tree" aria-label={`Show ${p.path} in the tree`}>{LOCATE_ICON}</button>
          </div>
        ))}
      </div>
      <div className="pages-panel-foot">
        <button type="button" className="pages-panel-link" onClick={() => onFullView('pages')} data-testid="pages-panel-full">Open full view</button>
        {Array.isArray(unlinked) && unlinked.length > 0 && (
          <button type="button" className="pages-panel-link" onClick={() => onFullView('unlinked')} data-testid="pages-panel-unlinked">Unlinked ({unlinked.length})</button>
        )}
      </div>
    </div>
  );
}

// Asks for a fresh frame URL when the handle path changes (a move) and when
// the handle names another page id (a republish, which always makes a new id;
// pageId comes from the open handle's text).
export function PageView({ ns, path, pageId }) {
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
  }, [ns, path, pageId]);

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
