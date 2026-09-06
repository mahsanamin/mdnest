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
