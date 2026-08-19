// A big namespace must stay usable, and you must be able to get out of the
// board again.
//
// Scale: a column used to render every card, so ~12k tasks put >50k nodes in
// the DOM — the board took ~1.8s to open and every keystroke in the filter box
// cost ~456ms. Columns now paint a page at a time; the header count still
// reports the true total, so nothing is hidden silently.
//
// Exit: the board replaces the editor pane. onClose existed but was never
// rendered, so the only way back to your note was the toolbar's Basic/Live
// pair, which says nothing about the board.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function openBoard(page) {
  const btn = page.locator('.toolbar-view-board');
  const ok = await btn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');
  await btn.click();
  await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
}

test('the board offers a visible way back to the note', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  // Open a note first, so there is something to go back to. A namespace can
  // have only folders at its root, so expand one if no file is on screen yet.
  const fileRow = () => page.locator('.tree-row').filter({ has: page.locator('.tree-icon-svg.file') }).first();
  if (!(await fileRow().count())) {
    const folder = page.locator('.tree-row')
      .filter({ has: page.locator('.tree-icon-svg.folder-full, .tree-icon-svg.folder-empty') })
      .filter({ hasNot: page.locator('.tree-root-row') })
      .first();
    await expect(folder).toBeVisible({ timeout: 20_000 });
    await folder.click();
  }
  const file = fileRow();
  await expect(file).toBeVisible({ timeout: 20_000 });
  const name = (await file.locator('.tree-label').innerText()).trim();
  await file.click();
  await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });

  await openBoard(page);

  // The exit is visible, and names where it goes.
  const back = page.locator('.tb-back');
  await expect(back).toBeVisible();
  await expect(back).toContainText(name.split('/').pop());

  await back.click();
  await expect(page.locator('.tb-panel')).toHaveCount(0);
  await expect(page.locator('.toolbar-path')).toContainText(name);
});

test('the Editor half of the view switch returns you to the note', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await openBoard(page);
  await expect(page.locator('.toolbar-view-board')).toHaveAttribute('aria-pressed', 'true');

  // Basic/Live edit the open file, which the board has replaced — so they are
  // hidden rather than left visible and inert.
  await expect(page.locator('.editor-mode-toggle'), 'editor modes should be hidden on the board')
    .toHaveCount(0);
  // Click Editor — the explicit other half, not the same button again.
  await page.locator('.toolbar-view-editor').click();
  await expect(page.locator('.tb-panel')).toHaveCount(0);
  await expect(page.locator('.toolbar-view-board')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.toolbar-view-editor')).toHaveAttribute('aria-pressed', 'true');
  // ...and they come back when the file does.
  await expect(page.locator('.editor-mode-toggle')).toBeVisible();
});

test('a column pages its cards instead of rendering thousands', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await openBoard(page);

  const col = page.locator('.tb-column').filter({ hasNot: page.locator('.collapsed') }).first();
  await expect(col).toBeVisible({ timeout: 20_000 });
  const total = parseInt((await col.locator('.tb-column-count').innerText()).trim(), 10);
  const rendered = await col.locator('.tb-card').count();

  if (total > 100) {
    // Capped, and the excess is offered rather than dropped.
    expect(rendered).toBeLessThanOrEqual(100);
    const more = col.locator('.tb-column-more');
    await expect(more).toBeVisible();
    await expect(more).toContainText('hidden');
    await more.click();
    expect(await col.locator('.tb-card').count()).toBeGreaterThan(rendered);
  } else {
    // Small board: everything shows, and no button appears.
    expect(rendered).toBe(total);
    await expect(col.locator('.tb-column-more')).toHaveCount(0);
  }
  // The header count is always the truth, paged or not.
  expect(total).toBeGreaterThanOrEqual(rendered);
});
