// Chat mode: how you get in, and how you get back out to where you were.
//
// These pin the flows a code review found broken in the first cut of the
// chat UI, none of which any unit test could see because they are all about
// what App.jsx does BETWEEN views:
//   - a chat note opened from the tree opens as a chat, and Back returns to
//     the note you were on before, not the chat's raw markdown;
//   - the "is this a chat?" redirect must not stay armed and fire later on
//     an ordinary keystroke;
//   - leaving chat mode reloads the note underneath, which a post may have
//     just rewritten (a stale copy 409s on the next save);
//   - Delete removes the note and returns to the list.
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

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  const chats = page.locator('.toolbar-view-chats');
  const ok = await chats.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) test.skip(true, 'chat disabled (ENABLE_CHAT)');
}

// Per test: a plain note and a chat with one message, at the namespace ROOT
// with unique names. Not in a folder: other specs pick "the first folder in
// the tree", and the suite runs in parallel, so a folder created and deleted
// here pulled it out from under them. The title is unique too, because
// specs share the namespace's chat list.
async function seed(page) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const plain = `__chat-${id}-plain.md`;
  const chat = `__chat-${id}-room.md`;
  const title = `Room ${id}`;
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

async function openFromTree(page, file) {
  await page.locator('.sidebar .tree-row', { hasText: file }).first().click();
}

test('a chat clicked in the tree opens as a chat, and Back returns to the note before it', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#${NS}/${plain}`);
    await page.reload();
    await expect(page.locator('.toolbar-path')).toContainText(plain, { timeout: 20_000 });

    await openFromTree(page, chat);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 15_000 });
    await expect(page.locator('.chat-bubble')).toContainText('first message');

    const back = page.locator('.toolbar-chats-back');
    await expect(back).toContainText(plain);
    await back.click();
    await expect(page.locator('.chat-panel')).toHaveCount(0);
    await expect(page.locator('.toolbar-path')).toContainText(plain);
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('after leaving chat mode, typing in a note does not pull you back into chats', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#${NS}/${plain}`);
    await page.reload();
    await expect(page.locator('.toolbar-path')).toContainText(plain, { timeout: 20_000 });
    await openFromTree(page, chat);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 15_000 });
    await page.locator('.toolbar-chats-back').click();

    // Click the plain note that is already open, then edit it: the old
    // redirect stayed armed across exactly this and fired on the keystroke.
    await page.locator('.sidebar .tree-row', { hasText: plain }).first().click();
    await page.locator('.editor-mode-toggle button', { hasText: 'Basic' }).click();
    await page.locator('.editor-textarea').click();
    await page.keyboard.type(' more');
    await page.waitForTimeout(1500);
    await expect(page.locator('.chat-panel')).toHaveCount(0);
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('leaving chat mode reloads the note underneath, so it is never stale', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    // Open the chat's own note (the raw markdown), then enter chat mode on top of it.
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });
    await page.locator('.chat-room-path').click();
    await expect(page.locator('.editor-textarea')).toHaveValue(/first message/, { timeout: 15_000 });
    // Live is locked for a chat note: the rich editor would flatten the tag.
    await expect(page.locator('.editor-mode-toggle button', { hasText: 'Live' })).toBeDisabled();

    await page.locator('.toolbar-view-chats').click();
    await page.locator('.chat-list-item', { hasText: title }).click();
    await page.locator('.chat-draft').fill('posted while the note was underneath');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-bubble').last()).toContainText('posted while the note was underneath');

    await page.locator('.toolbar-chats-back').click();
    await expect(page.locator('.editor-textarea')).toHaveValue(/posted while the note was underneath/, { timeout: 15_000 });
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('Delete removes the chat note after confirming, and Cancel keeps it', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });

    page.once('dialog', (d) => d.dismiss());
    await page.locator('.chat-delete').click();
    await expect(page.locator('.chat-room-title h2')).toHaveText(title);
    expect((await api(page, 'GET', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`)).status).toBe(200);

    page.once('dialog', (d) => d.accept());
    await page.locator('.chat-delete').click();
    await expect(page.locator('.chat-room-title')).toHaveCount(0);
    expect((await api(page, 'GET', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`)).status).toBe(404);
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('the agent panel puts the typed intent into the prompt, and × or Esc closes it', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });

    const openBtn = page.locator('.chat-btn', { hasText: /Connect an agent|Agents/ }).first();
    await openBtn.click();
    const panel = page.locator('.chat-agent');
    await expect(panel).toBeVisible();
    await panel.locator('input[aria-label="Agent name"]').fill('reviewer');
    await panel.locator('textarea.chat-agent-intent').fill('Review the API pull requests.');
    const prompt = panel.locator('pre');
    await expect(prompt).toContainText('You are reviewer in an mdnest chat');
    await expect(prompt).toContainText('Your job in this chat:\n  Review the API pull requests.');
    await expect(prompt).toContainText('--as reviewer --pick auto');

    // A visible close button, not only "click Connect an agent again".
    await panel.locator('.chat-agent-close').click();
    await expect(panel).toHaveCount(0);

    // And Esc, with focus anywhere in the chat.
    await openBtn.click();
    await expect(panel).toBeVisible();
    await page.locator('.chat-room-title h2').click();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  } finally {
    await cleanup(page, plain, chat);
  }
});
