// A code-split chunk that fails to download must not take the whole app down.
//
// Before ChunkErrorBoundary, a lazily-imported editor whose chunk 404/504'd
// threw during render, reached React's root, and unmounted everything — the
// user got a blank page with no sidebar and no way to open another note. This
// happened in the wild when a reverse proxy cached a 504 for one immutable
// asset URL, which broke every drawing in every namespace at once.
//
// These tests fail the request at the network layer, which is exactly what the
// browser saw, and assert the app is still there.
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

// Serve a 504 for a chunk, the way a proxy with a poisoned cache entry does.
// The retry helper also cache-busts with ?mdnest_retry=, so match both.
async function breakChunk(page, pattern) {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 504, contentType: 'text/html', body: '<html>504</html>' }));
}

test('a failed drawing chunk shows an error, not a blank page', async ({ page }) => {
  await login(page);
  await breakChunk(page, '**/assets/ExcalidrawEditor-*.js*');

  // Create a drawing through the UI so the test owns its fixture. The name is
  // unique per run so a re-run against a persistent namespace can't collide
  // with the file the previous run left behind.
  const name = `chunkfail-${Date.now()}`;
  page.once('dialog', (d) => d.accept(name));
  const drawingBtn = page.locator('button:has-text("+ Drawing")');
  if (await drawingBtn.count()) {
    await drawingBtn.click();
    await page.waitForTimeout(3000);
  } else {
    test.skip(true, 'drawings are disabled on this instance (ENABLE_EXCALIDRAW)');
  }

  // The app must still be mounted and navigable.
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.chunk-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.chunk-error')).toContainText('drawing editor');
  await expect(page.locator('.chunk-error-actions button')).toBeVisible();
});

test('a failed task-board chunk leaves the rest of the app usable', async ({ page }) => {
  await login(page);
  await breakChunk(page, '**/assets/TaskBoard-*.js*');

  const boardBtn = page.locator('.toolbar-view-board');
  const available = await boardBtn.waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true).catch(() => false);
  if (!available) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');
  await boardBtn.first().click();

  await expect(page.locator('.chunk-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.sidebar')).toBeVisible();
  // The escape hatch must work: closing the board returns to the note view.
  await page.locator('.chunk-error-actions button.secondary').click();
  await expect(page.locator('.chunk-error')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('a missing build asset 404s instead of being served index.html', async ({ request, baseURL }) => {
  // The SPA fallback used to answer /assets/<gone>.js with index.html and a
  // 200. A tab loaded before a redeploy then tried to parse HTML as an ES
  // module: the app broke in a confusing way rather than failing cleanly, and
  // the retry helper's cache-bust could not rescue it because every URL
  // returned the same HTML.
  const res = await request.get(`${baseURL}/assets/ExcalidrawEditor-gone12345.js`);
  expect(res.status(), 'a missing asset must 404, not fall back to index.html').toBe(404);
  // nginx's own 404 page is HTML, so the content type proves nothing — what
  // matters is that the body is not the app shell being passed off as a module.
  expect(await res.text()).not.toContain('<div id="root"');

  // The app's own entry point must still be served for unknown *routes*.
  const spa = await request.get(`${baseURL}/some/deep/route`);
  expect(spa.status()).toBe(200);
  expect(spa.headers()['content-type'] || '').toContain('text/html');
});
