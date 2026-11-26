// @vitest-environment jsdom
//
// The Pages tab of the right side panel (Chat | Stickies | Pages): only with
// HTML pages on, a compact list that opens a page in the main area and stays
// open, reveals a handle in the tree without opening it, and links into the
// full Pages view (its Unlinked tab only for namespace-root writers).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const list = vi.hoisted(() => ({ value: { pages: [] }, calls: [] }));
vi.mock('../pagesApi.js', () => ({
  listPages: vi.fn((ns, q) => {
    list.calls.push(q || '');
    const all = list.value.pages;
    const pages = q ? all.filter((p) => (p.title + ' ' + (p.text || '')).toLowerCase().includes(q.toLowerCase())) : all;
    return Promise.resolve({ ...list.value, pages });
  }),
  getPagePass: vi.fn(),
  deleteUnlinkedPage: vi.fn(),
}));
vi.mock('../stickies.js', async (orig) => orig());

const { PagesPanel } = await import('../components/Pages.jsx');
const { default: StickiesPanel } = await import('../components/StickiesPanel.jsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host, root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); list.calls = []; });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const pages = [
  { path: 'ProjA/q3.page.md', title: 'Q3 revenue', text: 'revenue by region', publishedAt: '2026-11-20T10:00:00Z', files: 1 },
  { path: 'Finance/budget.page.md', title: 'Budget 2027', text: 'draft budget', publishedAt: '2026-11-21T10:00:00Z', files: 1 },
];

async function renderPanel(props = {}) {
  const calls = { open: vi.fn(), reveal: vi.fn(), full: vi.fn() };
  await act(async () => {
    root.render(<PagesPanel ns="alpha" currentPath={null} onOpen={calls.open} onReveal={calls.reveal} onFullView={calls.full} {...props} />);
  });
  return calls;
}
const row = (p) => host.querySelector(`[data-testid="pages-panel-row-${p}"]`);

describe('side panel views', () => {
  const base = { stickies: [], onChange: () => {}, onClose: () => {}, onExpand: () => {}, saveState: 'saved', loadState: 'ready', onRetry: () => {} };
  const title = () => host.querySelector('[data-testid=side-panel-title]');
  it('has no tab bar: the toolbar switches it, the header names what shows', async () => {
    await act(async () => { root.render(<StickiesPanel {...base} tab="pages" tabs={['chat', 'stickies', 'pages']} onTab={() => {}} chat={<div />} pages={<div data-testid="pages-content" />} />); });
    expect(host.querySelectorAll('[role=tab], [role=tablist]').length).toBe(0);
    expect(title().textContent).toBe('Pages');
    expect(host.querySelector('[data-testid=pages-content]')).not.toBeNull();
    expect(host.querySelector('.stickies-add')).toBeNull();
  });
  it('shows Chat on the chat view and Stickies otherwise', async () => {
    await act(async () => { root.render(<StickiesPanel {...base} tab="chat" tabs={['chat', 'stickies']} onTab={() => {}} chat={<div data-testid="chat-content" />} />); });
    expect(title().textContent).toBe('Chat');
    expect(host.querySelector('[data-testid=chat-content]')).not.toBeNull();
    await act(async () => { root.render(<StickiesPanel {...base} tab="pages" tabs={['chat', 'stickies']} onTab={() => {}} chat={<div />} />); });
    expect(title().textContent).toBe('Stickies'); // pages off: never the Pages view
    expect(host.querySelector('.stickies-add')).not.toBeNull();
  });
});

describe('PagesPanel', () => {
  it('one row per page: title and folder, newest first, the open page highlighted', async () => {
    list.value = { pages };
    await renderPanel({ currentPath: 'ProjA/q3.page.md' });
    expect([...host.querySelectorAll('.pages-panel-title')].map((e) => e.textContent)).toEqual(['Budget 2027', 'Q3 revenue']);
    expect(row('ProjA/q3.page.md').querySelector('.pages-panel-folder').textContent).toBe('ProjA/');
    expect(row('ProjA/q3.page.md').className).toContain('active');
    expect(row('Finance/budget.page.md').className).not.toContain('active');
    expect(host.querySelector('.pages-panel iframe')).toBeNull();
  });

  it('search asks the server and shows what it returns', async () => {
    list.value = { pages };
    vi.useFakeTimers();
    await renderPanel();
    const input = host.querySelector('[data-testid=pages-panel-search]');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, 'region');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    expect(list.calls).toContain('region');
    expect(row('ProjA/q3.page.md')).not.toBeNull();
    expect(row('Finance/budget.page.md')).toBeNull();
  });

  it('the target button reveals without opening; a row opens and the panel stays', async () => {
    list.value = { pages };
    const calls = await renderPanel();
    await act(async () => { row('ProjA/q3.page.md').querySelector('.pages-panel-locate').click(); });
    expect(calls.reveal).toHaveBeenCalledWith('ProjA/q3.page.md');
    expect(calls.open).not.toHaveBeenCalled();
    await act(async () => { row('ProjA/q3.page.md').querySelector('.pages-panel-open').click(); });
    expect(calls.open).toHaveBeenCalledWith('ProjA/q3.page.md');
    expect(host.querySelector('[data-testid=pages-panel]')).not.toBeNull();
  });

  it('links to the full view, and to its Unlinked tab only for root writers', async () => {
    list.value = { pages };
    let calls = await renderPanel();
    expect(host.querySelector('[data-testid=pages-panel-unlinked]')).toBeNull();
    await act(async () => { host.querySelector('[data-testid=pages-panel-full]').click(); });
    expect(calls.full).toHaveBeenCalledWith('pages');
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    list.value = { pages, unlinked: [{ id: 'abcdefghijklmnopqrstuvwxyz234567', title: 'Orphan' }] };
    calls = await renderPanel();
    const link = host.querySelector('[data-testid=pages-panel-unlinked]');
    expect(link.textContent).toBe('Unlinked (1)');
    await act(async () => { link.click(); });
    expect(calls.full).toHaveBeenCalledWith('unlinked');
    expect(host.querySelector('.page-card-delete, .pages-unlinked-delete')).toBeNull();
  });
});
