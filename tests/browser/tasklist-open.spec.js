// Task lists open on the board.
//
// A note that holds only tasks (headings and blank lines aside) and any
// `*.tasks.md` file open on the task board for that note instead of the
// editor. Picking Editor there is remembered for that note, so the person who
// wants the markdown is not sent back to the board every time.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const PROSE = process.env.MDNEST_SEED_FILE || 'e2e-seed.md';

async function api(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b });
    return { status: r.status, text: await r.text() };
  }, [method, url, body]);
}

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  const ok = await page.locator('.toolbar-view-board').waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');
}

async function open(page, note) {
  await page.goto(`/#${NS}/${note}`);
  await expect(page.locator('.toolbar-path')).toContainText(note, { timeout: 20_000 });
}

test('a note of tasks only opens on its board, and Editor is remembered for it', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const note = `__tasklist-${Date.now()}.md`;
  expect((await api(page, 'POST', `/api/note?ns=${NS}&path=${encodeURIComponent(note)}`,
    '# Plan\n\n- [ ] first task\n  - priority: high\n- [x] done task\n')).status).toBe(201);

  try {
    await open(page, note);
    await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.toolbar-view-editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'This note' })).toHaveClass(/active/);

    await page.locator('.toolbar-view-editor').click();
    await expect(page.locator('.tb-panel')).toHaveCount(0);

    // Away and back: the note stays in the editor.
    await open(page, PROSE);
    await open(page, note);
    await expect(page.locator('.toolbar-view-board')).toBeVisible();
    await expect(page.locator('.tb-panel')).toHaveCount(0);

    // And after a reload too.
    await page.reload();
    await expect(page.locator('.toolbar-path')).toContainText(note, { timeout: 20_000 });
    await expect(page.locator('.toolbar-view-board')).toBeVisible();
    await expect(page.locator('.tb-panel')).toHaveCount(0);
  } finally {
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(note)}`);
  }
});

test('an empty .tasks.md opens on its board', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const note = `__sprint-${Date.now()}.tasks.md`;
  expect((await api(page, 'POST', `/api/note?ns=${NS}&path=${encodeURIComponent(note)}`, '')).status).toBe(201);

  try {
    await open(page, note);
    await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.tb-empty')).toContainText('No tasks in this note yet.');
  } finally {
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(note)}`);
  }
});
