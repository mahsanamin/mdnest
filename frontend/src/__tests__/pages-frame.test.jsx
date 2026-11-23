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
vi.mock('../api.js', () => ({
  listPages: vi.fn(() => Promise.resolve([{ slug: 'q3', title: 'Q3 <b>report</b>', author: 'ana', publishedAt: '2026-11-20T10:00:00Z' }])),
  getPagePass: vi.fn(() => Promise.resolve(pass.value)),
}));

const { PageView, PagesList } = await import('../components/Pages.jsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host, root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function renderView(frame) {
  pass.value = frame;
  await act(async () => {
    root.render(<PageView page={{ ns: 'alpha', slug: 'q3', title: 'Q3', author: 'ana', publishedAt: '2026-11-20T10:00:00Z' }} onClose={() => {}} />);
  });
  return host.querySelector('iframe');
}

describe('PageView frame', () => {
  it('static mode: sandboxed with no permissions at all', async () => {
    const f = await renderView({ url: '/api/pages/view/PASS/', scripts: false });
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
    await renderView({ url: '/api/pages/view/PASS/', scripts: false });
    const bar = host.querySelector('.page-bar');
    expect(bar.textContent).toContain('Page');
    expect(bar.textContent).toContain('Q3');
    expect(bar.textContent).toContain('by ana');
    expect(bar.textContent).toContain('published');
  });
});

describe('PagesList', () => {
  it('lists titles as text, never as HTML', async () => {
    await act(async () => { root.render(<PagesList ns="alpha" onOpen={() => {}} />); });
    const row = host.querySelector('[data-testid=page-row-q3]');
    expect(row.textContent).toBe('Q3 <b>report</b>');
    expect(row.querySelector('b')).toBeNull();
  });
});
