// @vitest-environment jsdom
//
// A published page is someone's HTML, so the viewer may only ever show it in
// a sandboxed frame from the server's frame URL. Static mode (no pages
// origin): sandbox with no permissions. Script mode: allow-scripts and
// nothing else, so the page runs in an opaque origin and can neither read
// mdnest's storage nor navigate the window around it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const pass = vi.hoisted(() => ({ value: null }));
const list = vi.hoisted(() => ({ value: { pages: [] } }));
vi.mock('../pagesApi.js', () => ({
  listPages: vi.fn(() => Promise.resolve(list.value)),
  getPagePass: vi.fn(() => Promise.resolve(pass.value)),
  deleteUnlinkedPage: vi.fn(() => Promise.resolve()),
}));

const { PageView, PagesView } = await import('../components/Pages.jsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host, root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function renderView(frame) {
  pass.value = frame;
  await act(async () => {
    root.render(<PageView ns="alpha" path="Proj/q3.page.md" />);
  });
  return host.querySelector('iframe');
}

describe('PageView frame', () => {
  it('static mode: sandboxed with no permissions at all', async () => {
    const f = await renderView({ url: '/api/pages/view/PASS/', scripts: false, title: 'Q3', author: 'ana', publishedAt: '2026-11-20T10:00:00Z' });
    expect(f.getAttribute('src')).toBe('/api/pages/view/PASS/');
    expect(f.hasAttribute('sandbox')).toBe(true);
    expect(f.getAttribute('sandbox')).toBe('');
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(host.textContent).toContain('scripts off');
  });

  it('script mode: allow-scripts and nothing else', async () => {
    const f = await renderView({ url: 'https://pages.example.com/PASS/', scripts: true });
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    for (const bad of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms']) {
      expect(f.getAttribute('sandbox')).not.toContain(bad);
    }
  });

  it('shows the page bar: a Page badge, title, author and date', async () => {
    await renderView({ url: '/api/pages/view/PASS/', scripts: false, title: 'Q3', author: 'ana', publishedAt: '2026-11-20T10:00:00Z' });
    const bar = host.querySelector('.page-bar');
    expect(bar.textContent).toContain('Page');
    expect(bar.textContent).toContain('Q3');
    expect(bar.textContent).toContain('by ana');
    expect(bar.textContent).toContain('published');
  });
});

describe('PagesView', () => {
  const page = (o) => ({ title: 'T', author: 'ana', publishedAt: '2026-11-20T10:00:00Z', files: 2, ...o });

  it('one card per page: title as text, folder, author, date, file count, description only when there is one', async () => {
    list.value = { pages: [
      page({ path: 'MyTestProject/q3.page.md', title: 'Q3 <b>report</b>', description: 'Revenue by region' }),
      page({ path: 'top.page.md', title: 'Top', description: '' }),
    ] };
    await act(async () => { root.render(<PagesView ns="alpha" onOpen={() => {}} onReveal={() => {}} />); });
    const q3 = host.querySelector('[data-testid="page-card-MyTestProject/q3.page.md"]');
    expect(q3.querySelector('.page-card-title').textContent).toBe('Q3 <b>report</b>');
    expect(q3.querySelector('b')).toBeNull();
    expect(q3.querySelector('.page-card-folder').textContent).toBe('MyTestProject/');
    expect(q3.querySelector('[data-testid=page-card-desc]').textContent).toBe('Revenue by region');
    expect(q3.querySelector('.page-card-meta').textContent).toContain('by ana');
    expect(q3.querySelector('.page-card-meta').textContent).toContain('2 files');
    const top = host.querySelector('[data-testid="page-card-top.page.md"]');
    expect(top.querySelector('[data-testid=page-card-desc]')).toBeNull();
    // No live previews: a card never holds a frame.
    expect(host.querySelector('.pages-view iframe')).toBeNull();
  });

  it('Open opens the handle; the target button reveals it without opening', async () => {
    list.value = { pages: [page({ path: 'P/a.page.md' })] };
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    await act(async () => { root.render(<PagesView ns="alpha" onOpen={onOpen} onReveal={onReveal} />); });
    await act(async () => { host.querySelector('.page-card-locate').click(); });
    expect(onReveal).toHaveBeenCalledWith('P/a.page.md');
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => { host.querySelector('.page-card-open').click(); });
    expect(onOpen).toHaveBeenCalledWith('P/a.page.md');
  });

  it('sorts by newest, title or folder', async () => {
    list.value = { pages: [
      page({ path: 'b/x.page.md', title: 'Alpha', publishedAt: '2026-01-01T00:00:00Z' }),
      page({ path: 'a/y.page.md', title: 'Charlie', publishedAt: '2026-03-01T00:00:00Z' }),
      page({ path: 'c/z.page.md', title: 'bravo', publishedAt: '2026-02-01T00:00:00Z' }),
    ] };
    await act(async () => { root.render(<PagesView ns="alpha" onOpen={() => {}} onReveal={() => {}} />); });
    const order = () => [...host.querySelectorAll('.page-card-title')].map((e) => e.textContent);
    expect(order()).toEqual(['Charlie', 'bravo', 'Alpha']);
    const sel = host.querySelector('[data-testid=pages-sort]');
    const pick = async (v) => { await act(async () => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); }); };
    await pick('title');
    expect(order()).toEqual(['Alpha', 'bravo', 'Charlie']);
    await pick('folder');
    expect(order()).toEqual(['Charlie', 'Alpha', 'bravo']);
  });

  it('the Unlinked tab shows only when the server sends the list (namespace-root writers)', async () => {
    list.value = { pages: [] };
    await act(async () => { root.render(<PagesView ns="alpha" onOpen={() => {}} onReveal={() => {}} />); });
    expect(host.querySelector('[data-testid=pages-unlinked-tab]')).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    list.value = { pages: [], unlinked: [{ id: 'abcdefghijklmnopqrstuvwxyz234567', title: 'Orphan', files: 1, publishedAt: '2026-11-20T10:00:00Z' }] };
    await act(async () => { root.render(<PagesView ns="alpha" onOpen={() => {}} onReveal={() => {}} />); });
    await act(async () => { host.querySelector('[data-testid=pages-unlinked-tab]').click(); });
    const u = host.querySelector('[data-testid=pages-unlinked]');
    expect(u.textContent).toContain('Orphan');
    expect(u.querySelector('.page-card-delete').textContent).toBe('Delete');
  });
});
