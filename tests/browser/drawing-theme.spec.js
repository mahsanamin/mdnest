// A drawing follows the app theme.
//
// Behaviour changed in v4.3.0. The canvas used to keep its own theme in
// localStorage and carry its own light/dark button, because mdnest was
// dark-only and a drawing had no other way to be light. Now the app has a
// theme, so the canvas follows it and the extra switch is gone — a second
// control doing almost the same job as the toolbar one, a few centimetres
// away, is a thing users have to stop and disambiguate.
//
// Theme is still a viewing preference and is still never written into the
// note: the .excalidraw.md stays portable and two people can view one drawing
// with different themes.
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

async function newDrawing(page, name) {
  const drawingBtn = page.locator('button:has-text("+ Drawing")');
  if (!(await drawingBtn.count())) test.skip(true, 'drawings disabled (ENABLE_EXCALIDRAW)');
  page.once('dialog', (d) => d.accept(name));
  await drawingBtn.click();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });
}

test('a drawing opens in the app theme and tracks it', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await newDrawing(page, `theme-${Date.now()}`);

  // The config emulates a dark OS and no preference is stored, so the app —
  // and therefore the canvas — is dark.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.excalidraw').first()).toHaveClass(/theme--dark/);

  // Flipping the APP theme repaints the open canvas. This is the assertion
  // that matters now that the canvas has no switch of its own: without it a
  // drawing would sit in the previous theme until it was reopened.
  await page.locator('.toolbar-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.excalidraw').first()).not.toHaveClass(/theme--dark/);

  // And there is no second theme control on the canvas.
  await expect(page.locator('.excalidraw-theme-toggle')).toHaveCount(0);

  // Put the preference back. It is stored on the SERVER now, so a theme set
  // here would otherwise follow the e2e user into every spec that runs after
  // this one — the specs share an account, not just a browser profile.
  await page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ theme: 'auto' }),
    });
  });

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
  await newDrawing(page, `theme-light-${Date.now()}`);

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.excalidraw').first()).not.toHaveClass(/theme--dark/);
});
