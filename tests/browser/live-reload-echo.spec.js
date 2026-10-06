// Replacing the Live editor's text from outside must not be sent back out.
//
// Milkdown reports document changes debounced, so the report for an injected
// document (a collaborator's live typing, their save, a reload) arrived after
// the editor's "this is not the user" flag was cleared and was treated as a
// user edit. With live collaboration on, the idle side of a shared note
// broadcast live content (the other person saw "X is typing" while X sat
// still) and autosaved with a stale etag (a 409, the "modified by another
// user" banner). Live collaboration needs multi mode, so this pins the same
// path through Reload note: an outside change, reloaded, must cause no save.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const DIR = 'e2e-reload-echo';
const FILE = `${DIR}/echo.md`;
// "-" bullets: the editor's serializer writes "*", so an echo is visible on disk.
const ORIGINAL = '# Echo\n\n- first item\n- second item\n\nA paragraph.\n';
const OUTSIDE = '# Echo\n\n- first item\n- second item\n- third item from outside\n\nA paragraph.\n';

async function api(page, method, path, body) {
  return page.evaluate(async ([m, ns, p, b]) => {
    const r = await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, {
      method: m, headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') }, body: b ?? undefined,
    });
    return { status: r.status, text: await r.text() };
  }, [method, NS, path, body ?? null]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await api(page, 'POST', FILE, ORIGINAL);
});
test.afterEach(async ({ page }) => { await api(page, 'DELETE', DIR); });

test('an outside change loaded into the Live editor is not saved back', async ({ page }) => {
  await page.goto(`/#${NS}/${FILE}`);
  await page.click('.toolbar button[title="Live rich editor"]');
  await expect(page.locator('.live-editor-crepe-root li').nth(1)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1000);

  await api(page, 'PUT', FILE, OUTSIDE);
  // Count only what the app sends from here on (not the outside change above).
  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/note')) puts.push(r.url()); });
  // ⋯ menu (or the inline refresh button) → Reload note.
  const inline = page.locator('.toolbar-inline-refresh');
  if (await inline.isVisible().catch(() => false)) await inline.click();
  else { await page.locator('.toolbar-more-btn').click(); await page.getByRole('menuitem', { name: 'Reload note' }).click(); }
  await expect(page.locator('.live-editor-crepe-root li', { hasText: 'third item from outside' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500); // past the listener debounce and the autosave delay

  expect(puts, 'the reload was saved back as if the user had typed it').toEqual([]);
  expect((await api(page, 'GET', FILE)).text).toBe(OUTSIDE);

  // Real typing after the reload still saves.
  await page.locator('.live-editor-crepe-root p', { hasText: 'A paragraph.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.', { delay: 20 });
  await expect.poll(async () => (await api(page, 'GET', FILE)).text, { timeout: 10_000 }).toContain('A paragraph. Typed.');
});
