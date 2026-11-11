// Opening something that cannot or should not be opened as usual.
//
// A link to a workspace the person cannot open used to land them on their last
// note there, with the address rewritten to it and no word about the link. A
// note that could not be read left an empty editor. A very large file was
// loaded and rendered whole, which froze the tab. Each case now says what
// happened, and a large file asks first and opens as plain text.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = 'testing_workspace';

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + t }, body });
    return { status: r.status, text: await r.text() };
  }, { method, path, body });
}
// A full page load on url. page.goto to a URL that differs only in its hash
// is a same-page navigation: the app sees a hashchange, not a fresh load.
async function fresh(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}
const note = (p) => `/note?ns=${NS}&path=${encodeURIComponent(p)}`;

let base;
test.beforeEach(() => { base = `openerr-${Date.now()}-${Math.floor(Math.random() * 1e4)}`; });
test.afterEach(async ({ page }) => { await api(page, 'DELETE', note(base)).catch(() => {}); });

async function openSmallNote(page) {
  const small = `${base}/small.md`;
  expect((await api(page, 'POST', note(small), '# small\n')).status).toBe(201);
  await fresh(page, `/#${NS}/${small}`);
  await expect(page.locator('.toolbar-path')).toContainText('small.md', { timeout: 20_000 });
}

test('a link to a workspace you cannot open says so and opens no note', async ({ page }) => {
  await login(page);
  await openSmallNote(page);
  await fresh(page, '/#zz_no_such_workspace/plan.md');
  await expect(page.getByTestId('notice-bar')).toContainText(`workspace "zz_no_such_workspace"`, { timeout: 20_000 });
  // The last note is not reopened as if the link had worked.
  await expect(page.locator('.toolbar-path')).not.toContainText('small.md');
  await expect(page.locator('.toolbar-path')).toContainText('No file selected');
  expect(page.url()).not.toContain('zz_no_such_workspace');
});

test('following such a link inside the app keeps you where you were', async ({ page }) => {
  await login(page);
  await openSmallNote(page);
  await page.evaluate(() => { window.location.hash = '#zz_no_such_workspace/plan.md'; });
  await expect(page.getByTestId('notice-bar')).toContainText('zz_no_such_workspace', { timeout: 20_000 });
  await expect(page.locator('.toolbar-path')).toContainText('small.md');
  await expect.poll(() => page.url()).toContain(`${base}/small.md`);
});

test('a link to a note that does not exist says so', async ({ page }) => {
  await login(page);
  await fresh(page, `/#${NS}/${base}/missing.md`);
  await expect(page.getByTestId('notice-bar')).toContainText('missing.md was not found', { timeout: 20_000 });
});

test('a large file asks first, then opens as plain text', async ({ page }) => {
  await login(page);
  const big = `${base}/big.md`;
  const body = ('line of a large exported log, padded to make it long enough\n').repeat(25_000); // about 1.5 MB
  // Over 1 MB, so it also goes through nginx's body limit (1 MB by default).
  expect((await api(page, 'POST', note(big), body)).status).toBe(201);
  await openSmallNote(page);
  const folder = page.locator('.tree-row', { hasText: base }).first();
  if ((await folder.locator('.tree-icon-svg.folder-open').count()) === 0) await folder.click();
  const row = page.locator('.tree-row', { hasText: 'big.md' }).first();

  // Saying no leaves the open note alone.
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await row.click();
  await expect.poll(() => asked).toContain('big.md is large');
  await expect(page.locator('.toolbar-path')).toContainText('small.md');

  // Saying yes opens it in the Basic editor, with no Live editor or preview.
  page.once('dialog', (d) => d.accept());
  await row.click();
  await expect(page.locator('.toolbar-path')).toContainText('big.md', { timeout: 20_000 });
  await expect(page.locator('.editor-textarea')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.ProseMirror')).toHaveCount(0);
});
