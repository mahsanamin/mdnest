// mdnest browser smoke tests — exercise the important user-facing features
// against a disposable full stack (frontend + backend) booted by
// tests/e2e-browser.sh. Covers: login, tree render, opening a note, the preview,
// the lazy-loaded Live (Crepe) editor, the Basic editor, search, and creating a
// note via the UI. Each failure is a real user-visible bug.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
// Seeded by the runner before the browser starts (see tests/e2e-browser.sh).
const SEED_FILE = process.env.MDNEST_SEED_FILE || 'e2e-seed.md';
const SEED_TOKEN = process.env.MDNEST_SEED_TOKEN || 'seedtoken';

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  // The sidebar's namespace label/select appears once authenticated + loaded.
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function openSeedNote(page) {
  const row = page.locator('.tree-label', { hasText: SEED_FILE });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  // Wait for the app to settle on the opened file.
  await expect(page.locator('.toolbar-path')).toContainText(SEED_FILE, { timeout: 20_000 });
}

test('login loads the workspace and its tree', async ({ page }) => {
  await login(page);
  await expect(page.getByText('testing_workspace')).toBeVisible();
  await expect(page.locator('.tree-label', { hasText: SEED_FILE })).toBeVisible({ timeout: 20_000 });
});

test('opening a note shows its content', async ({ page }) => {
  await login(page);
  await openSeedNote(page);
  await expect(page.getByText(SEED_TOKEN, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
});

test('Live (Crepe) editor mounts and renders the note', async ({ page }) => {
  await login(page);
  await openSeedNote(page);
  await page.click('button:has-text("Live")');
  // The lazy ~1.1MB Crepe chunk must load and mount its ProseMirror surface.
  await expect(page.locator('.milkdown, .ProseMirror').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(SEED_TOKEN, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
});

test('Live editor block handle stays inside the pane (not clipped by the sidebar)', async ({ page }) => {
  await login(page);
  await openSeedNote(page);
  await page.click('button:has-text("Live")');
  const pm = page.locator('.ProseMirror').first();
  await expect(pm).toBeVisible({ timeout: 30_000 });

  // Regression: the block-edit handle floats to the LEFT of the hovered block
  // (Crepe's 16px offset + a ~26px grip). With too little ProseMirror left
  // padding it spilled past the pane's left edge and got clipped by
  // `.live-editor-crepe-root { overflow:auto }`, looking hidden behind the tree
  // sidebar. Hover a block, then assert the handle's left edge is not left of
  // the editor pane's left edge.
  const firstBlock = pm.locator('p, li, h1, h2, h3').first();
  await firstBlock.hover();
  const handle = page.locator('.milkdown-block-handle');
  await expect(handle).toBeVisible({ timeout: 10_000 });
  // Give floating-ui a tick to position it.
  await page.waitForTimeout(300);

  const hb = await handle.boundingBox();
  const root = await page.locator('.live-editor-crepe-root').boundingBox();
  expect(hb, 'block handle should have a bounding box').not.toBeNull();
  expect(root, 'crepe root should have a bounding box').not.toBeNull();
  // The handle must sit at or inside the pane's left edge (1px tolerance for
  // sub-pixel rounding). Before the fix this was ~14px negative.
  expect(hb.x).toBeGreaterThanOrEqual(root.x - 1);
});

test('Basic editor shows the note in a textarea', async ({ page }) => {
  await login(page);
  await openSeedNote(page);
  await page.click('button:has-text("Basic")');
  const ta = page.locator('textarea').first();
  await expect(ta).toBeVisible({ timeout: 20_000 });
  await expect(ta).toHaveValue(new RegExp(SEED_TOKEN), { timeout: 20_000 });
});

test('search finds the seeded token', async ({ page }) => {
  await login(page);
  await page.fill('input[placeholder="Search files..."]', SEED_TOKEN);
  await expect(page.getByText(SEED_FILE).first()).toBeVisible({ timeout: 20_000 });
});

test('creating a note via the UI opens it', async ({ page }) => {
  await login(page);
  const name = `e2e-created-${Date.now()}.md`;
  // doCreateNote uses window.prompt for the filename.
  page.once('dialog', (d) => d.accept(name));
  await page.click('button:has-text("+ Note")');
  await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });
});

test('cross-tab: a note created in one tab appears in another without a manual refresh', async ({ context }) => {
  // Two pages in the SAME browser context share a BroadcastChannel (same
  // origin, same browser). Regression for the single-mode bug where a file
  // created in one tab didn't show in another until the 60s poll or a manual
  // Refresh. tab-sync.js broadcasts `tree-changed`; the other tab refreshes.
  const a = await context.newPage();
  await login(a);
  // Tab B is a second page in the SAME context, so it shares localStorage (the
  // JWT) — it's already authenticated, exactly like opening a second browser
  // tab. Just load it; no second login.
  const b = await context.newPage();
  await b.goto('/');
  // Make sure both tabs have loaded the tree before the create.
  await expect(a.locator('.tree-label', { hasText: SEED_FILE })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator('.tree-label', { hasText: SEED_FILE })).toBeVisible({ timeout: 20_000 });

  const name = `xtab-${Date.now()}.md`;
  a.once('dialog', (d) => d.accept(name));
  await a.click('button:has-text("+ Note")');
  await expect(a.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });

  // Tab B must reveal the new note WITHOUT anyone clicking Refresh — purely
  // via the cross-tab broadcast. (The 60s poll would exceed this timeout.)
  await expect(b.locator('.tree-label', { hasText: name })).toBeVisible({ timeout: 15_000 });

  await a.close();
  await b.close();
});

test('Settings → CLI tab has working copy buttons', async ({ page }) => {
  await login(page);
  await page.click('button[title="Settings"]');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.click('.settings-tabs button:has-text("CLI")');
  const copyBtns = page.locator('.settings-copy-btn');
  await expect(copyBtns.first()).toBeVisible();
  // Every command block should have one (install, login, start-using, multi-server).
  expect(await copyBtns.count()).toBeGreaterThanOrEqual(4);
  // Clicking copies and flips the button into its "Copied!" state.
  await copyBtns.first().click();
  await expect(copyBtns.first()).toHaveAttribute('title', 'Copied!');
});
