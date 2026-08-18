// A drawing opens dark, matching the app, and the choice sticks.
//
// The canvas used to render as a white sheet in the middle of a dark UI. Theme
// is a viewing preference, so it lives in localStorage and is deliberately NOT
// written into the note — the .excalidraw.md stays portable and two people can
// view the same drawing with different themes.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

test('a drawing opens in dark mode and can be switched to light', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });

  const drawingBtn = page.locator('button:has-text("+ Drawing")');
  if (!(await drawingBtn.count())) test.skip(true, 'drawings disabled (ENABLE_EXCALIDRAW)');
  const name = `theme-${Date.now()}`;
  page.once('dialog', (d) => d.accept(name));
  await drawingBtn.click();

  const canvas = page.locator('.excalidraw').first();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });
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
  // And it must be clickable rather than buried under something.
  await expect(page.locator('.excalidraw-theme-toggle')).toBeVisible();

  // Toggle to light...
  await page.locator('.excalidraw-theme-toggle').click();
  await expect(canvas).not.toHaveClass(/theme--dark/);

  // ...and the preference survives a reload rather than snapping back.
  await page.reload();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.excalidraw').first()).not.toHaveClass(/theme--dark/);

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
