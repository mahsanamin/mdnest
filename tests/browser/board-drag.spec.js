// Dragging a card to another column must move the task — and it must work
// for the gestures people actually make, not only a pixel-perfect one.
//
// The board "worked" when a card was grabbed by its thin title strip and
// released squarely over another column's cards, and failed silently (the card
// snapped back) for everything else: grabbing the card body, releasing in the
// empty lane below a short column's last card, or aiming at the collapsed
// Done strip. So each of those is a case here.
//
// The drag is done with real mouse steps (press, move past the 6px activation
// distance, move over the target, release), because dnd-kit's PointerSensor
// ignores a synthetic click, and the result is checked against the SERVER,
// not the DOM: an optimistic move that the PATCH then rejects looks right on
// screen for a moment and is not a move.
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

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// Seeds one task, opens the board on it, runs `gesture`, and asserts the
// server now has the task in the column `gesture` returned.
async function runCase(page, scope, gesture) {
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

    // Narrow to the seeded task: in a paged column (or the global view, where
    // every workspace shares To Do) it may sit past the first 100 cards.
    await page.getByPlaceholder('Filter by text…').fill(marker);
    const card = page.locator('.tb-card', { hasText: marker });
    await expect(card).toBeVisible({ timeout: 20_000 });

    const board = JSON.parse((await api(page, 'GET', `/api/board?ns=${encodeURIComponent(NS)}`)).text);
    const colLocator = (c) => page.locator('.tb-column', { has: page.locator('.tb-column-title', { hasText: c.title }) });
    const targetId = await gesture({ page, card, board, colLocator });

    await expect.poll(async () => {
      const r = await api(page, 'GET', `/api/tasks?ns=${encodeURIComponent(NS)}`);
      const t = (JSON.parse(r.text).tasks || []).find((x) => (x.text || '').includes(marker));
      return t && t.column;
    }, { message: 'the server must record the move', timeout: 10_000 }).toBe(targetId);
  } finally {
    await api(page, 'DELETE', `/api/note?ns=${encodeURIComponent(NS)}&path=${encodeURIComponent(notePath)}`);
  }
}

const openTarget = (board) => board.columns.find((c) => c.id !== 'todo' && !c.done) || board.columns[1];

for (const scope of ['workspace', 'global']) {
  test(`drag by the title onto another column's cards (${scope} scope)`, async ({ page }) => {
    await runCase(page, scope, async ({ card, board, colLocator }) => {
      const target = openTarget(board);
      const to = await colLocator(target).boundingBox();
      await drag(page, center(await card.locator('.tb-card-head').boundingBox()), { x: to.x + to.width / 2, y: to.y + 60 });
      return target.id;
    });
  });
}

test('drag by the card BODY, not just its title strip', async ({ page }) => {
  await runCase(page, 'workspace', async ({ card, board, colLocator }) => {
    const target = openTarget(board);
    const to = await colLocator(target).boundingBox();
    // The card's own padding at its bottom-left corner: not the title strip,
    // not a control — the spot a hand naturally grabs on a busy card.
    const c = await card.boundingBox();
    await drag(page, { x: c.x + 5, y: c.y + c.height - 3 }, { x: to.x + to.width / 2, y: to.y + 60 });
    return target.id;
  });
});

test('release in the empty lane below a short column', async ({ page }) => {
  await runCase(page, 'workspace', async ({ page: p, card, board, colLocator }) => {
    const target = openTarget(board);
    const to = await colLocator(target).boundingBox();
    const vh = p.viewportSize().height;
    const y = Math.min(to.y + to.height + 120, vh - 10);
    test.skip(y <= to.y + to.height, 'target column fills the viewport; no empty lane to test');
    await drag(p, center(await card.locator('.tb-card-head').boundingBox()), { x: to.x + to.width / 2, y });
    return target.id;
  });
});

test('drop onto the collapsed Done column', async ({ page }) => {
  await runCase(page, 'workspace', async ({ card, board, colLocator }) => {
    const done = board.columns.find((c) => c.done || c.id === 'done');
    test.skip(!done, 'no done column');
    const col = colLocator(done);
    test.skip(!(await col.evaluate((e) => e.classList.contains('collapsed'))), 'Done is not collapsed here');
    await drag(page, center(await card.locator('.tb-card-head').boundingBox()), center(await col.boundingBox()));
    return done.id;
  });
});

test('hold at the edge to reach an off-screen column, then drop on it', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await runCase(page, 'workspace', async ({ card, board, colLocator }) => {
    const last = [...board.columns].reverse().find((c) => !c.done);
    const col = colLocator(last);
    const boardBox = await page.locator('.tb-board').boundingBox();
    const vw = page.viewportSize().width;
    test.skip((await col.boundingBox()).x + 40 < vw, 'last column already on screen');

    const from = center(await card.locator('.tb-card-head').boundingBox());
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
    const edgeX = boardBox.x + boardBox.width - 10;
    await page.mouse.move(edgeX, from.y, { steps: 15 });
    // Keep nudging while held at the edge until the column is fully visible.
    await expect.poll(async () => {
      await page.mouse.move(edgeX + (Math.random() < 0.5 ? -1 : 1), from.y);
      const b = await col.boundingBox();
      return b.x + b.width <= vw;
    }, { timeout: 10_000 }).toBe(true);
    const b = await col.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 40, { steps: 10 });
    await page.mouse.up();
    return last.id;
  });
});

// The whole card is a drag surface now, so its controls must still be clicks.
test('card controls still click (edit opens the editor, no drag)', async ({ page }) => {
  await runCase(page, 'workspace', async ({ card }) => {
    await card.getByRole('button', { name: '✎ edit' }).click();
    await expect(page.locator('.tb-editor-grid')).toBeVisible();
    return 'todo'; // unmoved
  });
});
