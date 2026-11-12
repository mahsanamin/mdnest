// Task board scopes and the milestone task detail.
//
// A folder of the tree has its own board: clicking it while the board is open,
// or "Task board" in its right-click menu, shows the tasks of that folder and
// its sub-folders, in every mode (List, Kanban, Milestones). Milestones follow
// the scope: on a folder they count the tasks there, over every workspace they
// are grouped by workspace. A task row of a milestone page opens the task in
// full on the right of the page, where it can be edited in place.
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

const q = (p) => encodeURIComponent(p);

// A folder with one task of the milestone, and one more task of it outside the folder.
async function seed(page) {
  const id = Date.now().toString(36);
  const s = { folder: `__scope-${id}`, ms: `scope-${id}`, inside: `Inside ${id}`, outside: `Outside ${id}` };
  s.note = `${s.folder}/plan.md`;
  s.out = `__elsewhere-${id}.md`;
  expect((await api(page, 'POST', `/api/folder?ns=${NS}&path=${q(s.folder)}`)).status).toBeLessThan(300);
  expect((await api(page, 'POST', `/api/note?ns=${NS}&path=${q(s.note)}`,
    `# Plan\n\nSome prose.\n\n- [ ] ${s.inside}\n  - milestone: ${s.ms}\n`)).status).toBe(201);
  expect((await api(page, 'POST', `/api/note?ns=${NS}&path=${q(s.out)}`,
    `# Elsewhere\n\nSome prose.\n\n- [ ] ${s.outside}\n  - milestone: ${s.ms}\n`)).status).toBe(201);
  const board = JSON.parse((await api(page, 'GET', `/api/board?ns=${NS}`)).text);
  board.milestones = [...(board.milestones || []), { id: s.ms, title: `Scope ${id}` }];
  expect((await api(page, 'PUT', `/api/board?ns=${NS}`, JSON.stringify(board))).status).toBe(200);
  return s;
}

async function cleanup(page, s) {
  if (!s) return;
  const board = JSON.parse((await api(page, 'GET', `/api/board?ns=${NS}`)).text);
  board.milestones = (board.milestones || []).filter((m) => m.id !== s.ms);
  await api(page, 'PUT', `/api/board?ns=${NS}`, JSON.stringify(board));
  await api(page, 'DELETE', `/api/note?ns=${NS}&path=${q(s.out)}`);
  await api(page, 'DELETE', `/api/note?ns=${NS}&path=${q(s.note)}`);
  await api(page, 'DELETE', `/api/folder?ns=${NS}&path=${q(s.folder)}`);
}

const msCount = (page, ms) => page.locator(`.tb-ms-card[data-milestone="${ms}"] .tb-milestone-count`);
const folderRow = (page, folder) => page.locator('.tree-row', { hasText: folder });
const scopeButton = (page, name) => page.locator('.tb-scope-toggle').getByRole('button', { name, exact: true });

test('a task row of a milestone page opens the task on the right, editable in place', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  let s;
  try {
    s = await seed(page);
    await page.goto(`/#!milestones/${NS}/${s.ms}`);
    const msPage = page.locator(`.tb-ms-page[data-milestone="${s.ms}"]`);
    await expect(msPage).toBeVisible({ timeout: 30_000 });

    const row = msPage.locator('.tb-ms-task', { hasText: s.inside });
    await row.locator('.tb-ms-task-title').click();
    const detail = page.locator('.tb-ms-detail');
    await expect(detail).toBeVisible();
    await expect(row).toHaveClass(/selected/);
    await expect(detail.getByLabel('Title')).toHaveValue(s.inside);
    // Next to the page, not over it.
    const [p, d] = [await msPage.boundingBox(), await detail.boundingBox()];
    expect(d.x).toBeGreaterThanOrEqual(p.x + p.width - 1);

    const renamed = `${s.inside} renamed`;
    await detail.getByLabel('Title').fill(renamed);
    await detail.getByRole('button', { name: 'Save' }).click();
    await expect(msPage.locator('.tb-ms-task', { hasText: renamed })).toBeVisible();
    await expect.poll(async () => (await api(page, 'GET', `/api/note?ns=${NS}&path=${q(s.note)}`)).text).toContain(renamed);
    // The detail follows the saved task.
    await expect(detail.getByLabel('Title')).toHaveValue(renamed);

    // Another row swaps the detail; the close button hides it.
    await msPage.locator('.tb-ms-task', { hasText: s.outside }).locator('.tb-ms-task-title').click();
    await expect(detail.getByLabel('Title')).toHaveValue(s.outside);
    await detail.getByRole('button', { name: 'Close task detail' }).click();
    await expect(detail).toHaveCount(0);
  } finally {
    await cleanup(page, s);
  }
});

test('a folder clicked in the tree scopes the open board, milestones included', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  let s;
  try {
    s = await seed(page);
    await page.goto(`/#!milestones/${NS}`);
    await page.reload(); // a hash change alone keeps the tree loaded before the seed
    await expect(msCount(page, s.ms)).toContainText('0/2', { timeout: 30_000 });

    await folderRow(page, s.folder).click();
    await expect(page.locator('.tb-scope-folder')).toHaveClass(/active/);
    await expect(msCount(page, s.ms)).toContainText('0/1');
    await expect(page.locator('.tb-ms-scope-hint')).toContainText(s.folder);

    // Kanban keeps the folder.
    await page.locator('.tb-mode-toggle button', { hasText: 'Kanban' }).click();
    await expect(page.locator('.tb-card', { hasText: s.inside })).toBeVisible();
    await expect(page.locator('.tb-card', { hasText: s.outside })).toHaveCount(0);

    // Back to the whole workspace.
    await scopeButton(page, 'Workspace').click();
    await expect(page.locator('.tb-card', { hasText: s.outside })).toBeVisible();
  } finally {
    await cleanup(page, s);
  }
});

test('"Task board" on a folder opens the board over that folder', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  let s;
  try {
    s = await seed(page);
    await page.goto(`/#${NS}/${PROSE}`);
    await page.reload();
    await folderRow(page, s.folder).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Task board' }).click();
    await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.tb-scope-folder')).toHaveClass(/active/);
    await page.locator('.tb-mode-toggle button', { hasText: 'List' }).click();
    await expect(page.locator('.tb-list-text', { hasText: s.inside })).toBeVisible();
    await expect(page.locator('.tb-list-text', { hasText: s.outside })).toHaveCount(0);
  } finally {
    await cleanup(page, s);
  }
});

test('over every workspace, milestones are grouped by workspace and open in their own', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  let s;
  try {
    s = await seed(page);
    await page.goto(`/#!milestones/${NS}`);
    await expect(msCount(page, s.ms)).toBeVisible({ timeout: 30_000 });
    await scopeButton(page, 'All workspaces').click();
    // A first visit asks before scanning every workspace.
    await page.getByRole('button', { name: 'Search all workspaces' }).click({ timeout: 5_000 }).catch(() => {});

    const section = page.locator(`.tb-ms-workspace[data-namespace="${NS}"]`);
    await expect(section.locator(`.tb-ms-card[data-milestone="${s.ms}"]`)).toContainText('0/2', { timeout: 30_000 });
    await section.locator(`.tb-ms-card[data-milestone="${s.ms}"]`).click();
    await expect(page.locator(`.tb-ms-page[data-milestone="${s.ms}"]`)).toBeVisible();
    await expect(scopeButton(page, 'Workspace')).toHaveClass(/active/);
  } finally {
    await cleanup(page, s);
  }
});

// The detail must follow its task, not its line number. A task added above it
// in the same note (by someone else, the CLI, an agent) shifts it down; the
// next background refresh then finds a DIFFERENT task at the old line. Saving
// the detail at that point passed the server's stale-line check (it compares
// the line it is given with the note) and wrote the form over that other task.
test('the task detail follows its task when a line is added above it', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const id = Date.now().toString(36);
  const ms = `shift-${id}`;
  const note = `__shift-${id}.md`;
  const [a, b, z] = [`Alpha ${id}`, `Bravo ${id}`, `Zulu ${id}`];
  const body = (tasks) => `# Shift\n\n${tasks.map((t) => `- [ ] ${t}\n  - milestone: ${ms}\n`).join('')}`;
  try {
    expect((await api(page, 'POST', `/api/note?ns=${NS}&path=${q(note)}`, body([a, b]))).status).toBe(201);
    const board = JSON.parse((await api(page, 'GET', `/api/board?ns=${NS}`)).text);
    board.milestones = [...(board.milestones || []), { id: ms, title: `Shift ${id}` }];
    expect((await api(page, 'PUT', `/api/board?ns=${NS}`, JSON.stringify(board))).status).toBe(200);

    await page.goto(`/#!milestones/${NS}/${ms}`);
    const msPage = page.locator(`.tb-ms-page[data-milestone="${ms}"]`);
    await expect(msPage).toBeVisible({ timeout: 30_000 });
    const rowB = msPage.locator('.tb-ms-task', { hasText: b });
    await rowB.locator('.tb-ms-task-title').click();
    const detail = page.locator('.tb-ms-detail');
    await expect(detail.getByLabel('Title')).toHaveValue(b);

    // Someone adds a task above both, then the board refreshes in the background.
    expect((await api(page, 'PUT', `/api/note?ns=${NS}&path=${q(note)}`, body([z, a, b]))).status).toBeLessThan(300);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(msPage.locator('.tb-ms-task', { hasText: z })).toBeVisible();

    // Still Bravo, in the list and in the detail.
    await expect(rowB).toHaveClass(/selected/);
    await expect(msPage.locator('.tb-ms-task', { hasText: a })).not.toHaveClass(/selected/);
    await expect(detail.locator('.tb-editor-source')).toHaveText(note);

    const renamed = `${b} renamed`;
    await detail.getByLabel('Title').fill(renamed);
    await detail.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => (await api(page, 'GET', `/api/note?ns=${NS}&path=${q(note)}`)).text).toContain(renamed);
    const text = (await api(page, 'GET', `/api/note?ns=${NS}&path=${q(note)}`)).text;
    // Alpha is untouched, and Bravo was renamed rather than copied over it.
    expect(text).toContain(`- [ ] ${a}`);
    expect(text).toContain(`- [ ] ${z}`);
    expect(text).not.toContain(`- [ ] ${b}\n`);
    await expect(detail.getByLabel('Title')).toHaveValue(renamed);
  } finally {
    const board = JSON.parse((await api(page, 'GET', `/api/board?ns=${NS}`)).text);
    board.milestones = (board.milestones || []).filter((m) => m.id !== ms);
    await api(page, 'PUT', `/api/board?ns=${NS}`, JSON.stringify(board));
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${q(note)}`);
  }
});
