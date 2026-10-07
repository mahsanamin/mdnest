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

test('the GIF picker shows its images whole, even in a short window', async ({ page }) => {
  test.setTimeout(90_000);
  // Short enough that the messages, the GIF row and the composer compete.
  await page.setViewportSize({ width: 1100, height: 560 });
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    // A long conversation, so the message list wants all the height it can get.
    for (let i = 0; i < 25; i++) {
      await api(page, 'POST', `/api/chat?ns=${NS}&path=${encodeURIComponent(chat)}&as=agent`, `message ${i}`);
    }
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });
    await page.locator('.chat-gif-toggle').click();
    const first = page.locator('.chat-gifs .chat-gif').first();
    await expect(first).toBeVisible();
    const box = await page.evaluate(() => {
      const row = document.querySelector('.chat-gifs').getBoundingClientRect();
      const gif = document.querySelector('.chat-gifs .chat-gif').getBoundingClientRect();
      return { rowH: Math.round(row.height), gifTop: Math.round(gif.top - row.top), gifBottom: Math.round(row.bottom - gif.bottom) };
    });
    // The first row of images must fit inside the picker, not be cut by it.
    expect(box.gifTop, JSON.stringify(box)).toBeGreaterThanOrEqual(0);
    expect(box.gifBottom, `the GIF row is clipped: ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(0);
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('the message box grows with a long message, and Enter still sends it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1100, height: 760 });
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });
    const box = page.locator('textarea.chat-draft');
    const before = (await box.boundingBox()).height;
    // One long line with no Enter in it: it wraps, and the box must grow to
    // show it instead of scrolling it out of sight.
    const long = 'How did you manage the status shift, like in the current system our last status is VISA_GEN_COMPLETED and later the status is set to booked by the worker. '.repeat(3);
    await box.fill(long);
    await expect.poll(async () => (await box.boundingBox()).height).toBeGreaterThan(before + 30);
    const fits = await box.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
    expect(fits, 'the whole message is visible without scrolling').toBe(true);

    await box.press('Enter');
    await expect(box).toHaveValue('');
    await expect.poll(async () => (await box.boundingBox()).height, { timeout: 5_000 }).toBeLessThanOrEqual(before + 1);
    await expect(page.locator('.chat-bubble').last()).toContainText('VISA_GEN_COMPLETED', { timeout: 10_000 });
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('right-click on a chat in the list: copy its path, and delete another chat without closing the open one', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const a = await seed(page);
  const b = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${a.chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(a.title, { timeout: 20_000 });

    const rowB = page.locator('.chat-list-item', { hasText: b.title });
    await rowB.click({ button: 'right' });
    const menu = page.locator('.context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.context-menu-title')).toHaveText(b.title);
    await expect(menu.locator('.context-menu-item')).toHaveText(['Pin to the Pinned tab', 'Open as note', 'Copy path for CLI', 'Delete chat']);

    await menu.locator('.context-menu-item', { hasText: 'Copy path for CLI' }).click();
    await expect(menu).toBeHidden();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`^mdnest://(@[^/]+/)?${NS}/${b.chat.replace(/[.]/g, '\\.')}$`));

    await rowB.click({ button: 'right' });
    page.once('dialog', (d) => d.accept());
    await page.locator('.context-menu-item', { hasText: 'Delete chat' }).click();
    await expect(page.locator('.chat-list-item', { hasText: b.title })).toHaveCount(0, { timeout: 10_000 });
    expect((await api(page, 'GET', `/api/note?ns=${NS}&path=${encodeURIComponent(b.chat)}`)).status).toBe(404);
    // The chat that was open is still open.
    await expect(page.locator('.chat-room-title h2')).toHaveText(a.title);
  } finally {
    await cleanup(page, a.plain, a.chat, b.plain, b.chat);
  }
});

test('an agent\'s working status shows on one quiet line, and its post clears it', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });
    const line = page.getByTestId('chat-working');
    await expect(line).toHaveText('');
    const heightIdle = (await line.boundingBox()).height;

    const qs = `ns=${NS}&path=${encodeURIComponent(chat)}`;
    expect((await api(page, 'POST', `/api/chat/status?${qs}&as=codxu`, 'reviewing the API PR')).status).toBe(200);
    // The view polls every few seconds.
    await expect(line).toContainText('codxu is working: reviewing the API PR', { timeout: 10_000 });
    // Same height busy or idle, so the conversation never jumps.
    expect((await line.boundingBox()).height).toBe(heightIdle);

    await api(page, 'POST', `/api/chat?${qs}&as=codxu`, 'done: looks good');
    await expect(line).toHaveText('', { timeout: 10_000 });
    await expect(page.locator('.chat-bubble').last()).toContainText('done: looks good');
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('a role template fills the agent name and its trait into the prompt', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });
    await page.locator('.chat-btn', { hasText: /Connect an agent|Agents/ }).first().click();
    const panel = page.locator('.chat-agent');
    const name = panel.locator('input[aria-label="Agent name"]');
    const intent = panel.locator('textarea.chat-agent-intent');
    const prompt = panel.locator('pre');

    await panel.locator('.chat-role', { hasText: 'Lead Coder' }).click();
    await expect(name).toHaveValue('lead-coder');
    await expect(intent).toHaveValue(/You lead the coding/);
    await expect(prompt).toContainText('You are lead-coder in an mdnest chat');
    await expect(prompt).toContainText('start helper coders as your own sub-agents');

    // Switching role swaps the untouched defaults.
    await panel.locator('.chat-role', { hasText: /^Coder$/ }).click();
    await expect(name).toHaveValue('coder-1');
    await expect(intent).toHaveValue(/You do one task your lead gives you/);
    await expect(panel.locator('.chat-role.active')).toHaveText('Coder');

    // Clicking the active role again clears it.
    await panel.locator('.chat-role', { hasText: /^Coder$/ }).click();
    await expect(name).toHaveValue('');
    await expect(intent).toHaveValue('');
    await expect(panel.locator('.chat-role.active')).toHaveCount(0);
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('typing stays fast in a long chat', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  const chat = `__chat-lag-${Date.now()}.md`;
  await page.evaluate(async ([ns, p]) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') };
    await fetch(`/api/chat/convert?ns=${ns}&path=${encodeURIComponent(p)}&title=Lag`, { method: 'POST', headers: h });
    const body = 'Here is **some** markdown with `code`, a [link](https://example.com), a list:\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n![nod](gif:nod) @ahsan please check.';
    for (let i = 0; i < 300; i++) await fetch(`/api/chat?ns=${ns}&path=${encodeURIComponent(p)}&as=agent-${i % 3}`, { method: 'POST', headers: h, body: `#${i} ` + body });
  }, [NS, chat]);
  await page.goto(`/#!chats/${NS}/${chat}`);
  await expect(page.locator('.chat-bubble').nth(250)).toBeAttached({ timeout: 30_000 });
  const box = page.locator('textarea.chat-draft');
  await box.click();
  // time from keydown to the next painted frame, per key
  const times = await page.evaluate(async () => {
    const el = document.querySelector('textarea.chat-draft');
    const out = [];
    for (const ch of 'the quick brown fox jumps over the lazy dog') {
      const t0 = performance.now();
      el.focus();
      // simulate a real keystroke through React's onChange
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, el.value + ch);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      out.push(performance.now() - t0);
    }
    return out;
  });
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  // Each key used to re-render every message (marked + DOMPurify): a median
  // of ~66ms with 300 messages. Now typing only touches the text box and a
  // key paints in one frame (~17ms). 40ms leaves room for a slow machine and
  // still fails the old behaviour.
  expect(median, `median ms per key: ${median.toFixed(1)}`).toBeLessThan(40);
  await page.evaluate(async ([ns, p]) => { await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } }); }, [NS, chat]);
});

test('presence comes from the polls an agent already makes: waiting, thinking, working', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });
    const line = page.getByTestId('chat-working');
    const qs = `ns=${NS}&path=${encodeURIComponent(chat)}`;
    // Exactly what `mdnest chat wait --as bot` sends, from any CLI version.
    const poll = async (after) => api(page, 'GET', `/api/chat?${qs}&after=${after}&format=text&exclude=bot`);

    await poll(99);
    await expect(line).toContainText('bot is waiting', { timeout: 10_000 });
    await expect(line.locator('.chat-listening-dot')).toHaveCount(1);

    await api(page, 'POST', `/api/chat?${qs}&as=ahsan`, 'bot, can you check this?');
    await poll(0); // the poll hands bot the new message
    await expect(line).toContainText('bot is thinking', { timeout: 10_000 });
    await expect(line.locator('.chat-working-dots')).toHaveCount(1);

    // A /status post (works from any CLI and MCP post_chat) is not a message.
    const before = await page.locator('.chat-bubble').count();
    const r = await api(page, 'POST', `/api/chat?${qs}&as=bot`, '/status reading the logs');
    expect(r.status).toBe(200);
    await expect(line).toContainText('bot is working: reading the logs', { timeout: 10_000 });
    expect(await page.locator('.chat-bubble').count()).toBe(before);

    await api(page, 'POST', `/api/chat?${qs}&as=bot`, 'found it: a typo');
    await expect(line).toContainText('bot is waiting', { timeout: 10_000 });
    await expect(page.locator('.chat-bubble').last()).toContainText('found it: a typo');

    // Back to wait without posting: waiting again, not still working.
    await api(page, 'POST', `/api/chat?${qs}&as=bot`, '/status running tests');
    await expect(line).toContainText('bot is working: running tests', { timeout: 10_000 });
    await poll(99);
    await expect(line).toContainText('bot is waiting', { timeout: 10_000 });
    await expect(line).not.toContainText('working');
  } finally {
    await cleanup(page, plain, chat);
  }
});

test('an agent\'s /context report shows by its name, not as a message', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const { plain, chat, title } = await seed(page);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-room-title h2')).toHaveText(title, { timeout: 20_000 });
    const qs = `ns=${NS}&path=${encodeURIComponent(chat)}`;
    await api(page, 'POST', `/api/chat?${qs}&as=bot`, 'hello, I am here');
    await expect(page.locator('.chat-bubble').last()).toContainText('hello, I am here', { timeout: 10_000 });
    const before = await page.locator('.chat-bubble').count();

    const r = await api(page, 'POST', `/api/chat?${qs}&as=bot`, '/context 87k/200k');
    expect(r.status).toBe(200);
    const chip = page.getByTestId('chat-context');
    await expect(chip).toHaveText('44%', { timeout: 10_000 });
    await expect(chip).toHaveAttribute('title', /87k of 200k tokens/);
    await expect(chip).not.toHaveClass(/high/);
    expect(await page.locator('.chat-bubble').count()).toBe(before);

    await api(page, 'POST', `/api/chat?${qs}&as=bot`, '/context 91%');
    await expect(chip).toHaveText('91%', { timeout: 10_000 });
    await expect(chip).toHaveClass(/high/);

    const bad = await api(page, 'POST', `/api/chat?${qs}&as=bot`, '/context about half');
    expect(bad.status).toBe(400);
  } finally {
    await cleanup(page, plain, chat);
  }
});

// New messages from others must never move the view, even when you are at
// the bottom: a pill says they are there and you scroll yourself.
test('new messages show a pill instead of scrolling the chat', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const chat = `__chat-scroll-${Date.now()}.md`;
  const qs = `ns=${NS}&path=${encodeURIComponent(chat)}`;
  await page.evaluate(async ([ns, p]) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') };
    await fetch(`/api/chat/convert?ns=${ns}&path=${encodeURIComponent(p)}&title=Scroll`, { method: 'POST', headers: h });
    for (let i = 0; i < 40; i++) await fetch(`/api/chat?ns=${ns}&path=${encodeURIComponent(p)}&as=agent-${i % 2}`, { method: 'POST', headers: h, body: `message ${i}\n\nwith a second line` });
  }, [NS, chat]);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    const list = page.locator('.chat-messages');
    await expect(page.locator('.chat-bubble')).toHaveCount(40, { timeout: 20_000 });
    const gap = () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    // Opening the chat lands at the bottom.
    await expect.poll(gap).toBeLessThan(60);
    const top = await list.evaluate((el) => el.scrollTop);

    await api(page, 'POST', `/api/chat?${qs}&as=agent-0`, 'a new one\n\nthat is\n\ntall');
    await api(page, 'POST', `/api/chat?${qs}&as=agent-1`, 'and another');
    const pill = page.getByTestId('chat-new-pill');
    await expect(pill).toHaveText('2 new messages ↓', { timeout: 15_000 });
    expect(await list.evaluate((el) => el.scrollTop)).toBe(top);
    expect(await gap()).toBeGreaterThan(30);

    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect.poll(gap).toBeLessThan(60);

    // Your own post still takes you to it, and is not counted as new.
    await list.evaluate((el) => { el.scrollTop = 0; });
    await page.locator('textarea.chat-draft').fill('my reply');
    await page.locator('textarea.chat-draft').press('Enter');
    await expect(page.locator('.chat-bubble').last()).toContainText('my reply', { timeout: 10_000 });
    await expect.poll(gap).toBeLessThan(60);
    await page.waitForTimeout(4000); // let a poll bring the post back once more
    await expect(pill).toHaveCount(0);
  } finally {
    await page.evaluate(async ([ns, p]) => { await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } }); }, [NS, chat]);
  }
});

test('pin chats to the Pinned tab, and collapse the list to a strip', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const stamp = Date.now();
  const names = [`__pin-a-${stamp}.md`, `__pin-b-${stamp}.md`];
  await page.evaluate(async ([ns, ps]) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') };
    for (const p of ps) await fetch(`/api/chat/convert?ns=${ns}&path=${encodeURIComponent(p)}&title=${p.slice(2, 7)}`, { method: 'POST', headers: h });
    await fetch('/api/preferences', { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_pins: '[]' }) });
    localStorage.removeItem('mdnest_chat_tab');
    localStorage.removeItem('mdnest_chat_list_collapsed');
  }, [NS, names]);
  try {
    await page.goto(`/#!chats`);
    const row = page.locator('.chat-list-row', { hasText: names[1] });
    await expect(row).toBeVisible({ timeout: 20_000 });
    // The header's title and buttons share one line, and the title, the
    // workspace row, the tabs and each chat start at the same left edge.
    const layout = await page.evaluate(() => {
      const box = (s) => document.querySelector(s).getBoundingClientRect();
      const mid = (r) => r.top + r.height / 2;
      return {
        sameLine: Math.abs(mid(box('.chat-list-header h2')) - mid(box('.chat-list-actions'))) < 3,
        lefts: ['.chat-list-header h2', '.chat-list-scope', '.chat-tab', '.chat-list-title', '.chat-list-path'].map((s) => Math.round(box(s).left)),
      };
    });
    expect(layout.sameLine).toBe(true);
    expect(new Set(layout.lefts).size, `left edges ${layout.lefts}`).toBe(1);
    await row.hover();
    await row.getByTestId('chat-pin').click();
    await expect(row.getByTestId('chat-pin')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('chat-tab-pinned').click();
    await expect(page.locator('.chat-list-row')).toHaveCount(1);
    await expect(page.locator('.chat-list-row')).toContainText(names[1]);

    // Saved with the account, not the page: still pinned after a reload.
    await page.reload();
    await expect(page.getByTestId('chat-tab-pinned')).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
    await expect(page.locator('.chat-list-row')).toHaveCount(1);
    const saved = await page.evaluate(async () => (await (await fetch('/api/preferences', { headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } })).json()).chat_pins);
    expect(JSON.parse(saved)).toEqual([`${NS}/${names[1]}`]);

    // Collapse: the list becomes a strip of initials, and comes back.
    const wide = await page.locator('.chat-list').boundingBox();
    await page.getByRole('button', { name: 'Hide the chat list' }).click();
    const strip = page.getByTestId('chat-list-collapsed');
    await expect(strip).toBeVisible();
    expect((await strip.boundingBox()).width).toBeLessThan(wide.width / 4);
    await expect(strip.locator('.chat-rail-item')).toHaveCount(1); // the Pinned tab's chats
    await strip.locator('.chat-rail-item').click();
    await expect(page.locator('.chat-room-title h2')).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByTestId('chat-list-collapsed')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Show the chat list' }).click();
    await expect(page.locator('.chat-list-row').first()).toBeVisible();

    // Unpin from the right-click menu.
    await page.locator('.chat-list-item', { hasText: names[1] }).click({ button: 'right' });
    await page.getByText('Unpin', { exact: true }).click();
    await expect(page.locator('.chat-list-row')).toHaveCount(0);
  } finally {
    await page.evaluate(async ([ns, ps]) => {
      const h = { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') };
      for (const p of ps) await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: h });
      await fetch('/api/preferences', { method: 'PATCH', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_pins: '[]' }) });
      localStorage.removeItem('mdnest_chat_tab');
      localStorage.removeItem('mdnest_chat_list_collapsed');
    }, [NS, names]);
  }
});
