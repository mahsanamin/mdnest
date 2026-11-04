// The side panel's Chat tab: a chat docked on the right, next to the note.
//
// Pins the acceptance checks of the chat-windows feature that only show up
// between views, in App.jsx:
//   - Pin moves a full-screen chat into the panel and returns to the note;
//     the note and the chat are both on screen and do not overlap;
//   - switching tabs, Expand and Pin keep the unsent draft;
//   - the panel's width and tab survive a reload, and the width is clamped
//     when the window gets narrower;
//   - where there is no room to dock (or on a phone), there is no Pin button
//     and the docked chat steps aside instead of covering the editor;
//   - a saved chat that is gone falls back to the chat list on reload;
//   - Escape closes the panel.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

test.use({ viewport: { width: 1440, height: 900 } });

async function api(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b });
    return { status: r.status, text: await r.text() };
  }, [method, url, body]);
}

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  const chats = page.locator('.toolbar-view-chats');
  const ok = await chats.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'chat disabled (ENABLE_CHAT)');
}

// A plain note and a chat at the namespace root, unique per test (see
// chat.spec.js for why not in a folder).
async function seed(page) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const plain = `__dock-${id}-plain.md`;
  const chat = `__dock-${id}-room.md`;
  const title = `Dock ${id}`;
  expect((await api(page, 'POST', `/api/note?ns=${NS}&path=${encodeURIComponent(plain)}`, '# Plain note\n\nhello\n')).status).toBe(201);
  expect((await api(page, 'POST', `/api/chat/convert?ns=${NS}&path=${encodeURIComponent(chat)}&title=${encodeURIComponent(title)}`)).status).toBe(201);
  expect((await api(page, 'POST', `/api/chat?ns=${NS}&path=${encodeURIComponent(chat)}&as=agent`, 'first message')).status).toBe(201);
  return { plain, chat, title };
}

async function cleanup(page, ...paths) {
  for (const p of paths) {
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(p)}`).catch(() => {});
  }
}

const panel = (page) => page.locator('[data-testid=side-panel]');

// The editor column's right edge, once .main's margin transition is over.
async function settledEditor(page) {
  let box = null;
  await expect.poll(async () => {
    const before = await page.locator('.split-view').boundingBox();
    await page.waitForTimeout(250);
    box = await page.locator('.split-view').boundingBox();
    return Math.round(before.width) === Math.round(box.width);
  }).toBe(true);
  return box;
}
const dockedDraft = (page) => panel(page).locator('.chat-draft');

// Open the note, open the chat full screen from the toolbar, and pin it.
async function dock(page, { plain, title }) {
  await page.goto(`/#${NS}/${plain}`);
  await page.reload();
  await expect(page.locator('.toolbar-path')).toContainText(plain, { timeout: 20_000 });
  await page.locator('.toolbar-view-chats').click();
  await page.locator('.chat-list-item', { hasText: title }).first().click();
  await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 15_000 });
  await page.getByTestId('chat-pin-side').click();
  await expect(panel(page).locator('.chat-room-title h2')).toHaveText(title, { timeout: 15_000 });
  await expect(page.locator('.toolbar-path')).toContainText(plain);
}

test('Pin docks the chat next to the note, both usable and not overlapping', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const s = await seed(page);
  try {
    await dock(page, s);
    await expect(panel(page).locator('.chat-bubble')).toContainText('first message');
    // The URL still describes the note, not the chat.
    expect(page.url()).toContain(`#${NS}/${s.plain}`);

    const editor = await settledEditor(page);
    const p = await panel(page).boundingBox();
    expect(editor.x + editor.width).toBeLessThanOrEqual(p.x + 1);
    expect(editor.width).toBeGreaterThanOrEqual(400);
    // The default width: min(40vw, 960px).
    expect(Math.round(p.width)).toBe(576);

    // What is under the middle of the editor is the editor, not the panel.
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.split-view'),
      [editor.x + editor.width / 2, editor.y + editor.height / 2]);
    expect(hit).toBe(true);

    // The chat is usable: a message posted from the panel lands.
    await dockedDraft(page).fill('posted from the side');
    await dockedDraft(page).press('Enter');
    await expect(panel(page).locator('.chat-bubble').last()).toContainText('posted from the side');
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});

test('switching tabs, Expand and Pin keep the unsent draft', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const s = await seed(page);
  try {
    await dock(page, s);
    await dockedDraft(page).fill('half a thought');

    // Stickies tab and back.
    await page.getByTestId('side-panel-tab-stickies').click();
    await expect(panel(page).locator('.stickies-add')).toBeVisible();
    await expect(page.locator('.chat-draft')).toHaveCount(0); // hidden tab is unmounted, so it does not poll
    await page.getByTestId('side-panel-tab-chat').click();
    await expect(dockedDraft(page)).toHaveValue('half a thought');

    // Tabs are real tabs: arrow keys move between them.
    await page.getByTestId('side-panel-tab-chat').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('side-panel-tab-stickies')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('side-panel-tab-chat')).toHaveAttribute('aria-selected', 'true');

    // Expand: the same chat, full screen, same draft; the panel steps aside.
    await page.getByTestId('chat-expand').click();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.chat-panel:not(.docked) .chat-draft')).toHaveValue('half a thought');

    // Pin it back.
    await page.getByTestId('chat-pin-side').click();
    await expect(dockedDraft(page)).toHaveValue('half a thought');
    await expect(page.locator('.toolbar-path')).toContainText(s.plain);
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});

test('Expand and Pin keep the spot you were reading, not the newest message', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const s = await seed(page);
  try {
    for (let i = 1; i <= 40; i++) {
      await api(page, 'POST', `/api/chat?ns=${NS}&path=${encodeURIComponent(s.chat)}&as=agent`, `line ${i}\n\nmore text so it takes room`);
    }
    await dock(page, s);
    const docked = panel(page).locator('.chat-messages');
    await expect(panel(page).locator('.chat-bubble').last()).toContainText('line 40');
    // Scroll up to the message "line 5".
    await panel(page).locator('.chat-msg', { hasText: 'line 5' }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await expect.poll(() => docked.evaluate((el) => el.scrollTop)).toBeLessThan(800);

    const topMessage = (scroller) => scroller.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const msg = [...el.querySelectorAll('.chat-msg')].find((m) => m.getBoundingClientRect().bottom > top + 2);
      return msg?.textContent || '';
    });
    expect(await topMessage(docked)).toContain('line 5');

    await page.getByTestId('chat-expand').click();
    const full = page.locator('.chat-panel:not(.docked) .chat-messages');
    await expect(page.locator('.chat-panel:not(.docked) .chat-bubble').last()).toContainText('line 40');
    await expect.poll(() => topMessage(full)).toContain('line 5');

    await page.getByTestId('chat-pin-side').click();
    await expect(panel(page).locator('.chat-bubble').last()).toContainText('line 40');
    await expect.poll(() => topMessage(docked)).toContain('line 5');
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});

test('width and tab survive a reload, and the width is clamped to the window', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const s = await seed(page);
  try {
    await dock(page, s);
    const handle = panel(page).locator('.stickies-resize-handle');
    await handle.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.round((await panel(page).boundingBox()).width)).toBe(576 + 80);

    await page.reload();
    await expect(panel(page).locator('.chat-room-title h2')).toHaveText(s.title, { timeout: 20_000 });
    expect(Math.round((await panel(page).boundingBox()).width)).toBe(656);

    // Narrower window: the panel shrinks so the editor keeps 400px.
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect.poll(async () => Math.round((await panel(page).boundingBox()).width)).toBe(1200 - 260 - 400);
    const editor = await settledEditor(page);
    expect(editor.width).toBeGreaterThanOrEqual(399);
    expect(editor.x + editor.width).toBeLessThanOrEqual((await panel(page).boundingBox()).x + 1);

    // No room to dock at all: the docked chat steps aside instead of
    // covering the editor, and comes back when there is room again.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => page.locator('.main').evaluate((el) => getComputedStyle(el).marginRight)).toBe('0px');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(panel(page).locator('.chat-room-title h2')).toHaveText(s.title);
    // The stored width was never overwritten by the clamping.
    expect(Math.round((await panel(page).boundingBox()).width)).toBe(656);
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});

test('no Pin where a chat cannot dock: full-screen chats work as before', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1024, height: 800 });
  await signIn(page);
  const s = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${s.chat}`);
    await page.reload();
    await expect(page.locator('.chat-room-title h2')).toHaveText(s.title, { timeout: 20_000 });
    await expect(page.getByTestId('chat-pin-side')).toHaveCount(0);
    // And the side panel offers no Chat tab.
    await page.locator('.toolbar-chats-back').click();
    await page.locator('.toolbar-stickies').click();
    await expect(page.locator('.stickies-panel')).toBeVisible();
    await expect(page.getByTestId('side-panel-tab-chat')).toHaveCount(0);
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});

test('a docked chat that is gone falls back to the list on reload; Escape closes the panel', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const s = await seed(page);
  try {
    await dock(page, s);
    // The chat is deleted elsewhere while this browser remembers it.
    await cleanup(page, s.chat);
    await page.reload();
    await expect(panel(page).locator('.chat-list')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).locator('.chat-error')).toHaveCount(0);
    await expect(page.locator('.toolbar-path')).toContainText(s.plain);

    await panel(page).locator('.chat-list-header button').first().focus();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.toolbar-path')).toContainText(s.plain);
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});

// A private chat you were taken off answers 403. In the panel that must look
// like the 404 case: back to the list, no error line and no part of the chat.
// (The real multi-user flow is in tests/e2e-private-chats-multi.sh on the
// server side; here the 403 is simulated so the panel's handling is pinned
// without a Postgres stack.)
test('a docked chat you lost access to says so, and falls back to the list on reload', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const s = await seed(page);
  try {
    await dock(page, s);
    await page.route((url) => url.pathname === '/api/chat' && url.searchParams.get('path') === s.chat, (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"access denied"}' }));
    // While it is open, the next poll says you were removed and stops.
    await expect(panel(page).getByTestId('chat-gone')).toContainText('no longer have access', { timeout: 15_000 });
    await expect(dockedDraft(page)).toHaveCount(0);

    // After a reload, the panel goes back to the list instead.
    await page.reload();
    await expect(panel(page).locator('.chat-list')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).locator('.chat-error')).toHaveCount(0);
    await expect(panel(page).locator('.chat-room')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('mdnest_docked_chat'))).toBe(null);
  } finally {
    await page.unroute('**/*').catch(() => {});
    await cleanup(page, s.plain, s.chat);
  }
});

// Chat follows the workspace in the main dropdown. A pinned chat used to stay
// on screen after switching workspace, and the chat had its own workspace
// picker, so a chat could be shown that did not belong to the workspace
// around it. Now switching shows the other workspace's chats, and switching
// back brings the pinned chat back.
test('a pinned chat follows the main workspace and comes back when you return', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const s = await seed(page);
  try {
    await dock(page, s);
    // No workspace picker inside chat: the main dropdown is the only one.
    await expect(panel(page).locator('.chat-ns-select')).toHaveCount(0);

    await page.locator('.ns-select').selectOption('zz_e2e_target');
    await expect(panel(page).locator('.chat-room')).toHaveCount(0, { timeout: 15_000 });
    await expect(panel(page).locator('.chat-list')).toBeVisible({ timeout: 15_000 });
    await expect(panel(page).locator('.chat-list-item', { hasText: s.title })).toHaveCount(0);

    await page.locator('.ns-select').selectOption(NS);
    await expect(panel(page).locator('.chat-room-title h2')).toHaveText(s.title, { timeout: 15_000 });
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});

test('full-screen chats show the main workspace, with no picker of their own', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const s = await seed(page);
  try {
    await page.goto(`/#${NS}/${s.plain}`);
    await page.reload();
    await expect(page.locator('.toolbar-path')).toContainText(s.plain, { timeout: 20_000 });
    await page.locator('.toolbar-view-chats').click();
    await expect(page.locator('.chat-list-item', { hasText: s.title }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.chat-ns-select')).toHaveCount(0);
    await expect(page.locator('.chat-list-ns')).toHaveText(NS);
  } finally {
    await cleanup(page, s.plain, s.chat);
  }
});
