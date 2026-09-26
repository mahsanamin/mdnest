// The task board is a place you can link to and refresh on.
//
// It had no route: opening it left the URL on the note, so a browser refresh
// always dropped you back into the editor and a board could not be shared or
// bookmarked. It now lives at #!board/<ns>/<note>, keeping the namespace and
// the note underneath so the board's back button and "This note" scope still
// work after a reload.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

async function api(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b });
    return { status: r.status, text: await r.text() };
  }, [method, url, body]);
}

test('refreshing on the board keeps the board, the namespace and the note', async ({ page }) => {
  test.setTimeout(90_000);
  const note = `__deeplink-${Date.now()}.md`;
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  const boardBtn = page.locator('.toolbar-view-board');
  const ok = await boardBtn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');
  expect((await api(page, 'POST', `/api/note?ns=${NS}&path=${encodeURIComponent(note)}`, '# d\n\n- [ ] deeplink task\n')).status).toBe(201);

  try {
    await page.goto(`/#${NS}/${note}`);
    await expect(page.locator('.toolbar-path')).toContainText(note, { timeout: 20_000 });

    await page.locator('.toolbar-view-board').click();
    await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`#!board/${NS}/${note.replace('.', '\\.')}$`));

    // The reported bug: a refresh used to land back in the editor.
    await page.reload();
    await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.toolbar-path')).toContainText(note);
    await expect(page.locator('.tb-back-label')).toContainText(note);

    // Leaving the board puts the URL back on the note.
    await page.locator('.toolbar-view-editor').click();
    await expect(page.locator('.tb-panel')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#${NS}/${note.replace('.', '\\.')}$`));

    // A board link opened fresh (shared, bookmarked) lands on the board.
    await page.goto('/#');
    await page.goto(`/#!board/${NS}/${note}`);
    await page.reload();
    await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.toolbar-path')).toContainText(note);
  } finally {
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(note)}`);
  }
});
