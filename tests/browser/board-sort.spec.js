// Card order decides what a paged column shows you.
//
// Columns paint 100 cards at a time, and tasks arrive in note order — so an
// overdue task in a late-alphabet file was on page 64 with no way to know.
// Sorting by urgency fixes that, but the DEFAULT stays note order: most boards
// are small enough that paging never applies, and silently reshuffling them
// would be its own kind of broken.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

// Switch to the namespace with the most tasks, so the paging tests exercise a
// column that actually pages. Returns false when nothing here is big enough.
async function selectBusiestNamespace(page, minTasks) {
  const sel = page.locator('.ns-select');
  if (!(await sel.count())) return false;
  const counts = await page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    const nss = await (await fetch('/api/namespaces', { headers: { Authorization: 'Bearer ' + t } })).json();
    const out = [];
    for (const ns of nss) {
      const r = await fetch(`/api/tasks?ns=${encodeURIComponent(ns)}`, { headers: { Authorization: 'Bearer ' + t } });
      const d = await r.json();
      out.push([ns, (d.tasks || []).filter((x) => !x.checked).length]);
    }
    return out.sort((a, b) => b[1] - a[1]);
  });
  if (!counts.length || counts[0][1] < minTasks) return false;
  await sel.selectOption(counts[0][0]);
  await page.waitForTimeout(1500);
  return true;
}

async function openBoard(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  const btn = page.locator('.toolbar-board-btn');
  const ok = await btn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');
  await btn.click();
  await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
}

const firstCards = (page, n) =>
  page.locator('.tb-column').first().locator('.tb-card').evaluateAll(
    (els, count) => els.slice(0, count).map((e) => e.innerText), n);

test('the default order is note order, and it is what the server sent', async ({ page }) => {
  test.setTimeout(120_000);
  await openBoard(page);
  const sort = page.locator('.tb-filter-sort');
  await expect(sort).toBeVisible();
  await expect(sort, 'the default must not have changed').toHaveValue('note');

  // The first cards should match the API's own order (path, then line).
  const shown = await firstCards(page, 3);
  const api = await page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    const ns = document.querySelector('.ns-select')?.value || document.querySelector('.ns-label')?.textContent.trim();
    const r = await fetch(`/api/tasks?ns=${encodeURIComponent(ns)}`, { headers: { Authorization: 'Bearer ' + t } });
    return (await r.json()).tasks;
  });
  const firstCol = await page.locator('.tb-column').first().locator('.tb-column-title').innerText();
  const expected = api.filter((t) => !t.checked).slice(0, 3).map((t) => t.text);
  if (expected.length && firstCol.toLowerCase().includes('to do')) {
    for (let i = 0; i < expected.length; i++) {
      expect(shown[i], 'default order drifted from the note order the server sends').toContain(expected[i]);
    }
  }
});

test('sorting by urgency brings an overdue task onto the first page', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  const bigEnough = await selectBusiestNamespace(page, 101);
  if (!bigEnough) test.skip(true, 'no namespace here has a column bigger than one page');
  const boardBtn = page.locator('.toolbar-board-btn');
  const ok = await boardBtn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'task board disabled');
  await boardBtn.click();
  await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });

  const col = page.locator('.tb-column').first();
  const total = parseInt((await col.locator('.tb-column-count').innerText()).trim(), 10);
  if (!(total > 100)) test.skip(true, 'needs a column bigger than one page');

  // An overdue task exists somewhere in the namespace...
  const overdue = await page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    const ns = document.querySelector('.ns-select')?.value || document.querySelector('.ns-label')?.textContent.trim();
    const r = await fetch(`/api/tasks?ns=${encodeURIComponent(ns)}`, { headers: { Authorization: 'Bearer ' + t } });
    const all = (await r.json()).tasks;
    const dated = all.filter((x) => !x.checked && x.due);
    dated.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
    return dated[0] || null;
  });
  if (!overdue) test.skip(true, 'no dated task to prove the point with');

  // ...and in note order it is nowhere near the first page.
  const before = await firstCards(page, 100);
  expect(before.some((c) => c.includes(overdue.text)),
    'fixture problem: the overdue task is already on page one').toBe(false);

  await page.locator('.tb-filter-sort').selectOption('urgency');
  await page.waitForTimeout(600);

  const after = await firstCards(page, 5);
  expect(after.some((c) => c.includes(overdue.text)),
    'urgency sort did not surface the soonest-due task').toBe(true);
});

test('the sort choice is remembered', async ({ page }) => {
  test.setTimeout(120_000);
  await openBoard(page);
  await page.locator('.tb-filter-sort').selectOption('urgency');
  expect(await page.evaluate(() => localStorage.getItem('mdnest_taskboard_sort'))).toBe('urgency');
  await page.reload();
  await page.locator('.toolbar-board-btn').click();
  await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tb-filter-sort')).toHaveValue('urgency');
  // put it back so the other specs see the default
  await page.locator('.tb-filter-sort').selectOption('note');
});
