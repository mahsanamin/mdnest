// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const api = vi.hoisted(() => ({ export: vi.fn(), import: vi.fn() }));
vi.mock('../pagesApi.js', () => ({
  listPages: vi.fn(async () => ({ pages: [] })), getPagePass: vi.fn(), deleteUnlinkedPage: vi.fn(),
  exportPages: api.export, importPages: api.import,
}));
vi.mock('../api.js', () => ({
  changePassword: vi.fn(), listTokens: vi.fn(async () => []), createToken: vi.fn(), revokeToken: vi.fn(),
  restartServer: vi.fn(), readBootId: vi.fn(), waitForRestart: vi.fn(),
  getWorkspaceStatus: vi.fn(async () => ({})), getMyGitBackup: vi.fn(), saveMyGitBackup: vi.fn(), turnOffMyGitBackup: vi.fn(),
}));
vi.mock('../components/AdminGit.jsx', () => ({ SyncState: () => null, RepoFields: () => null, repoPayload: (v) => v }));

const { PagesSettings, PagesPanel, PagesView } = await import('../components/Pages.jsx');
const { default: Settings } = await import('../components/Settings.jsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.export.mockReset(); api.import.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const button = (text) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
async function render(props = {}) {
  await act(async () => { root.render(<PagesSettings ns="alpha" canManage inGit {...props} />); });
}
async function pickFile() {
  const input = host.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['archive'], 'pages.tgz')] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('Pages settings', () => {
  it('shows the tab only with pages on', async () => {
    await act(async () => { root.render(<Settings onClose={() => {}} />); });
    expect(button('Pages')).toBeUndefined();
    await act(async () => { root.render(<Settings onClose={() => {}} pages={{ enabled: true, inGit: true }} namespace="alpha" canManagePages />); });
    await act(async () => { button('Pages').click(); });
    expect(host.querySelector('[data-testid=settings-pages]')).not.toBeNull();
    expect(host.textContent).toContain('saved with your notes in git');
  });
  it('one storage sentence and two disabled actions without whole-namespace write', async () => {
    await render({ inGit: false, canManage: false });
    expect(host.textContent).toContain('kept apart from your notes');
    expect(button('Download all pages').disabled).toBe(true);
    expect(button('Restore pages').disabled).toBe(true);
    expect(host.querySelector('[role=status]').textContent).toContain('whole namespace');
  });
  it('downloads the current namespace and reports missing pages', async () => {
    vi.useFakeTimers();
    const make = vi.fn(() => 'blob:pages');
    const old = URL.createObjectURL; URL.createObjectURL = make;
    const oldRevoke = URL.revokeObjectURL; URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    api.export.mockResolvedValue({ blob: new Blob(['archive']), exported: 12, skipped: 2 });
    try {
      await render();
      await act(async () => { button('Download all pages').click(); });
      expect(api.export).toHaveBeenCalledWith('alpha');
      expect(make).toHaveBeenCalledOnce();
      expect(host.querySelector('[role=status]').textContent).toContain('Downloaded 12 pages, 2 skipped: files missing');
    } finally { vi.runOnlyPendingTimers(); vi.useRealTimers(); URL.createObjectURL = old; URL.revokeObjectURL = oldRevoke; }
  });
  it('restores a file, reports note conflicts, and refreshes the tree', async () => {
    const refreshed = vi.fn();
    api.import.mockResolvedValue({ restored: 1, skipped: 1, results: [{ path: 'ordinary.page.md', status: 'skipped', reason: 'ordinary.page.md exists and is not a page handle; choose another name' }] });
    await render({ onRestored: refreshed });
    await pickFile();
    expect(api.import).toHaveBeenCalledWith('alpha', expect.any(File));
    expect(refreshed).toHaveBeenCalledOnce();
    expect(host.querySelector('[role=status]').textContent).toBe('Restored 1 page, 1 skipped: ordinary notes already exist.');
  });
  it('does not restore after cancel, and shows an archive error inline', async () => {
    await render();
    window.confirm.mockReturnValueOnce(false);
    await pickFile(); expect(api.import).not.toHaveBeenCalled();
    api.import.mockRejectedValue(new Error('invalid archive path'));
    await pickFile();
    expect(host.querySelector('[role=alert]').textContent).toBe('invalid archive path');
    expect(button('Restore pages').disabled).toBe(false);
  });
  it('does not allow a second action while a restore runs', async () => {
    let finish;
    api.import.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render(); await pickFile();
    expect(button('Restoring...').disabled).toBe(true);
    expect(button('Download all pages').disabled).toBe(true);
    await act(async () => { finish({ restored: 0, skipped: 0 }); });
  });
  it('does not refresh an old namespace after Settings is closed', async () => {
    let finish;
    const refreshed = vi.fn();
    api.import.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render({ onRestored: refreshed }); await pickFile();
    await act(async () => { root.render(<div />); });
    await act(async () => { finish({ restored: 1, skipped: 0 }); });
    expect(refreshed).not.toHaveBeenCalled();
  });
  it('uses the git storage note in the full view and side panel', async () => {
    await act(async () => { root.render(<PagesView ns="alpha" inGit onOpen={() => {}} onReveal={() => {}} />); });
    expect(host.querySelector('[data-testid=pages-storage-note]').textContent).toContain('saved with your notes in git');
    await act(async () => { root.render(<PagesPanel ns="alpha" inGit onOpen={() => {}} onReveal={() => {}} />); });
    expect(host.querySelector('[data-testid=pages-panel-storage-note]').textContent).toContain('saved with your notes in git');
  });
});
