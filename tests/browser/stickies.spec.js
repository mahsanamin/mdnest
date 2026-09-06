// The sticky board, end to end in a real browser.
//
// stickies.test.js pins the board rules and stickies_test.go pins the API.
// What only a browser can show is that they are actually connected: that
// typing into a card reaches the SERVER (not just React state), that it is
// still there after a reload with storage cleared, and that the two right-edge
// drawers do not end up stacked on top of each other.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

// The board is server-side, so clearing browser storage does not reset it.
// Every test starts from an empty one or they leak into each other.
async function clearBoard(page) {
  await page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    await fetch('/api/stickies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ stickies: [] }),
    });
  });
  await page.reload();
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

const openPanel = (page) => page.locator('.toolbar-stickies').click();

async function openBoard(page) {
  await openPanel(page);
  await page.locator('.stickies-expand').click();
  await expect(page.locator('.stickies-board')).toBeVisible();
}

// Read one card's stored position straight from the server.
async function savedPosition(page, index = 0) {
  return page.evaluate(async (i) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch('/api/stickies', { headers: { Authorization: 'Bearer ' + t } });
    const d = await r.json();
    const c = (d.stickies || [])[i];
    return c ? { x: c.x ?? null, y: c.y ?? null } : null;
  }, index);
}

// Drag a card by its top bar. Stepped, because the board ignores movement
// under a few pixels — a single jump would look like a click, which is
// exactly the case the threshold exists for.
async function dragCard(page, dx, dy) {
  const handle = page.locator('.sticky-card .sticky-card-top').first();
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

// Wait until the SERVER holds the expected number of cards.
//
// Deliberately not "wait for the Saving… indicator to clear": that span is
// also empty before the save starts, so the assertion can match the idle
// state it was meant to wait past and pass without proving anything. Polling
// the API is the only reading that cannot be vacuous.
async function expectSavedCount(page, n) {
  await expect.poll(async () => page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch('/api/stickies', { headers: { Authorization: 'Bearer ' + t } });
    const d = await r.json();
    return (d.stickies || []).length;
  }), { timeout: 10_000 }).toBe(n);
}

test.describe('stickies', () => {
  test('a sticky typed in one session survives a reload', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);

    await openPanel(page);
    await expect(page.locator('.stickies-panel')).toBeVisible();
    await page.locator('.stickies-add').click();
    await page.locator('.sticky-card textarea').fill('call the bank');

    await expectSavedCount(page, 1);

    // Clear everything the browser keeps, so what comes back can only have
    // come from the server.
    await page.evaluate(() => {
      const t = localStorage.getItem('mdnest_token');
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('mdnest_token', t);
    });
    await page.reload();
    await openPanel(page);
    await expect(page.locator('.sticky-card textarea')).toHaveValue('call the bank');
  });

  test('the board is reachable with no file open', async ({ page }) => {
    // Comments are about the open file and are hidden without one. Stickies
    // are about the person, and an empty editor is exactly when someone jots
    // one down — so the button must be there before anything is selected.
    await signIn(page);
    await expect(page.locator('.toolbar-stickies')).toBeVisible();
    await openPanel(page);
    await expect(page.locator('.stickies-panel')).toBeVisible();
  });

  test('only one right-edge drawer is open at a time', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await expect(page.locator('.stickies-panel')).toBeVisible();

    // A file row is .tree-row wrapping a .tree-icon-svg.file — a folder row
    // has the same .tree-row class, so matching on that alone would open a
    // folder and leave no file selected, which silently disables everything
    // below.
    const files = page.locator('.tree-row:has(.tree-icon-svg.file)');
    await expect(files.first()).toBeVisible({ timeout: 20_000 });
    await files.first().click();

    // Whether there is a comment button at all is a property of the SERVER
    // (comments need multi mode + live collab), so ask the server. Counting
    // the DOM straight after the click answers a different question — React
    // has not rendered the button yet — and the first draft of this test
    // skipped itself on every run because of exactly that race.
    const collab = await page.evaluate(async () => (await (await fetch('/api/config')).json()).liveCollab);
    test.skip(!collab, 'comments are disabled on this instance');

    const comments = page.locator('.toolbar-comments');
    await expect(comments).toBeVisible({ timeout: 20_000 });
    await comments.click();
    await expect(page.locator('.comment-sidebar')).toBeVisible();
    await expect(page.locator('.stickies-panel')).toHaveCount(0);

    await openPanel(page);
    await expect(page.locator('.stickies-panel')).toBeVisible();
    await expect(page.locator('.comment-sidebar')).toHaveCount(0);
  });

  test('the badge counts unfinished stickies, not empty cards', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);

    // A fresh card is a blank box, not a task yet.
    await page.locator('.stickies-add').click();
    await expect(page.locator('.toolbar-stickies .comment-badge')).toHaveCount(0);

    await page.locator('.sticky-card textarea').fill('something to do');
    await expect(page.locator('.toolbar-stickies .comment-badge')).toHaveText('1');

    await page.locator('.sticky-check input').check();
    await expect(page.locator('.toolbar-stickies .comment-badge')).toHaveCount(0);
  });

  test('a dragged sticky keeps its position across a reload', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);

    await page.locator('.stickies-add.board').click();
    await page.locator('.sticky-card textarea').fill('move me');
    await expectSavedCount(page, 1);

    // A card that has never been dragged has NO position — that is what lets
    // the board lay it out on a grid instead of stacking everything at 0,0.
    expect(await savedPosition(page)).toEqual({ x: null, y: null });

    await dragCard(page, 260, 160);
    await expect.poll(async () => (await savedPosition(page)).x, { timeout: 10_000 })
      .toBeGreaterThan(100);

    const after = await savedPosition(page);
    await page.reload();
    await openBoard(page);
    expect(await savedPosition(page)).toEqual(after);

    // And it is actually painted there, not just stored.
    const box = await page.locator('.sticky-card').first().boundingBox();
    expect(Math.abs(box.x - after.x)).toBeLessThan(40);
  });

  test('a click on a card does not move it', async ({ page }) => {
    // Every pointer-down carries a pixel or two of jitter. Without a movement
    // threshold each one writes a new position and marks the board unsaved,
    // so simply tapping a card would nudge it.
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);

    await page.locator('.stickies-add.board').click();
    await page.locator('.sticky-card textarea').fill('do not move');
    await expectSavedCount(page, 1);

    // A click WITH the jitter a real one carries. Playwright's .click() moves
    // the pointer zero pixels, which never reaches the drag handler at all —
    // so it passes whether or not the threshold exists, and proves nothing.
    // Two pixels is what a hand actually does.
    const h = await page.locator('.sticky-card .sticky-card-top').first().boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 2, h.y + h.height / 2 + 1);
    await page.mouse.up();

    await page.waitForTimeout(900); // past the 500 ms save debounce
    expect(await savedPosition(page)).toEqual({ x: null, y: null });
  });

  test('the board and the drawer show the same cards', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();
    await page.locator('.sticky-card textarea').fill('written in the drawer');
    await expectSavedCount(page, 1);

    await page.locator('.stickies-expand').click();
    await expect(page.locator('.stickies-board')).toBeVisible();
    await expect(page.locator('.stickies-panel')).toHaveCount(0);
    await expect(page.locator('.sticky-card textarea')).toHaveValue('written in the drawer');

    // Collapsing goes back to the drawer, not to nothing.
    await page.locator('.stickies-collapse').click();
    await expect(page.locator('.stickies-panel')).toBeVisible();
    await expect(page.locator('.stickies-board')).toHaveCount(0);
  });

  test('Escape leaves the full-screen board', async ({ page }) => {
    // The board covers the entire app, so without a keyboard way out someone
    // who opened it by accident has to hunt for a small icon.
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.stickies-board')).toHaveCount(0);
    await expect(page.locator('.stickies-panel')).toBeVisible();
  });

  test('Tidy up returns dragged cards to the grid', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);

    await page.locator('.stickies-add.board').click();
    await page.locator('.sticky-card textarea').fill('scattered');
    await expectSavedCount(page, 1);
    await dragCard(page, 240, 140);
    await expect.poll(async () => (await savedPosition(page)).x, { timeout: 10_000 })
      .toBeGreaterThan(100);

    await page.locator('.stickies-tidy').click();
    // Tidy clears the stored position rather than writing grid coordinates, so
    // the cards reflow with the window afterwards instead of being frozen at
    // whatever width they were tidied on.
    await expect.poll(async () => (await savedPosition(page)).x, { timeout: 10_000 })
      .toBeNull();
  });

  test('the board falls back to a flowing grid on a phone', async ({ page }) => {
    // Free positioning on a 380px screen makes a board you have to pan around
    // to read one card, so below the breakpoint the canvas stops being a
    // canvas and dragging is off.
    await page.setViewportSize({ width: 390, height: 780 });
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);
    await page.locator('.stickies-add.board').click();

    await expect(page.locator('.stickies-canvas-scroll.flow')).toBeVisible();
    await expect(page.locator('.sticky-card.draggable')).toHaveCount(0);
    const pos = await page.locator('.sticky-card').first().evaluate((el) => getComputedStyle(el).position);
    expect(pos).not.toBe('absolute');
  });

  test('deleting a sticky removes it on the server too', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);

    await page.locator('.stickies-add').click();
    await page.locator('.sticky-card textarea').fill('temporary');
    await expectSavedCount(page, 1);

    await page.locator('.sticky-delete').click();
    await expect(page.locator('.sticky-card')).toHaveCount(0);
    await expectSavedCount(page, 0);

    // A delete is a PUT of the array without that card, so this is the check
    // that the whole-board replace really replaces rather than merges.
    await page.reload();
    await openPanel(page);
    await expect(page.locator('.sticky-card')).toHaveCount(0);
  });
});
