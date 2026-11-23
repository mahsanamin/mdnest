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
vi.mock('../api.js', () => ({
  listPages: vi.fn(() => Promise.resolve(list.value)),
  getPagePass: vi.fn(() => Promise.resolve(pass.value)),
  deleteUnlinkedPage: vi.fn(() => Promise.resolve()),
}));

const { PageView, PagesList } = await import('../components/Pages.jsx');
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

describe('PagesList', () => {
  it('lists titles as text, never as HTML, and opens the handle path', async () => {
    list.value = { pages: [{ path: 'Proj/q3.page.md', title: 'Q3 <b>report</b>', author: 'ana', publishedAt: '2026-11-20T10:00:00Z' }] };
    const onOpen = vi.fn();
    await act(async () => { root.render(<PagesList ns="alpha" onOpen={onOpen} />); });
    const row = host.querySelector('[data-testid="page-row-Proj/q3.page.md"]');
    expect(row.textContent).toBe('Q3 <b>report</b>');
    expect(row.querySelector('b')).toBeNull();
    await act(async () => { row.click(); });
    expect(onOpen).toHaveBeenCalledWith('Proj/q3.page.md');
    expect(host.querySelector('[data-testid=pages-unlinked]')).toBeNull();
  });

  it('shows the unlinked list only when the server sends it (namespace-root writers)', async () => {
    list.value = { pages: [], unlinked: [{ id: 'abcdefghijklmnopqrstuvwxyz234567', title: 'Orphan', publishedAt: '2026-11-20T10:00:00Z' }] };
    await act(async () => { root.render(<PagesList ns="alpha" onOpen={() => {}} />); });
    const u = host.querySelector('[data-testid=pages-unlinked]');
    expect(u.textContent).toContain('Orphan');
    expect(u.querySelector('button').textContent).toBe('Delete');
  });
});
