// The toolbar's Chats | Pages | Stickies group, on the right: one place for
// all three. Each opens the side panel on its tab (or, where the panel does
// not fit, its view full screen), shows pressed while it is showing, and
// closes it when clicked again. The left of the bar keeps only note
// controls. Pages appears only with ENABLE_PAGES (pages.spec.js and
// pages-off.spec.js); this spec runs where pages are off.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const FILE = process.env.MDNEST_SEED_FILE || 'e2e-seed.md';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await page.goto(`/#${NS}/${FILE}`);
  await expect(page.locator('.toolbar-path')).toContainText(FILE, { timeout: 20_000 });
}

const btn = (page, id) => page.getByTestId(`toolbar-${id}`);
const panel = (page) => page.getByTestId('side-panel');

// Toolbar controls that visibly collide (same rule as toolbar-fit.spec.js).
async function overlaps(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('.toolbar button, .toolbar .toolbar-path-base')].filter((e) => e.getBoundingClientRect().width);
    const hit = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const x = els[i], y = els[j];
        if (x.contains(y) || y.contains(x)) continue;
        const a = x.getBoundingClientRect(), b = y.getBoundingClientRect();
        if (a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1) hit.push(`${x.className} ∩ ${y.className}`);
      }
    }
    return hit;
  });
}
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('one group on the right: Chats then Stickies, icons and labels, nothing on the left', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const ids = await page.locator('.toolbar-panel-group .toolbar-panel-btn').evaluateAll((bs) => bs.map((b) => b.dataset.testid));
  const chatOn = ids.includes('toolbar-chats');
  expect(ids).toEqual([...(chatOn ? ['toolbar-chats'] : []), 'toolbar-stickies']);
  for (const id of ids) {
    const b = page.getByTestId(id);
    await expect(b.locator('svg')).toBeVisible();
    await expect(b.locator('.toolbar-panel-label')).toBeVisible();
    await expect(b).toHaveAttribute('aria-pressed', 'false');
  }
  // The group sits right of the note controls, just before the ⋯ menu.
  const group = await page.locator('.toolbar-panel-group').boundingBox();
  const more = await page.locator('.toolbar-more-btn').boundingBox();
  const path = await page.locator('.toolbar-path').boundingBox();
  expect(group.x).toBeGreaterThan(path.x + path.width - 1);
  expect(more.x).toBeGreaterThan(group.x + group.width - 1);
  // No Chats or Pages button anywhere else on the bar.
  const stray = await page.locator('.toolbar button').evaluateAll((bs) => bs
    .filter((b) => !b.closest('.toolbar-panel-group') && !b.closest('.toolbar-more-menu'))
    .filter((b) => b.getBoundingClientRect().width && /^(Chats|Pages)$/.test((b.textContent || '').trim()))
    .map((b) => b.className));
  expect(stray).toEqual([]);
  await expect(page.locator('.toolbar-view-chats, .toolbar-view-pages')).toHaveCount(0);
  expect(await overlaps(page)).toEqual([]);
});

test('each button opens its tab, shows pressed, and closes the panel when clicked again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await btn(page, 'stickies').click();
  await expect(panel(page)).toBeVisible();
  await expect(btn(page, 'stickies')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).locator('.stickies-add')).toBeVisible();
  if (await btn(page, 'chats').count()) {
    await btn(page, 'chats').click();
    await expect(page.getByTestId('side-panel-tab-chat')).toHaveAttribute('aria-selected', 'true');
    await expect(btn(page, 'chats')).toHaveAttribute('aria-pressed', 'true');
    await expect(btn(page, 'stickies')).toHaveAttribute('aria-pressed', 'false');
    // The full chats view is one ⤢ away, and comes back to the panel.
    await panel(page).getByTestId('side-panel-expand').click();
    await expect(page.locator('.chat-list').first()).toBeVisible({ timeout: 15_000 });
    await expect(btn(page, 'chats')).toHaveAttribute('aria-pressed', 'true');
    await btn(page, 'chats').click(); // pressed: closes the full view
    await expect(page.locator('.toolbar-path')).toContainText(FILE, { timeout: 10_000 });
    await btn(page, 'chats').click(); // the panel's Chat tab is showing again: close it
  } else {
    await btn(page, 'stickies').click();
  }
  await expect(panel(page)).toHaveCount(0);
  for (const id of ['chats', 'stickies']) {
    if (await btn(page, id).count()) await expect(btn(page, id)).toHaveAttribute('aria-pressed', 'false');
  }
});

test('a narrow toolbar keeps the icons, drops the labels, and names them in tooltips', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await signIn(page);
  for (const b of await page.locator('.toolbar-panel-btn').all()) {
    await expect(b).toBeVisible();
    await expect(b.locator('.toolbar-panel-label')).toBeHidden();
    expect(await b.getAttribute('title')).toBeTruthy();
    expect(await b.getAttribute('aria-label')).toMatch(/^(Chats|Pages|Stickies)$/);
  }
  await expect(page.locator('.toolbar-more-btn')).toBeVisible();
  expect(await overlaps(page)).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
});

test('where a chat cannot dock, Chats opens the full chats view', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 768 });
  await signIn(page);
  test.skip(!(await btn(page, 'chats').count()), 'chat disabled (ENABLE_CHAT)');
  await btn(page, 'chats').click();
  await expect(page.locator('.chat-list').first()).toBeVisible({ timeout: 15_000 });
  await expect(panel(page)).toHaveCount(0);
  await expect(btn(page, 'chats')).toHaveAttribute('aria-pressed', 'true');
  await btn(page, 'chats').click();
  await expect(page.locator('.toolbar-path')).toContainText(FILE, { timeout: 10_000 });
});

for (const scheme of ['dark', 'light']) {
  test(`phone, ${scheme}: big icons, nothing collides, each view opens full screen and closes back`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    for (const b of await page.locator('.toolbar-panel-btn').all()) {
      const box = await b.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(40);
      expect(box.height).toBeGreaterThanOrEqual(40);
    }
    expect(await overlaps(page)).toEqual([]);
    expect(await noSidewaysScroll(page)).toBe(true);

    // Stickies: the full board, with a way back.
    await btn(page, 'stickies').click();
    await expect(page.locator('.stickies-board')).toBeVisible({ timeout: 10_000 });
    await expect(btn(page, 'stickies')).toHaveAttribute('aria-pressed', 'true');
    // The board covers the screen; its own close returns to the note.
    await expect(page.locator('.stickies-board .stickies-collapse')).toHaveCount(0);
    await page.locator('.stickies-board .stickies-close').click();
    await expect(page.locator('.stickies-board')).toHaveCount(0);
    await expect(btn(page, 'stickies')).toHaveAttribute('aria-pressed', 'false');

    // Chats: the full chats list; the button (pressed) brings the note back.
    if (await btn(page, 'chats').count()) {
      await btn(page, 'chats').click();
      await expect(page.locator('.chat-list').first()).toBeVisible({ timeout: 15_000 });
      await expect(btn(page, 'chats')).toHaveAttribute('aria-pressed', 'true');
      expect(await overlaps(page)).toEqual([]);
      await btn(page, 'chats').click();
      await expect(page.locator('.chat-list')).toHaveCount(0);
    }
  });
}

test('with the side panel open on a small laptop the toolbar stays one row; the view switch moves into ⋯', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('mdnest_comment_width', '2000'); } catch { /* private mode */ } });
  await page.setViewportSize({ width: 1024, height: 768 });
  await signIn(page);
  await btn(page, 'stickies').click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(400);
  const rows = await page.evaluate(() => {
    const tb = document.querySelector('.toolbar');
    const kids = [...tb.children].filter((c) => c.getBoundingClientRect().width);
    const top = Math.min(...kids.map((c) => c.getBoundingClientRect().top));
    return kids.filter((c) => c.getBoundingClientRect().top > top + 20).map((c) => c.className);
  });
  expect(rows, 'controls pushed onto a second row').toEqual([]);
  for (const b of await page.locator('.toolbar-panel-btn').all()) await expect(b).toBeVisible();
  await expect(page.locator('.toolbar-more-btn')).toBeVisible();
  expect(await overlaps(page)).toEqual([]);
  await expect(page.locator('.toolbar > .toolbar-view-toggle')).toBeHidden();
  await page.locator('.toolbar-more-btn').click();
  await expect(page.getByRole('menuitemradio', { name: /Split view/ })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /Preview only/ }).click();
  await page.locator('.toolbar-more-btn').click();
  await expect(page.getByRole('menuitemradio', { name: /Preview only/ })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: /Editor only/ }).click();
});
