// A drawing opens in the app's theme, and the per-drawing override works.
//
// Behaviour changed in v4.3.0. The canvas used to keep its own theme in
// localStorage, because before there was an app theme it had nowhere else to
// look. Now it follows the app, and the toggle is an override of that rather
// than an independent setting — deliberately NOT persisted, since a remembered
// override would leave drawings stuck dark after a switch to light mode with
// nothing on screen explaining why.
//
// Theme is still a viewing preference and is still never written into the
// note: the .excalidraw.md stays portable and two people can view one drawing
// differently.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

test('a drawing follows the app theme, and the override is per-view', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);

  const drawingBtn = page.locator('button:has-text("+ Drawing")');
  if (!(await drawingBtn.count())) test.skip(true, 'drawings disabled (ENABLE_EXCALIDRAW)');
  const name = `theme-${Date.now()}`;
  page.once('dialog', (d) => d.accept(name));
  await drawingBtn.click();

  const canvas = page.locator('.excalidraw').first();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });

  // The config emulates a dark OS and no preference is stored, so the app —
  // and therefore the canvas — is dark.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(canvas).toHaveClass(/theme--dark/);

  // It must not sit on top of Excalidraw's own chrome. The first attempt at
  // this control was absolutely positioned bottom-right and landed exactly on
  // their help button; it now lives in their Footer slot, which they lay out.
  const toggleBox = await page.locator('.excalidraw-theme-toggle').boundingBox();
  for (const other of ['.help-icon', '.disable-zen-mode']) {
    const el = page.locator(other).first();
    if (!(await el.count())) continue;
    const b = await el.boundingBox();
    if (!b) continue;
    const overlaps = toggleBox.x < b.x + b.width && b.x < toggleBox.x + toggleBox.width
      && toggleBox.y < b.y + b.height && b.y < toggleBox.y + toggleBox.height;
    expect(overlaps, `theme toggle overlaps ${other}`).toBe(false);
  }
  await expect(page.locator('.excalidraw-theme-toggle')).toBeVisible();

  // The override flips this drawing only...
  await page.locator('.excalidraw-theme-toggle').click();
  await expect(canvas).not.toHaveClass(/theme--dark/);
  // ...and leaves the app alone. It is a view of one drawing, not a setting.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // ...and it does not survive a reload: the drawing goes back to following
  // the app. This is the assertion that inverted in v4.3.0.
  await page.reload();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.excalidraw').first()).toHaveClass(/theme--dark/);

  // The note itself must not have gained a theme field.
  const body = await page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    const ns = hash.split('/')[0];
    const p = hash.slice(ns.length + 1);
    const r = await fetch(`/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(p)}`,
      { headers: { Authorization: 'Bearer ' + t } });
    return r.text();
  });
  expect(body).not.toContain('"theme"');
});

test('a drawing opens light when the app is light', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page);

  const drawingBtn = page.locator('button:has-text("+ Drawing")');
  if (!(await drawingBtn.count())) test.skip(true, 'drawings disabled (ENABLE_EXCALIDRAW)');
  page.once('dialog', (d) => d.accept(`theme-light-${Date.now()}`));
  await drawingBtn.click();

  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.excalidraw').first()).not.toHaveClass(/theme--dark/);
});
