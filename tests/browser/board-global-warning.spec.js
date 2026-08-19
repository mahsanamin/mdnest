// "All workspaces" reads every note in every workspace the user can see, so it
// warns first — and remembers if you tell it not to.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

async function openBoard(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  const btn = page.locator('.sidebar-board-btn');
  const ok = await btn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');
  await btn.click();
  await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
}

test('All workspaces warns first, and Cancel does not switch scope', async ({ page }) => {
  test.setTimeout(120_000);
  await openBoard(page);
  const all = page.locator('.tb-scope-toggle button, .tb-header-left button').filter({ hasText: 'All workspaces' }).first();
  if (!(await all.count())) test.skip(true, 'no All-workspaces control');

  await all.click();
  const modal = page.locator('.tb-modal', { hasText: 'Search every workspace?' });
  await expect(modal).toBeVisible();

  await modal.locator('button', { hasText: 'Cancel' }).click();
  await expect(modal).toHaveCount(0);
  await expect(all, 'cancelling should leave the scope alone').not.toHaveClass(/active/);
});

test('the warning can be dismissed for good and stays dismissed', async ({ page }) => {
  test.setTimeout(120_000);
  await openBoard(page);
  const all = page.locator('.tb-scope-toggle button, .tb-header-left button').filter({ hasText: 'All workspaces' }).first();
  if (!(await all.count())) test.skip(true, 'no All-workspaces control');

  await all.click();
  const modal = page.locator('.tb-modal', { hasText: 'Search every workspace?' });
  await expect(modal).toBeVisible();
  await modal.locator('.tb-modal-check input').check();
  await modal.locator('button', { hasText: 'Search all workspaces' }).click();
  await expect(modal).toHaveCount(0);
  await expect(all).toHaveClass(/active/);

  // Persisted, so it survives a reload — and the scope switches straight away.
  expect(await page.evaluate(() => localStorage.getItem('mdnest_taskboard_skip_global_warning'))).toBe('1');
  await page.reload();
  // The board is view state, not persisted — reopen it after the reload.
  await page.locator('.sidebar-board-btn').click();
  await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
  const all2 = page.locator('.tb-header-left button').filter({ hasText: 'All workspaces' }).first();
  await page.locator('.tb-header-left button').filter({ hasText: 'Workspace' }).first().click();
  await all2.click();
  await expect(page.locator('.tb-modal', { hasText: 'Search every workspace?' }), 'the warning came back')
    .toHaveCount(0);
  await expect(all2).toHaveClass(/active/);
});

test('the columns editor dialog still renders at its own size', async ({ page }) => {
  // The confirmation reuses the shared .tb-modal shell; an earlier version
  // redefined it and would have shrunk this dialog and lowered its z-index.
  test.setTimeout(120_000);
  await openBoard(page);
  const cols = page.locator('button', { hasText: 'Columns' }).first();
  if (!(await cols.count())) test.skip(true, 'columns editor not available');
  await cols.click();
  const modal = page.locator('.tb-modal').first();
  await expect(modal).toBeVisible();
  const box = await modal.boundingBox();
  expect(box.width, 'the shared modal shell was resized by the new dialog').toBeGreaterThan(430);
  const z = await page.locator('.tb-modal-backdrop').first().evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(z)).toBeGreaterThan(100);
});
