// Runs on an isolated namespace in tests/e2e-pages.sh. Restoring a namespace
// must never replace handles being exercised by another browser spec.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const MODE = process.env.MDNEST_PAGES_MODE || '';
const NS = 'zz_pages_settings';
const DIR = `settings-${process.pid}-${Date.now()}`;
const HANDLE = `${DIR}/report.page.md`;
const MISSING = `${DIR}/missing.page.md`;
const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
test.skip(!MODE, 'needs tests/e2e-pages.sh');
let token, originalId;
const auth = () => ({ Authorization: `Bearer ${token}` });

test.beforeEach(async ({ request }) => {
  token = (await (await request.post('/api/auth/login', { data: { username: USER, password: PASS } })).json()).token;
  const published = await request.put(`/api/pages?ns=${NS}&path=${encodeURIComponent(HANDLE)}`, {
    headers: { ...auth(), 'Content-Type': 'text/html' },
    data: '<title>Backup report</title><meta name="description" content="Restored description"><p>Backup page text</p>',
  });
  expect(published.status(), await published.text()).toBe(200);
  originalId = (await published.json()).id;
  // A handle copied without its page files, the real moved-server failure.
  const missing = await request.post(`/api/note?ns=${NS}&path=${encodeURIComponent(MISSING)}`, {
    headers: auth(), data: `---\npage: ${'a'.repeat(32)}\ntitle: Missing\n---\n`,
  });
  expect(missing.status()).toBe(201);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/note?ns=${NS}&path=${encodeURIComponent(DIR)}`, { headers: auth() });
});

async function settings(page) {
  await page.goto(`/#${NS}`);
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-select')).toBeVisible({ timeout: 20_000 });
  await page.locator('.ns-select').selectOption(NS);
  await page.click('.toolbar-more-btn');
  await page.click('.toolbar-more-settings');
  await page.locator('.settings-tabs').getByRole('button', { name: 'Pages', exact: true }).click();
  await expect(page.getByTestId('settings-pages')).toBeVisible();
}

test('Settings downloads and restores pages, reports missing files and keeps ordinary notes', async ({ page, request }) => {
  await settings(page);
  const config = await (await request.get('/api/config')).json();
  await expect(page.getByTestId('settings-pages-storage')).toContainText(config.pages.inGit ? 'saved with your notes in git' : 'kept apart from your notes');
  const tab = page.getByTestId('settings-pages');
  await expect(tab.getByRole('button')).toHaveCount(2);
  await page.screenshot({ path: `../browser-results/pages-settings-${MODE}.png` });
  const downloading = page.waitForEvent('download');
  await tab.getByRole('button', { name: 'Download all pages' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${NS}-pages.tgz`);
  const archive = await download.path();
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'manifest.json'], { encoding: 'utf8' }));
  expect(manifest.pages.map((p) => p.path)).toEqual([HANDLE]);
  expect(manifest.pages[0].description).toBe('Restored description');
  expect(manifest.skipped).toEqual([{ path: MISSING, status: 'skipped', reason: 'files missing' }]);
  await expect(page.getByTestId('settings-pages-result')).toContainText('Downloaded 1 page, 1 skipped: files missing');
  page.on('dialog', (dialog) => dialog.accept());
  await tab.locator('input[type=file]').setInputFiles({ name: 'pages.tgz', mimeType: 'application/gzip', buffer: await readFile(archive) });
  await expect(page.getByTestId('settings-pages-result')).toContainText('Restored 1 page, 1 skipped: files missing');
  const meta = await (await request.get(`/api/pages/text?ns=${NS}&path=${encodeURIComponent(HANDLE)}`, { headers: auth() })).json();
  expect(meta.id).not.toBe(originalId);
  expect(meta.title).toBe('Backup report');
  expect(meta.text).toContain('Backup page text');
  expect(meta.description).toBe('Restored description');

  // Restore has an ordinary-note conflict at this one path. It reports a
  // skipped entry and never turns the note back into a page.
  const note = await request.put(`/api/note?ns=${NS}&path=${encodeURIComponent(HANDLE)}`, { headers: auth(), data: 'ORDINARY NOTE, KEEP THIS' });
  expect(note.status()).toBe(200);
  await tab.locator('input[type=file]').setInputFiles({ name: 'pages.tgz', mimeType: 'application/gzip', buffer: await readFile(archive) });
  await expect(page.getByTestId('settings-pages-result')).toContainText('Restored 0 pages, 2 skipped:');
  await expect(page.getByTestId('settings-pages-result')).toContainText('ordinary notes already exist');
  const kept = await request.get(`/api/note?ns=${NS}&path=${encodeURIComponent(HANDLE)}`, { headers: auth() });
  expect(await kept.text()).toContain('ORDINARY NOTE, KEEP THIS');
});

test('Settings shows an archive refusal and works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await settings(page);
  page.on('dialog', (dialog) => dialog.accept());
  const tab = page.getByTestId('settings-pages');
  await tab.locator('input[type=file]').setInputFiles({ name: 'bad.tgz', mimeType: 'application/gzip', buffer: Buffer.from('not an archive') });
  await expect(tab.getByRole('alert')).toContainText('That file is not a pages backup (.tar.gz).');
  await expect(tab.getByRole('button', { name: 'Restore pages' })).toBeEnabled();
  const rect = await tab.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: `../browser-results/pages-settings-phone-${MODE}.png` });
});
