// Autosave on a slow link, and how a real conflict is shown.
//
// Two autosaves used to overlap: the second left before the first returned,
// with the same If-Match etag, so it came back 409. On a remote server every
// second save failed, a "modified by another user" banner appeared with
// nobody else there, and when the last save was the rejected one the final
// words never reached the server. The banner was also a row above the
// editor, so each time it appeared the whole document jumped down.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const DIR = 'e2e-autosave';
const FILE = `${DIR}/slow.md`;

async function api(page, method, path, body, headers = {}) {
  return page.evaluate(async ([m, ns, p, b, h]) => {
    const r = await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, {
      method: m, headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token'), ...h }, body: b ?? undefined,
    });
    return { status: r.status, text: await r.text() };
  }, [method, NS, path, body ?? null, headers]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await api(page, 'POST', FILE, '# Slow\n\nStart here.\n');
});
test.afterEach(async ({ page }) => { await api(page, 'DELETE', DIR); });

test('slow saves never overlap: no false conflict, and the last words are saved', async ({ page }) => {
  test.setTimeout(90_000);
  const statuses = [];
  // A remote server: every save takes 1.5s to come back.
  await page.route('**/api/note?**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await new Promise((r) => setTimeout(r, 1500));
    const resp = await route.fetch();
    statuses.push(resp.status());
    await route.fulfill({ response: resp });
  });
  await page.goto(`/#${NS}/${FILE}`);
  await page.click('.toolbar button[title="Live rich editor"]');
  const p = page.locator('.live-editor-crepe-root p', { hasText: 'Start here' });
  await p.click();
  await page.keyboard.press('End');
  // Bursts a little longer apart than the autosave debounce, so a new save
  // is due while the previous one is still in flight.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.type(` word${i}`, { delay: 20 });
    await page.waitForTimeout(900);
  }
  await expect.poll(async () => (await api(page, 'GET', FILE)).text, { timeout: 15_000 }).toContain('word5');
  expect(statuses, `save statuses: ${statuses.join(',')}`).not.toContain(409);
  await expect(page.locator('.conflict-banner')).toHaveCount(0);
});

test('a real conflict shows a floating notice that does not move the text', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`/#${NS}/${FILE}`);
  await page.click('.toolbar button[title="Live rich editor"]');
  const p = page.locator('.live-editor-crepe-root p', { hasText: 'Start here' });
  await expect(p).toBeVisible({ timeout: 20_000 });
  const topBefore = (await p.boundingBox()).y;
  // Someone else saves a different text; then we type, and our save is stale.
  await api(page, 'PUT', FILE, '# Slow\n\nStart here, edited elsewhere.\n');
  await p.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' mine', { delay: 20 });
  const banner = page.locator('.conflict-banner');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  expect(await banner.evaluate((e) => getComputedStyle(e).position)).toBe('fixed');
  const topAfter = (await page.locator('.live-editor-crepe-root p').nth(0).boundingBox()).y;
  expect(Math.abs(topAfter - topBefore), 'the document must not jump when the notice appears').toBeLessThan(2);
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
});
