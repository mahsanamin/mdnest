// Light/dark theme, end to end in a real browser.
//
// The unit tests pin the resolution rules and the palette's contrast. What
// only a browser can show is that the pieces are actually connected: that the
// OS setting reaches the document, that a choice is written to the SERVER and
// so survives a browser that has been cleared, and that the first paint is not
// the wrong colour.
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

// Reset the stored preference so tests do not leak into each other. The
// preference is server-side, so clearing storage is not enough.
async function clearPreference(page) {
  await page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ theme: 'auto' }),
    });
  });
}

test.describe('theme', () => {
  test('follows the OS when nothing is chosen', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await signIn(page);
    await clearPreference(page);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.emulateMedia({ colorScheme: 'dark' });
    // No reload: 'auto' has to track the OS live, which is the whole point of
    // it. A user who flips their system theme should not have to refresh.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the toolbar toggle flips the theme and paints the page', async ({ page }) => {
    await signIn(page);
    await clearPreference(page);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.locator('.toolbar-theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // The attribute alone proves nothing — the stylesheet has to respond to
    // it. A missing or mis-scoped light block would leave this unchanged.
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(lightBg).not.toBe(darkBg);
  });

  test('the choice is stored on the server, not in the browser', async ({ page, context }) => {
    await signIn(page);
    await clearPreference(page);
    await page.reload();

    await page.locator('.toolbar-theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // It reached the API, not just React state.
    const stored = await page.evaluate(async () => {
      const t = localStorage.getItem('mdnest_token');
      const r = await fetch('/api/preferences', { headers: { Authorization: 'Bearer ' + t } });
      return r.json();
    });
    expect(stored.theme).toBe('light');

    // The real claim: wipe everything the browser remembers except the login,
    // and the theme still comes back. This is what separates a server-side
    // preference from a localStorage one — and it fails if the app ever starts
    // treating the paint cache as the source of truth.
    const token = await page.evaluate(() => localStorage.getItem('mdnest_token'));
    await context.clearCookies();
    await page.evaluate((t) => { localStorage.clear(); localStorage.setItem('mdnest_token', t); }, token);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('a stored light preference beats a dark OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await signIn(page);
    await page.evaluate(async () => {
      const t = localStorage.getItem('mdnest_token');
      await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ theme: 'light' }),
      });
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('there is no dark flash before the app loads', async ({ page }) => {
    await signIn(page);
    await page.evaluate(async () => {
      const t = localStorage.getItem('mdnest_token');
      await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ theme: 'light' }),
      });
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // The inline boot script must have painted light before the bundle ran.
    // Checking at DOMContentLoaded catches a regression where the theme is
    // only applied from React, which would show a full-page dark flash on
    // every load for every light-mode user.
    await page.goto('/', { waitUntil: 'commit' });
    const early = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(early).toBe('light');
  });

  test('Settings exposes the three-way choice including Match system', async ({ page }) => {
    await signIn(page);
    await page.locator('.toolbar-settings').click();
    await page.locator('.settings-tabs button:has-text("Appearance")').click();

    await expect(page.locator('.theme-option:has-text("Match system")')).toBeVisible();
    await page.locator('.theme-option:has-text("Light")').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('.theme-option:has-text("Dark")').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
