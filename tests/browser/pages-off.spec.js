// HTML pages with ENABLE_PAGES off (the default, and how tests/e2e-browser.sh
// boots its stack): nothing of the feature may show or load. No Pages section,
// no pages chunk fetched, no route answering, nothing in /api/config. The
// feature's own behaviour is in pages.spec.js, run by tests/e2e-pages.sh.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const SEED_FILE = process.env.MDNEST_SEED_FILE || 'e2e-seed.md';

test.skip(!!process.env.MDNEST_PAGES_MODE, 'this stack has pages on');

test('pages off: no section, no chunk, no route', async ({ page, request }) => {
  const cfg = await (await request.get('/api/config')).json();
  expect(cfg.pages).toBeUndefined();

  const chunks = [];
  page.on('request', (r) => {
    if (/\/assets\/Pages-[^/]*\.(js|css)$/.test(new URL(r.url()).pathname)) chunks.push(r.url());
  });

  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.tree-label', { hasText: SEED_FILE })).toBeVisible({ timeout: 20_000 });
  await page.locator('.tree-label', { hasText: SEED_FILE }).click();
  await expect(page.locator('.toolbar-path')).toContainText(SEED_FILE, { timeout: 20_000 });
  // Give any lazy import a moment to fire if something still asks for it.
  await page.waitForTimeout(1500);

  await expect(page.locator('[data-testid=pages-section]')).toHaveCount(0);
  await expect(page.locator('[data-testid=toolbar-pages]')).toHaveCount(0);
  // The side panel has no Pages tab.
  await page.locator('.toolbar-stickies').first().click();
  await expect(page.locator('[data-testid=side-panel]')).toBeVisible();
  await expect(page.locator('[data-testid=side-panel-tab-pages]')).toHaveCount(0);
  await expect(page.locator('[data-testid=pages-panel]')).toHaveCount(0);
  await page.locator('.toolbar-stickies').first().click();
  await expect(page.getByText('Pages', { exact: true })).toHaveCount(0);
  expect(chunks, 'the pages chunk was requested with pages off').toEqual([]);

  const token = await page.evaluate(() => localStorage.getItem('mdnest_token'));
  for (const [method, path] of [
    ['GET', '/api/pages?ns=testing_workspace'],
    ['GET', '/api/pages/text?ns=testing_workspace&path=x.page.md'],
    ['POST', '/api/pages/pass?ns=testing_workspace&path=x.page.md'],
    ['GET', '/api/pages/view/x/'],
  ]) {
    const res = await request.fetch(path, { method, headers: { Authorization: `Bearer ${token}` } });
    expect(res.status(), `${method} ${path}`).toBe(404);
  }
});

test('pages off: a .page.md is an ordinary note', async ({ page, request }) => {
  const login = await request.post('/api/auth/login', { data: { username: USER, password: PASS } });
  const token = (await login.json()).token;
  const name = `off-${Date.now()}.page.md`;
  const body = '---\npage: abcdefghijklmnopqrstuvwxyz234567\ntitle: "Off"\n---\n\nHTML page, open it in mdnest.\n';
  const r = await request.post(`/api/note?ns=testing_workspace&path=${name}`, { headers: { Authorization: `Bearer ${token}` }, data: body });
  expect(r.status()).toBeLessThan(300);
  try {
    await page.goto('/');
    await page.fill('input[name=username]', USER);
    await page.fill('input[name=password]', PASS);
    await page.click('button:has-text("Sign in")');
    const row = page.locator('.tree-label', { hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.tree-row', { hasText: name }).locator('.tree-icon-svg.file')).toBeVisible();
    await row.click();
    await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });
    await expect(page.getByText('HTML page, open it in mdnest.').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid=page-view]')).toHaveCount(0);
  } finally {
    await request.delete(`/api/note?ns=testing_workspace&path=${name}`, { headers: { Authorization: `Bearer ${token}` } });
  }
});
