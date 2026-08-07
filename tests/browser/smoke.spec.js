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

test('build-details popover closes on an outside click', async ({ page }) => {
  await login(page);
  // Open the ⓘ build-details popover in the sidebar footer.
  await page.click('.version-info-btn');
  await expect(page.locator('.version-info-popover')).toBeVisible();
  // Regression: clicking anywhere outside should close it (previously you had
  // to click the ⓘ again). Click a neutral spot in the sidebar.
  await page.locator('.sidebar-header, .sidebar-tree, .toolbar').first().click();
  await expect(page.locator('.version-info-popover')).toBeHidden();
});

test('reveal-in-tree button keeps the active file visible', async ({ page }) => {
  await login(page);
  await openSeedNote(page);
  // The toolbar "reveal in tree" button should exist for an open file and,
  // when clicked, leave the active tree row on-screen (scrolled into view).
  const reveal = page.locator('.toolbar-inline-reveal');
  await expect(reveal).toBeVisible();
  await reveal.click();
  await expect(page.locator('.tree-row.active')).toBeVisible();
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

// Regression guard for the sanitizer/mermaid interaction (v3.11.7). Mermaid
// renders flowchart node labels inside <foreignObject>, which is absent from
// DOMPurify's svg allow-list — sanitizing rendered SVG with the bare profile
// kept the node boxes but silently deleted every label. The unit tests in
// frontend/src/__tests__/sanitize.test.js pin the sanitizer config; this pins
// the thing a user actually sees, against real mermaid output in a real browser.
test('mermaid diagram renders its node labels (not empty boxes)', async ({ page }) => {
  const file = process.env.MDNEST_MERMAID_FILE || 'e2e-mermaid.md';
  const label = process.env.MDNEST_MERMAID_LABEL || 'zzmlabel';

  await login(page);
  const row = page.locator('.tree-label', { hasText: file });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });

  // sanitizeSvg() runs on the Preview render path, so switch to Preview only.
  await page.click('button[title="Preview only"]');

  // Preview renders mermaid asynchronously, wrapping each SVG in .mermaid-container.
  const svg = page.locator('.mermaid-container svg').first();
  await expect(svg).toBeVisible({ timeout: 30_000 });

  // The diagram drew shapes...
  expect(await svg.locator('rect, polygon, path').count()).toBeGreaterThan(0);
  // ...and the label text survived sanitization. Mermaid puts flowchart labels
  // in <foreignObject>; if the sanitizer strips that, the shapes above still
  // pass but every label is gone — which is exactly the regression this guards.
  await expect(svg.getByText(label, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
});

// A write that never went through the API must still show up in the sidebar on
// its own. `tree-changed` is broadcast from the backend's mutating-HTTP wrapper,
// so it only fires for API writes — git-sync pulling another machine's commits,
// or anything touching the notes directory directly, produces no event at all.
// The tree poll is the only thing that notices, which is why it now runs
// unconditionally (see frontend/src/tree-refresh.js). This writes straight into
// the mounted notes directory, bypassing the API exactly as git-sync does, and
// never touches the Refresh button.
test('a file created outside the API appears without a manual refresh', async ({ page }) => {
  const notesDir = process.env.MDNEST_NOTES_DIR;
  test.skip(!notesDir, 'MDNEST_NOTES_DIR not provided by the runner');
  // The poll interval is 30s, so this test outlives the 45s suite default.
  test.setTimeout(120_000);

  const fs = await import('node:fs');
  const path = await import('node:path');
  const name = `e2e-oob-${Date.now()}.md`;

  await login(page);
  // Be sure the tree has loaded once before the out-of-band write, so passing
  // can't be an artifact of the initial load happening to come second.
  await expect(page.locator('.tree-label').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.tree-label', { hasText: name })).toHaveCount(0);

  fs.writeFileSync(
    path.join(notesDir, 'testing_workspace', name),
    '# Out of band\n\nWritten straight to disk, as git-sync would.\n',
  );

  // No clicking Refresh. Under the 60s-and-only-without-collab poll this fails;
  // with the unconditional 30s poll it lands well inside the window.
  await expect(page.locator('.tree-label', { hasText: name })).toBeVisible({ timeout: 50_000 });
});

// Diagram text must be copyable. Dragging a selection across an SVG is
// unreliable, and the fullscreen viewer made it impossible outright: the canvas
// was `user-select: none` and every mousedown started a pan. The rule meant to
// keep inline preview labels selectable had also been hanging off
// `.mermaid-clickable`, a class nothing has applied since click-anywhere-to-
// expand was replaced by the expand button — so it matched nothing at all.
test('mermaid diagram text can be copied from the preview and the viewer', async ({ page, context }) => {
  const file = process.env.MDNEST_MERMAID_FILE || 'e2e-mermaid.md';
  const label = process.env.MDNEST_MERMAID_LABEL || 'zzmlabel';
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await login(page);
  const row = page.locator('.tree-label', { hasText: file });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
  await page.click('button[title="Preview only"]');

  const container = page.locator('.mermaid-container').first();
  await expect(container.locator('svg')).toBeVisible({ timeout: 30_000 });

  // Inline preview: the hover-revealed copy button puts the labels on the clipboard.
  await container.hover();
  const copyBtn = container.locator('.mermaid-copy-btn');
  await expect(copyBtn).toBeVisible({ timeout: 10_000 });
  await copyBtn.click();
  await expect(copyBtn).toHaveText('Copied!');
  let clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(label);
  expect(clip).toContain('Second Node');

  // Labels are also selectable, which is what the dead CSS was supposed to do.
  const selectable = await container.locator('svg text, svg foreignObject').first()
    .evaluate((el) => getComputedStyle(el).userSelect);
  expect(selectable).not.toBe('none');

  // Fullscreen viewer: same text, via its own toolbar button.
  await container.locator('.mermaid-expand-btn').click();
  const viewer = page.locator('.mermaid-viewer');
  await expect(viewer).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => navigator.clipboard.writeText('cleared'));
  await viewer.locator('.mermaid-viewer-copy').click();
  await expect(viewer.locator('.mermaid-viewer-copy')).toHaveText('Copied!');
  clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(label);
});
