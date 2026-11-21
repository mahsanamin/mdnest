// An outside change (the CLI, an agent) to a note someone has open, on a
// DEFAULT install: live collaboration off, so no websocket and no shared
// editing. Reported: the agent's change "finished", and the person with the
// note open never saw it, or got a conflict banner and lost their own typing.
//
// The change is made through the API the way the CLI's append does it
// (PATCH /api/note). Runs in tests/e2e-browser.sh, which is single mode, and
// live collaboration only ever runs in multi mode. With live collaboration on
// it skips: those installs are covered by collab-cli.spec.js and
// cli-vs-typing.spec.js in tests/e2e-collab-multi.sh.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

async function api(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b, cache: 'no-store' });
    return { status: r.status, text: await r.text() };
  }, [method, url, body]);
}
const noteUrl = (file) => `/api/note?ns=${NS}&path=${encodeURIComponent(file)}`;
const agentAppends = (page, file, text) => api(page, 'PATCH', noteUrl(file), text);
const onDisk = async (page, file) => (await api(page, 'GET', noteUrl(file))).text;

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
  if (cfg.liveCollab) test.skip(true, 'live collaboration is on; see collab-cli.spec.js');
}

async function open(page, file, mode) {
  await page.goto(`/#${NS}/${file}`);
  await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
  await page.locator('.toolbar button', { hasText: new RegExp(`^${mode}$`) }).click();
  if (mode === 'Basic') {
    const ta = page.locator('.editor-wrapper textarea');
    await expect(ta).toBeVisible({ timeout: 20_000 });
    return () => ta.inputValue();
  }
  const pm = page.locator('.editor-wrapper .ProseMirror');
  await expect(pm).toBeVisible({ timeout: 20_000 });
  return () => pm.innerText();
}

async function caretAfter(page, mode, text) {
  if (mode === 'Basic') {
    await page.locator('.editor-wrapper textarea').evaluate((el, t) => {
      const i = el.value.indexOf(t) + t.length; el.focus(); el.setSelectionRange(i, i);
    }, text);
  } else {
    await page.locator('.editor-wrapper .ProseMirror p', { hasText: text }).first().click();
    await page.keyboard.press('End');
  }
}

function watchBanners(page) {
  return page.evaluate(() => {
    window.__banner = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.conflict-banner')) {
        const t = (el.textContent || '').slice(0, 80);
        if (!window.__banner.includes(t)) window.__banner.push(t);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

for (const mode of ['Basic', 'Live']) {
  test(`${mode}: an agent's append to an idle open note shows within seconds`, async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const file = `default-idle-${mode}-${Date.now()}.md`;
    expect((await api(page, 'POST', noteUrl(file), '# Note\n\nfirst line\n')).status).toBe(201);
    try {
      const shown = await open(page, file, mode);
      await expect.poll(shown, { timeout: 5_000 }).toContain('first line');
      expect((await agentAppends(page, file, '\nline from the agent\n')).status).toBe(200);
      await expect.poll(shown, { timeout: 15_000 }).toContain('line from the agent');
    } finally {
      await api(page, 'DELETE', noteUrl(file));
    }
  });

  // Bug: `mdnest chat new` on an empty note open in the Live editor. The
  // editor took the new header in, then saved its own reformatted copy
  // (`---` became `***` plus a heading underline), so the note stopped being
  // a chat. An editor nobody typed in must never write over an outside change.
  test(`${mode}: a chat header written to an open empty note is not rewritten`, async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const file = `default-chatnew-${mode}-${Date.now()}.md`;
    expect((await api(page, 'POST', noteUrl(file), '')).status).toBe(201);
    try {
      await open(page, file, mode);
      expect((await api(page, 'POST', `/api/chat/convert?ns=${NS}&path=${encodeURIComponent(file)}&title=T`)).status).toBe(200);
      const written = await onDisk(page, file);
      expect(written.startsWith('---')).toBe(true);
      // Long enough for the note poll (5 s) to bring it in and an autosave
      // to follow.
      await page.waitForTimeout(9_000);
      expect(await onDisk(page, file)).toBe(written);
      expect((await api(page, 'GET', `/api/chat?ns=${NS}&path=${encodeURIComponent(file)}`)).status).toBe(200);
    } finally {
      await api(page, 'DELETE', noteUrl(file));
    }
  });

  test(`${mode}: an agent's append while someone types keeps both, with no banner`, async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const file = `default-typing-${mode}-${Date.now()}.md`;
    expect((await api(page, 'POST', noteUrl(file), '# Note\n\nmy paragraph\n\nend\n')).status).toBe(201);
    try {
      const shown = await open(page, file, mode);
      await expect.poll(shown, { timeout: 5_000 }).toContain('my paragraph');
      await caretAfter(page, mode, 'my paragraph');
      await watchBanners(page);

      // Type without a pause long enough to autosave; the agent appends
      // a few seconds in, so the tab holds unsaved text built on the old copy.
      const words = [];
      const started = Date.now();
      let appended = false;
      for (let n = 0; Date.now() - started < 10_000; n += 1) {
        const w = ` w${String(n).padStart(2, '0')}`;
        for (const ch of w) { await page.keyboard.type(ch); await page.waitForTimeout(120); }
        words.push(w.trim());
        if (!appended && Date.now() - started > 3000) {
          expect((await agentAppends(page, file, '\nline from the agent\n')).status).toBe(200);
          appended = true;
        }
      }
      const typed = words.join(' ');

      // Both reach the disk, and both are on screen.
      await expect.poll(() => onDisk(page, file), { timeout: 15_000 }).toContain(`my paragraph ${typed}`);
      expect(await onDisk(page, file)).toContain('line from the agent');
      await expect.poll(shown, { timeout: 10_000 }).toContain('line from the agent');
      expect(await shown()).toContain(`my paragraph ${typed}`);

      // The caret stayed where the person was typing.
      await page.keyboard.type(' tail');
      await expect.poll(() => onDisk(page, file), { timeout: 15_000 }).toContain(`${typed} tail`);
      expect(await page.evaluate(() => window.__banner)).toEqual([]);
    } finally {
      await api(page, 'DELETE', noteUrl(file));
    }
  });

  // Bug: typing in a Live note with front matter saved the editor's copy of
  // it, where `---` had become `***` plus a heading underline, so the header
  // (a chat's, a deck's) was gone. Front matter is kept out of the editor and
  // written back unchanged.
  test(`${mode}: typing in a note with front matter keeps the header`, async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const file = `default-fm-${mode}-${Date.now()}.md`;
    const header = '---\ntitle: Kept\ntags: [a, b]\n---\n\n';
    expect((await api(page, 'POST', noteUrl(file), `${header}# Note\n\nmy paragraph\n`)).status).toBe(201);
    try {
      const shown = await open(page, file, mode);
      await expect.poll(shown, { timeout: 5_000 }).toContain('my paragraph');
      await caretAfter(page, mode, 'my paragraph');
      await page.keyboard.type(' typed');
      await expect.poll(() => onDisk(page, file), { timeout: 15_000 }).toContain('my paragraph typed');
      expect((await onDisk(page, file)).startsWith(header)).toBe(true);
    } finally {
      await api(page, 'DELETE', noteUrl(file));
    }
  });

}

// The Live editor without shared editing shows a note's front matter in a
// header box above the body (the editor itself would rewrite the fences).
test('Live: the front matter is shown, and editing it saves a valid --- block', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const file = `default-fm-box-${Date.now()}.md`;
  expect((await api(page, 'POST', noteUrl(file), '---\ntitle: Kept\ntags: [a, b]\n---\n\n# Note\n\nmy paragraph\n')).status).toBe(201);
  try {
    const shown = await open(page, file, 'Live');
    const box = page.getByTestId('live-frontmatter');
    await expect(box).toBeVisible({ timeout: 10_000 });
    await expect(box).toHaveValue('title: Kept\ntags: [a, b]');
    // The header is not in the body as a rule and a heading.
    await expect.poll(shown, { timeout: 5_000 }).toContain('my paragraph');
    expect(await shown()).not.toContain('title: Kept');

    await box.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nextra: 1');
    await expect.poll(() => onDisk(page, file), { timeout: 15_000 })
      .toBe('---\ntitle: Kept\ntags: [a, b]\nextra: 1\n---\n\n# Note\n\nmy paragraph\n');
  } finally {
    await api(page, 'DELETE', noteUrl(file));
  }
});

test('Live: a chat still opens as a chat after typing in another note', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const chatsOn = await page.locator('.toolbar-view-chats').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (!chatsOn) test.skip(true, 'chat disabled (ENABLE_CHAT)');
  const id = Date.now();
  const file = `default-fm-other-${id}.md`;
  const chat = `default-fm-chat-${id}.md`;
  expect((await api(page, 'POST', noteUrl(file), '# Note\n\nmy paragraph\n')).status).toBe(201);
  expect((await api(page, 'POST', `/api/chat/convert?ns=${NS}&path=${encodeURIComponent(chat)}&title=Still%20a%20chat`)).status).toBe(201);
  try {
    // Both files were made after the page loaded: reload so the tree lists
    // them (open() only changes the hash).
    await page.reload();
    await expect(page.locator('.sidebar .tree-row', { hasText: chat }).first()).toBeVisible({ timeout: 20_000 });
    await open(page, file, 'Live');
    await caretAfter(page, 'Live', 'my paragraph');
    await page.keyboard.type(' typed');
    await expect.poll(() => onDisk(page, file), { timeout: 15_000 }).toContain('my paragraph typed');

    await page.locator('.sidebar .tree-row', { hasText: chat }).first().click({ timeout: 20_000 });
    await expect(page.locator('.chat-room-title h2')).toHaveText('Still a chat', { timeout: 15_000 });
    expect((await onDisk(page, chat)).startsWith('---\n')).toBe(true);
    expect((await api(page, 'GET', `/api/chat?ns=${NS}&path=${encodeURIComponent(chat)}`)).status).toBe(200);
  } finally {
    await api(page, 'DELETE', noteUrl(file));
    await api(page, 'DELETE', noteUrl(chat));
  }
});
