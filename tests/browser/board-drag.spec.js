// Dragging a card to another column must move the task.
//
// The whole point of the board is moving work between statuses, and nothing
// else pinned that it still works. The drag is done with real mouse steps
// (press, move past the 6px activation distance, move over the target,
// release), because dnd-kit's PointerSensor ignores a synthetic click, and the
// result is checked against the SERVER, not the DOM: an optimistic move that
// the PATCH then rejects looks right on screen for a moment and is not a move.
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

for (const scope of ['workspace', 'global']) test(`dragging a card to another column moves the task (${scope} scope)`, async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript((sc) => {
    localStorage.setItem('mdnest_taskboard_scope', sc);
    localStorage.setItem('mdnest_taskboard_mode', 'board');
  }, scope);
  const marker = `DRAGTEST-${Date.now()}`;
  const notePath = `__${marker}.md`;

  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  const boardBtn = page.locator('.toolbar-view-board');
  const ok = await boardBtn.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');

  const created = await api(page, 'POST',
    `/api/note?ns=${encodeURIComponent(NS)}&path=${encodeURIComponent(notePath)}`,
    `# Drag test\n\n- [ ] ${marker}\n`);
  expect(created.status, created.text).toBe(201);

  try {
    const sel = page.locator('.ns-select');
    if (await sel.count()) await sel.selectOption(NS);
    await boardBtn.click();
    await expect(page.locator('.tb-panel')).toBeVisible({ timeout: 30_000 });

    const board = JSON.parse((await api(page, 'GET', `/api/board?ns=${encodeURIComponent(NS)}`)).text);
    const target = board.columns.find((c) => c.id !== 'todo' && !c.done) || board.columns[1];

    // Narrow to the seeded task: in a paged column (or the global view, where
    // every workspace shares To Do) it may sit past the first 100 cards.
    await page.getByPlaceholder('Filter by text…').fill(marker);
    const card = page.locator('.tb-card', { hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });
    const targetCol = page.locator('.tb-column', { has: page.locator('.tb-column-title', { hasText: target.title }) });

    const from = await card.locator('.tb-card-head').boundingBox();
    const to = await targetCol.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 15 });
    await page.mouse.up();

    await expect(targetCol.locator('.tb-card', { hasText: marker })).toBeVisible();
    await expect.poll(async () => {
      const r = await api(page, 'GET', `/api/tasks?ns=${encodeURIComponent(NS)}`);
      const t = (JSON.parse(r.text).tasks || []).find((x) => (x.text || '').includes(marker));
      return t && t.column;
    }, { message: 'the server must record the move', timeout: 10_000 }).toBe(target.id);
  } finally {
    await api(page, 'DELETE', `/api/note?ns=${encodeURIComponent(NS)}&path=${encodeURIComponent(notePath)}`);
  }
});
