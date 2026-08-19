// Presence must not move the page, and must not flicker.
//
// The presence bar used to be a full-width strip in the document flow between
// the toolbar and the editor, so every join and leave reflowed everything
// below it — the editor, a Mermaid diagram and a drawing canvas all jumped by
// the height of the bar. It also applied departures the instant they arrived,
// so a reconnect or a snapshot racing a join showed a collaborator vanishing
// and immediately returning.
//
// This needs live collab AND two distinct accounts: presence filters out your
// own id, so two sessions of one user prove nothing. The single-mode E2E stack
// has one account, so this skips there and runs against a multi-user instance:
//   MDNEST_USER2=... MDNEST_PASSWORD2=... npx playwright test presence.spec.js
// The grace-period logic itself is covered without a browser in
// frontend/src/__tests__/presence-hold.test.js, which does run everywhere.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const USER2 = process.env.MDNEST_USER2 || '';
const PASS2 = process.env.MDNEST_PASSWORD2 || '';

async function login(page, u, p) {
  await page.goto('/');
  await page.fill('input[name=username]', u);
  await page.fill('input[name=password]', p);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

const namespaces = (page) => page.evaluate(async () => {
  const t = localStorage.getItem('mdnest_token');
  return (await (await fetch('/api/namespaces', { headers: { Authorization: 'Bearer ' + t } })).json()) || [];
});

const collabEnabled = (page) =>
  page.evaluate(async () => (await (await fetch('/api/config')).json()).liveCollab === true);

// Put both users in the same note, in a namespace they can both read.
async function meetInANote(pageA, pageB) {
  const [nsA, nsB] = [await namespaces(pageA), await namespaces(pageB)];
  const shared = nsA.find((n) => nsB.includes(n));
  if (!shared) return null;

  const file = `presence-${Date.now()}.md`;
  await pageA.evaluate(async ({ ns, file }) => {
    const t = localStorage.getItem('mdnest_token');
    const url = `/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(file)}`;
    await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: '' });
    await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + t }, body: '# presence\n\nhello\n' });
  }, { ns: shared, file });

  for (const p of [pageA, pageB]) {
    await p.goto(`/#${shared}/${file}`);
    await expect(p.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
  }
  return { ns: shared, file };
}

test('a collaborator joining does not move the content', async ({ browser }) => {
  test.setTimeout(180_000);
  if (!USER2) test.skip(true, 'set MDNEST_USER2/MDNEST_PASSWORD2 to run (needs two accounts)');

  const a = await browser.newContext(); const pageA = await a.newPage();
  await login(pageA, USER, PASS);
  if (!(await collabEnabled(pageA))) { await a.close(); test.skip(true, 'live collab disabled'); }

  const b = await browser.newContext(); const pageB = await b.newPage();
  await login(pageB, USER2, PASS2);

  const met = await meetInANote(pageA, pageB);
  if (!met) { await b.close(); await a.close(); test.skip(true, 'the two users share no namespace'); }

  // A is alone in the note first — record where the content sits.
  await pageB.goto('/#');
  await pageA.waitForTimeout(1200);
  const target = pageA.locator('.split-view');
  const before = await target.boundingBox();

  // B joins.
  await pageB.goto(`/#${met.ns}/${met.file}`);
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });
  await pageA.waitForTimeout(400);

  const after = await target.boundingBox();
  expect(after.y, 'the content moved when a collaborator joined').toBeCloseTo(before.y, 0);
  expect(after.height, 'the content was resized when a collaborator joined').toBeCloseTo(before.height, 0);
  expect(await pageA.locator('.presence-bar').evaluate((el) => getComputedStyle(el).position)).toBe('absolute');

  // An overlay must not cover the controls it floats near. The first attempt
  // was positioned against .main and sat on top of the toolbar's view-mode and
  // settings buttons.
  const bar = await pageA.locator('.presence-bar').boundingBox();
  for (const sel of ['.toolbar-view-toggle', '.toolbar .settings-btn', '.editor-mode-toggle']) {
    const el = pageA.locator(sel).first();
    if (!(await el.count())) continue;
    const r = await el.boundingBox();
    if (!r) continue;
    const overlaps = bar.x < r.x + r.width && r.x < bar.x + bar.width
      && bar.y < r.y + r.height && r.y < bar.y + bar.height;
    expect(overlaps, `the presence bar covers ${sel}`).toBe(false);
  }

  await b.close(); await a.close();
});

test('a collaborator who leaves is held briefly, not dropped instantly', async ({ browser }) => {
  test.setTimeout(180_000);
  if (!USER2) test.skip(true, 'set MDNEST_USER2/MDNEST_PASSWORD2 to run (needs two accounts)');

  const a = await browser.newContext(); const pageA = await a.newPage();
  await login(pageA, USER, PASS);
  if (!(await collabEnabled(pageA))) { await a.close(); test.skip(true, 'live collab disabled'); }
  const b = await browser.newContext(); const pageB = await b.newPage();
  await login(pageB, USER2, PASS2);

  const met = await meetInANote(pageA, pageB);
  if (!met) { await b.close(); await a.close(); test.skip(true, 'the two users share no namespace'); }
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });

  await b.close();
  await pageA.waitForTimeout(800);
  await expect(pageA.locator('.presence-bar'), 'departure applied instantly — the grace period is gone')
    .toBeVisible();

  await expect(pageA.locator('.presence-bar')).toHaveCount(0, { timeout: 40_000 });
  await a.close();
});
