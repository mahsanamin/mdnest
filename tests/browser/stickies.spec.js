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

// THIS SUITE DESTROYS THE BOARD OF WHATEVER ACCOUNT IT SIGNS IN AS.
//
// That is not a hypothetical. Running it against the repo owner's own account
// on the dev instance silently deleted his real stickies, repeatedly, because
// every test starts by wiping the board and nothing in the code objected.
// A sticky exists nowhere else — no namespace, no git remote, no history — so
// there was nothing to recover from.
//
// The guard is here rather than in a habit, because a habit is exactly what
// failed. Point the suite at a throwaway account (`e2e` by default, which is
// what tests/e2e-browser.sh provisions), or say explicitly that you accept
// losing this account's board.
const ALLOW_WIPE = process.env.MDNEST_ALLOW_BOARD_WIPE === '1';
const THROWAWAY = /^(e2e|test)/i;

test.beforeAll(() => {
  if (!THROWAWAY.test(USER) && !ALLOW_WIPE) {
    throw new Error(
      `Refusing to run: this suite deletes the sticky board of "${USER}", and a ` +
      `sticky exists nowhere else — there is no backup to restore from.\n` +
      `Run it as a throwaway account (MDNEST_USER=e2e MDNEST_PASSWORD=e2epass123), ` +
      `or set MDNEST_ALLOW_BOARD_WIPE=1 if you really mean to lose that board.`,
    );
  }
});

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

// The drawer's open state is remembered per browser now, so a test cannot
// assume it starts closed — clicking the toolbar button would CLOSE it.
async function openPanel(page) {
  if (await page.locator('.stickies-panel').count()) {
    await expect(page.locator('.stickies-panel')).toBeVisible();
    return;
  }
  await page.locator('.toolbar-stickies').click();
  await expect(page.locator('.stickies-panel')).toBeVisible();
}

// Idempotent on purpose. The board has its own URL, so after a reload it is
// already open — and clicking the toolbar button then fails, because the
// full-screen board is covering the toolbar.
async function openBoard(page) {
  if (await page.locator('.stickies-board').count()) {
    await expect(page.locator('.stickies-board')).toBeVisible();
    return;
  }
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
// Grab point: a few pixels inside the card's top-left corner. That is the
// card's own padding — clear of the title, the buttons and the text — now
// that the whole card is the drag surface rather than a dedicated strip.
async function grabPoint(page) {
  const b = await page.locator('.sticky-card').first().boundingBox();
  return { x: b.x + 4, y: b.y + 4 };
}

async function dragCard(page, dx, dy) {
  const g = await grabPoint(page);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x + dx, g.y + dy, { steps: 12 });
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
    await page.locator('.sticky-card .sticky-body').fill('call the bank');

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
    await expect(page.locator('.sticky-card .sticky-body')).toHaveValue('call the bank');
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

    // Body text is a note, not a task — it must not reach the badge.
    await page.locator('.sticky-card .sticky-body').fill('just a note');
    await expect(page.locator('.toolbar-stickies .comment-badge')).toHaveCount(0);

    await page.locator('.sticky-add-item').click();
    await expect(page.locator('.toolbar-stickies .comment-badge')).toHaveCount(0); // blank row
    await page.locator('.sticky-items textarea').fill('something to do');
    await expect(page.locator('.toolbar-stickies .comment-badge')).toHaveText('1');

    await page.locator('.sticky-items input[type=checkbox]').check();
    await expect(page.locator('.toolbar-stickies .comment-badge')).toHaveCount(0);
  });

  test('a dragged sticky keeps its position across a reload', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);

    await page.locator('.stickies-add.board').click();
    await page.locator('.sticky-card .sticky-body').fill('move me');
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
    await page.locator('.sticky-card .sticky-body').fill('do not move');
    await expectSavedCount(page, 1);

    // A click WITH the jitter a real one carries. Playwright's .click() moves
    // the pointer zero pixels, which never reaches the drag handler at all —
    // so it passes whether or not the threshold exists, and proves nothing.
    // Two pixels is what a hand actually does.
    const g = await grabPoint(page);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await page.mouse.move(g.x + 2, g.y + 1);
    await page.mouse.up();

    await page.waitForTimeout(900); // past the 500 ms save debounce
    expect(await savedPosition(page)).toEqual({ x: null, y: null });
  });

  test('the board and the drawer show the same cards', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();
    await page.locator('.sticky-card .sticky-body').fill('written in the drawer');
    await expectSavedCount(page, 1);

    await page.locator('.stickies-expand').click();
    await expect(page.locator('.stickies-board')).toBeVisible();
    await expect(page.locator('.stickies-panel')).toHaveCount(0);
    await expect(page.locator('.sticky-card .sticky-body')).toHaveValue('written in the drawer');

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
    await page.locator('.sticky-card .sticky-body').fill('scattered');
    await expectSavedCount(page, 1);
    await dragCard(page, 240, 140);
    await expect.poll(async () => (await savedPosition(page)).x, { timeout: 10_000 })
      .toBeGreaterThan(100);

    page.once('dialog', (d) => d.accept());
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

  test('the card controls still work on the full-screen board', async ({ page }) => {
    // The regression this exists for: the drag handler calls setPointerCapture
    // on the top bar, which redirects the following pointerup there — so the
    // browser fired `click` on the BAR rather than on the button that was
    // pressed, and the colour and delete buttons silently stopped working the
    // moment the board was opened. They work in the drawer, which has no drag
    // handler, so the drawer's coverage says nothing about this.
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);
    await page.locator('.stickies-add.board').click();

    await page.locator('.sticky-color-btn').click();
    await expect(page.locator('.sticky-colors')).toBeVisible();
    await page.locator('.sticky-colors .sticky-green').click();
    await expect(page.locator('.sticky-card.sticky-green')).toHaveCount(1);

    // And it reached the server, not just the DOM.
    await expect.poll(async () => page.evaluate(async () => {
      const t = localStorage.getItem('mdnest_token');
      const d = await (await fetch('/api/stickies', { headers: { Authorization: 'Bearer ' + t } })).json();
      return d.stickies[0]?.color ?? null;
    }), { timeout: 10_000 }).toBe('green');

    await page.locator('.sticky-delete').click();
    await expect(page.locator('.sticky-card')).toHaveCount(0);
  });

  test('a sticky holds a title and several to-dos', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();

    await page.locator('.sticky-title').fill('Errands');
    await page.locator('.sticky-add-item').click();
    await page.locator('.sticky-items textarea').first().fill('buy milk');
    // Enter opens the next line, the way any list behaves.
    await page.locator('.sticky-items textarea').first().press('Enter');
    await page.locator('.sticky-items textarea').nth(1).fill('call bank');
    await expect(page.locator('.sticky-items li')).toHaveCount(2);

    await page.locator('.sticky-items input[type=checkbox]').first().check();
    await expectSavedCount(page, 1);

    await page.reload();
    await openPanel(page);
    await expect(page.locator('.sticky-title')).toHaveValue('Errands');
    await expect(page.locator('.sticky-items li')).toHaveCount(2);
    // The tick survives too, not just the rows.
    await expect(page.locator('.sticky-items input[type=checkbox]').first()).toBeChecked();
    await expect(page.locator('.sticky-items li.done')).toHaveCount(1);
  });

  test('a card is struck through only when its whole checklist is done', async ({ page }) => {
    // `items.every()` is vacuously true on an empty list, so a plain note must
    // not read as finished the moment it is created.
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();
    await expect(page.locator('.sticky-card.done')).toHaveCount(0);

    await page.locator('.sticky-add-item').click();
    await page.locator('.sticky-items textarea').fill('the only task');
    await expect(page.locator('.sticky-card.done')).toHaveCount(0);

    await page.locator('.sticky-items input[type=checkbox]').check();
    await expect(page.locator('.sticky-card.done')).toHaveCount(1);
  });

  test('the full board has its own URL and a refresh returns to it', async ({ page }) => {
    // The board replaces the whole view, so landing back on the last note
    // after a refresh is wrong. The side panel deliberately has no route — it
    // overlays a note, and the note is what the URL should describe.
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);
    expect(page.url()).toContain('#!stickies');

    await page.reload();
    await expect(page.locator('.stickies-board')).toBeVisible({ timeout: 20_000 });

    // Closing lands on a real note rather than an empty editor: the namespace
    // and last file are restored underneath the board.
    await page.locator('.stickies-board .stickies-close').click();
    await expect(page.locator('.stickies-board')).toHaveCount(0);
    expect(page.url()).not.toContain('!stickies');
  });

  test('the drawer does not take over the URL', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    const files = page.locator('.tree-row:has(.tree-icon-svg.file)');
    await expect(files.first()).toBeVisible({ timeout: 20_000 });
    await files.first().click();
    // Wait for the note hash to land before capturing it. The click resolves
    // before the URL is rewritten, so reading it immediately captures the
    // bare namespace and the test then "fails" on the note arriving.
    await expect.poll(() => page.url()).toMatch(/#[^/]+\/.+/);
    const noteUrl = page.url();

    await openPanel(page);
    await expect(page.locator('.stickies-panel')).toBeVisible();
    expect(page.url()).toBe(noteUrl);
  });

  test('a long to-do wraps instead of being cut off', async ({ page }) => {
    // It used to be an <input>, which cannot wrap: the text was still stored,
    // but everything past the card's edge was invisible. The check is that the
    // row grows TALLER than one line — an input would stay exactly one line
    // high no matter how much was typed into it.
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();
    await page.locator('.sticky-add-item').click();

    const row = page.locator('.sticky-items textarea').first();
    const oneLine = (await row.boundingBox()).height;
    await row.fill('renew the domain before it lapses and then update the DNS records for the staging host');
    await expect.poll(async () => (await row.boundingBox()).height, { timeout: 5_000 })
      .toBeGreaterThan(oneLine * 1.8);

    // And nothing is clipped horizontally: the text fits the row it is in.
    const clipped = await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, 'the to-do is still being cut off at the card edge').toBe(false);
  });

  test('a sticky can be resized, and the width sticks', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);
    await page.locator('.stickies-add.board').click();
    await page.locator('.sticky-title').fill('wide one');

    const card = page.locator('.sticky-card').first();
    const before = (await card.boundingBox()).width;

    const grip = page.locator('.sticky-resize').first();
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 150, g.y + g.height / 2, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => (await card.boundingBox()).width, { timeout: 5_000 })
      .toBeGreaterThan(before + 100);

    // Stored, not just painted. Polled, and with optional chaining: every
    // change resets the 500 ms debounce, so a card can be on screen before any
    // save has fired — and a callback that throws on an empty board aborts the
    // poll instead of retrying.
    await expect.poll(async () => page.evaluate(async () => {
      const t = localStorage.getItem('mdnest_token');
      const d = await (await fetch('/api/stickies', { headers: { Authorization: 'Bearer ' + t } })).json();
      return d.stickies[0]?.w ?? 0;
    }), { timeout: 10_000 }).toBeGreaterThan(before + 100);

    await page.reload();
    await expect(page.locator('.stickies-board')).toBeVisible({ timeout: 20_000 });
    expect((await page.locator('.sticky-card').first().boundingBox()).width)
      .toBeGreaterThan(before + 100);
  });

  test('resizing a card does not also move it', async ({ page }) => {
    // The grip sits inside the card, so without stopPropagation the resize
    // pointerdown would reach the card and start a move at the same time.
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);
    await page.locator('.stickies-add.board').click();

    const grip = page.locator('.sticky-resize').first();
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 120, g.y + g.height / 2, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => savedPosition(page), { timeout: 5_000 })
      .toEqual({ x: null, y: null });
  });

  test('a failed load cannot wipe the board', async ({ page }) => {
    // The sharpest failure this feature can have, and it shipped in the first
    // draft. fetchStickies used to fail soft and return [] on any error, the
    // way fetchPreferences does — but the two are not symmetric: a preference
    // is PATCHed key by key, a board is PUT WHOLE. So a GET that failed showed
    // an empty board indistinguishable from a genuinely empty one, and the
    // next character typed replaced the real board with just that card.
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();
    await page.locator('.sticky-title').fill('do not lose me');
    await expectSavedCount(page, 1);

    // Reload with the GET broken, exactly as it is while the backend restarts.
    await page.route('**/api/stickies', (route) =>
      route.request().method() === 'GET' ? route.abort() : route.continue());
    await page.reload();
    await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
    await openPanel(page);

    // No cards to edit, and no way to add one — that is the guarantee. An
    // "empty board" here would be indistinguishable from the real thing.
    await expect(page.locator('.stickies-retry')).toBeVisible();
    await expect(page.locator('.sticky-card')).toHaveCount(0);
    await expect(page.locator('.stickies-add')).toBeDisabled();

    // The server still holds the real board.
    await page.unroute('**/api/stickies');
    await expectSavedCount(page, 1);

    // And Try again recovers it rather than needing a reload.
    await page.locator('.stickies-retry').click();
    await expect(page.locator('.sticky-title')).toHaveValue('do not lose me');
  });

  test('Enter moves the cursor onto the new to-do', async ({ page }) => {
    // It added the row but left the caret behind, because the focus lookup
    // still searched for `input[type=text]` after the row became a textarea
    // (to make long to-dos wrap). Nothing threw — the querySelector simply
    // found nothing — so typing carried on appending to the previous line.
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();
    await page.locator('.sticky-add-item').click();

    const rows = page.locator('.sticky-items textarea');
    await rows.first().fill('first');
    await rows.first().press('Enter');
    await expect(rows).toHaveCount(2);

    // Type without clicking anywhere: it must land in the NEW row.
    await page.keyboard.type('second');
    await expect(rows.nth(0)).toHaveValue('first');
    await expect(rows.nth(1)).toHaveValue('second');
  });

  test('Tidy up asks before discarding every position', async ({ page }) => {
    // One click, no undo, and it sits next to "+ New sticky" in the header.
    await signIn(page);
    await clearBoard(page);
    await openBoard(page);
    await page.locator('.stickies-add.board').click();
    await page.locator('.sticky-title').fill('placed');
    await expectSavedCount(page, 1);
    await dragCard(page, 240, 140);
    await expect.poll(async () => (await savedPosition(page)).x, { timeout: 10_000 })
      .toBeGreaterThan(100);

    // Dismissed: the position stays.
    page.once('dialog', (d) => d.dismiss());
    await page.locator('.stickies-tidy').click();
    await page.waitForTimeout(900); // past the save debounce
    expect((await savedPosition(page)).x).toBeGreaterThan(100);
  });

  test('an untitled sticky wastes no space above its text', async ({ page }) => {
    // The title used to sit on its own line under the controls, so an
    // untitled card showed a blank band across the top of every sticky.
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);
    await page.locator('.stickies-add').click();

    const card = page.locator('.sticky-card').first();
    const title = page.locator('.sticky-title');
    const del = page.locator('.sticky-delete');
    const [c, t, d] = await Promise.all([card.boundingBox(), title.boundingBox(), del.boundingBox()]);

    // Title and controls share a row.
    expect(Math.abs((t.y + t.height / 2) - (d.y + d.height / 2))).toBeLessThan(8);
    // And nothing sits above that row but the card's own padding.
    expect(t.y - c.y).toBeLessThan(16);
  });

  test('the drawer survives a refresh, without owning the URL', async ({ page }) => {
    // A panel you deliberately opened should still be there after a reload —
    // the same expectation the view mode and the sidebar width already meet.
    // It stays out of the URL though: the drawer sits on top of a note, and a
    // link you share should not force the recipient's stickies open.
    await signIn(page);
    await clearBoard(page);
    const files = page.locator('.tree-row:has(.tree-icon-svg.file)');
    await expect(files.first()).toBeVisible({ timeout: 20_000 });
    await files.first().click();
    await expect.poll(() => page.url()).toMatch(/#[^/]+\/.+/);

    await openPanel(page);
    const noteUrl = page.url();
    expect(noteUrl).not.toContain('!stickies');

    await page.reload();
    await expect(page.locator('.stickies-panel')).toBeVisible({ timeout: 20_000 });
    expect(page.url()).toBe(noteUrl);

    // And closing it is remembered too, or the toggle would feel one-way.
    await page.locator('.stickies-panel .stickies-close').click();
    await page.reload();
    await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.stickies-panel')).toHaveCount(0);
  });

  test('the drawer leaves no bare strip above it', async ({ page }) => {
    // .main carries a margin-right the width of the panel, so the toolbar is
    // already squeezed clear of it. A top offset on the panel therefore bought
    // nothing and left a band of bare page background in the top-right corner.
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);

    const panel = await page.locator('.stickies-panel').boundingBox();
    expect(panel.y, 'bare strip above the stickies panel').toBeLessThanOrEqual(1);

    // The toolbar is still fully reachable beside it, which is what the offset
    // was protecting. Polled, because .main animates its margin-right over
    // 150ms — measured immediately, the toolbar still reads as full width and
    // the assertion fails against perfectly correct layout.
    await expect.poll(async () => {
      const btn = await page.locator('.toolbar-stickies').boundingBox();
      return btn.x + btn.width;
    }, { timeout: 5_000 }).toBeLessThanOrEqual(panel.x + 1);
  });

  test('deleting a sticky removes it on the server too', async ({ page }) => {
    await signIn(page);
    await clearBoard(page);
    await openPanel(page);

    await page.locator('.stickies-add').click();
    await page.locator('.sticky-card .sticky-body').fill('temporary');
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
