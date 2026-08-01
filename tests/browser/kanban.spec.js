// mdnest task-board (kanban) browser tests — run against the disposable stack
// booted by tests/e2e-browser.sh with ENABLE_TASK_BOARD=true.
//
// The board is a projection of the `- [ ]` checkboxes in a note, so every
// assertion here is really about one thing: does what the UI shows match what
// is on disk, in both directions. That round-trip is where the bugs live —
// v4.0.0 shipped with a save gate that silently swallowed checkbox edits for a
// whole session because ticking a box is a mouse-only interaction that never
// produces a keydown.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
// Seeded by the runner before the browser starts (see tests/e2e-browser.sh).
const BOARD_FILE = process.env.MDNEST_BOARD_FILE || 'e2e-board.md';
const BOARD_TASK = process.env.MDNEST_BOARD_TASK || 'seedtask';
const NS = 'testing_workspace';

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function openBoardNote(page, file = BOARD_FILE) {
  const row = page.locator('.tree-label', { hasText: file });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
}

// Read the note straight from the API, using the token the app already holds,
// so we assert against the bytes on disk rather than anything the UI believes.
function noteOnDisk(page, file = BOARD_FILE) {
  return page.evaluate(async ({ ns, file }) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(file)}`, {
      headers: { Authorization: 'Bearer ' + t },
    });
    return r.text();
  }, { ns: NS, file });
}

function tasksFromApi(page) {
  return page.evaluate(async ({ ns, file }) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(`/api/tasks?ns=${ns}&path=${encodeURIComponent(file)}`, {
      headers: { Authorization: 'Bearer ' + t },
    });
    return r.json();
  }, { ns: NS, file: BOARD_FILE });
}

test('the Board button appears when the board is enabled', async ({ page }) => {
  await login(page);
  await openBoardNote(page);
  await expect(page.locator('button:has-text("Board")')).toBeVisible({ timeout: 10_000 });
});

test('the board renders the note\'s tasks as cards', async ({ page }) => {
  await login(page);
  await openBoardNote(page);
  await page.click('button:has-text("Board")');
  // The seeded task must appear somewhere on the board.
  await expect(page.getByText(BOARD_TASK).first()).toBeVisible({ timeout: 20_000 });
});

test('a task is parsed with the metadata written in its detail block', async ({ page }) => {
  await login(page);
  await openBoardNote(page);
  const data = await tasksFromApi(page);
  const task = (data.tasks || []).find((t) => (t.text || '').includes(BOARD_TASK));
  expect(task, 'seeded task should be parsed from the note').toBeTruthy();
  expect(task.checked).toBe(false);
  expect(task.priority).toBe('high');
  expect(task.tags).toContain('release');
  // The pre-checked task in the seed lands in the Done column.
  const done = (data.tasks || []).find((t) => (t.text || '').includes('Already finished'));
  expect(done, 'the checked seed task should be parsed too').toBeTruthy();
  expect(done.checked).toBe(true);
});

// The regression this suite exists for. Ticking a checkbox in the Live editor
// is handled inside ProseMirror: it produces no keydown and no document-level
// mousedown, so a save gate keyed on those events swallows the edit — the UI
// shows the new state, the file never changes, and a refresh silently reverts
// it. Assert against the bytes on disk, not the DOM.
test('ticking a task checkbox in the Live editor persists to the note', async ({ page }) => {
  const FILE = 'e2e-board-tick.md';
  await login(page);
  await openBoardNote(page, FILE);

  // Live is the default editor; wait for Crepe's task checkbox to mount.
  const box = page.locator('.milkdown .label-wrapper').first();
  await expect(box).toBeVisible({ timeout: 30_000 });
  expect(await noteOnDisk(page, FILE)).toContain(`[ ] ${BOARD_TASK}`);

  // Toggle it as the very first interaction with the document — no prior click
  // or keystroke, which is precisely the case that used to fail.
  await box.click();
  // Let the editor's autosave settle before asserting. Polling the note over
  // and over from inside the page competes with that save; give it a beat.
  await page.waitForTimeout(4_000);

  await expect
    .poll(() => noteOnDisk(page, FILE), { timeout: 20_000, message: 'tick should reach disk' })
    .toMatch(new RegExp(`\\[x\\]\\s+${BOARD_TASK}`));

  // And it survives a reload — the symptom the user actually sees.
  await page.reload();
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  expect(await noteOnDisk(page, FILE)).toMatch(new RegExp(`\\[x\\]\\s+${BOARD_TASK}`));
});

test('un-ticking a done task also persists', async ({ page }) => {
  const FILE = 'e2e-board-untick.md';
  await login(page);
  await openBoardNote(page, FILE);

  const box = page.locator('.milkdown .label-wrapper').first();
  await expect(box).toBeVisible({ timeout: 30_000 });
  expect(await noteOnDisk(page, FILE)).toMatch(new RegExp(`\\[x\\]\\s+${BOARD_TASK}`));

  await box.click();
  await page.waitForTimeout(4_000);

  await expect
    .poll(() => noteOnDisk(page, FILE), { timeout: 20_000, message: 'un-tick should reach disk' })
    .toMatch(new RegExp(`\\[ \\]\\s+${BOARD_TASK}`));
});

test('moving a card to Done checks the box in the note', async ({ page }) => {
  await login(page);
  await openBoardNote(page);
  // Drive the documented API the board uses, so this stays meaningful even if
  // drag-and-drop internals change; the board UI is covered by the render test.
  const moved = await page.evaluate(async ({ ns, file, text }) => {
    const t = localStorage.getItem('mdnest_token');
    const list = await (await fetch(`/api/tasks?ns=${ns}&path=${encodeURIComponent(file)}`, {
      headers: { Authorization: 'Bearer ' + t },
    })).json();
    const task = (list.tasks || []).find((x) => (x.text || '').includes(text));
    if (!task) return { error: 'task not found' };
    const r = await fetch(`/api/tasks?ns=${ns}&path=${encodeURIComponent(file)}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: task.line, raw: task.raw, toColumn: 'done' }),
    });
    return r.ok ? await r.json() : { error: r.status };
  }, { ns: NS, file: BOARD_FILE, text: BOARD_TASK });

  expect(moved.error, `move failed: ${JSON.stringify(moved)}`).toBeUndefined();
  expect(moved.checked).toBe(true);
  expect(moved.column).toBe('done');

  const disk = await noteOnDisk(page);
  expect(disk).toMatch(new RegExp(`\\[x\\]\\s+${BOARD_TASK}`));
});
