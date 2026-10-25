// An outside change merged into the Live editor right after a keystroke must
// not be overwritten by that keystroke's save.
//
// Milkdown's listener reports markdownUpdated 200 ms after an edit, and it
// serializes the document of the last USER transaction. An outside change is
// applied with addToHistory: false, which the listener skips. So when the
// merge landed inside those 200 ms, the editor reported its text from before
// the merge, the app saved it, and the outside change was gone from the file
// (in a shared note it came back later as a line written twice). The note
// poll's request is held here so the merge lands right after a keystroke,
// and the outside change is in the paragraph being typed in (on its other
// line), which is the merge path that applies with addToHistory: false.
//
// Runs in tests/e2e-browser.sh (single mode: no live collaboration, so the
// note poll is what brings the outside change in).
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const EDITOR = '.editor-wrapper .ProseMirror';

async function api(page, method, file, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b, cache: 'no-store' });
    return { status: r.status, text: await r.text() };
  }, [method, `/api/note?ns=${NS}&path=${encodeURIComponent(file)}`, body]);
}

test('an outside change merged right after a keystroke survives that keystroke', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { try { localStorage.setItem('mdnest_editor_mode', 'live'); } catch { /* ignore */ } });
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
  test.skip(!!(cfg.liveCollab && cfg.sharedEditing), 'the note poll only runs where the note is not shared');

  const file = `debounce-merge-${Date.now()}.md`;
  expect((await api(page, 'POST', file, '# Debounce\n\nalpha line\nbeta line\n\nlast line\n')).status).toBe(201);
  // Hold the next read of this note once armed: that is the note poll.
  let armed = false;
  let held = false;
  let release;
  const released = new Promise((r) => { release = r; });
  await page.route((u) => u.pathname === '/api/note' && u.searchParams.get('path') === file, async (route) => {
    if (armed && !held && route.request().method() === 'GET') {
      held = true;
      await released;
    }
    await route.continue();
  });
  try {
    await page.goto(`/#${NS}/${file}`);
    await expect(page.locator(EDITOR)).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    await page.getByText('beta line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed', { delay: 20 });
    await expect.poll(async () => (await api(page, 'GET', file)).text, { timeout: 15_000 }).toContain('beta line typed');

    // Someone else changes the other line; the poll's request for it is held.
    const now = (await api(page, 'GET', file)).text;
    expect((await api(page, 'PUT', file, now.replace('alpha line', 'alpha line outside'))).status).toBe(200);
    armed = true;
    await expect.poll(() => held, { timeout: 15_000, message: 'the note poll never asked' }).toBe(true);

    // A keystroke, and the merge lands inside its 200 ms report window.
    await page.keyboard.type('X');
    release();

    await page.waitForTimeout(3000);
    await expect(page.locator(EDITOR)).toContainText('alpha line outside');
    await expect.poll(async () => {
      const t = (await api(page, 'GET', file)).text;
      return { typed: t.includes('beta line typedX'), outside: t.split('alpha line outside').length - 1 };
    }, { timeout: 15_000 }).toEqual({ typed: true, outside: 1 });
  } finally {
    release();
    await api(page, 'DELETE', file);
  }
});

// Markdown drops a paragraph's trailing space. When an outside change was
// merged into the paragraph the person was typing at the end of, the space
// they had just typed vanished and their next word was glued to the last
// one ("typedX" for "typed X").
test('a merge into the paragraph being typed keeps the space just typed', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { try { localStorage.setItem('mdnest_editor_mode', 'live'); } catch { /* ignore */ } });
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
  test.skip(!!(cfg.liveCollab && cfg.sharedEditing), 'the note poll only runs where the note is not shared');

  const file = `space-merge-${Date.now()}.md`;
  expect((await api(page, 'POST', file, '# Space\n\nalpha line\nbeta line\n\nlast line\n')).status).toBe(201);
  let armed = false;
  let held = false;
  let release;
  const released = new Promise((r) => { release = r; });
  await page.route((u) => u.pathname === '/api/note' && u.searchParams.get('path') === file, async (route) => {
    if (armed && !held && route.request().method() === 'GET') {
      held = true;
      await released;
    }
    await route.continue();
  });
  try {
    await page.goto(`/#${NS}/${file}`);
    await expect(page.locator(EDITOR)).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
    await page.getByText('beta line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed', { delay: 20 });
    await expect.poll(async () => (await api(page, 'GET', file)).text, { timeout: 15_000 }).toContain('beta line typed');
    const now = (await api(page, 'GET', file)).text;
    expect((await api(page, 'PUT', file, now.replace('alpha line', 'alpha line outside'))).status).toBe(200);
    armed = true;
    await expect.poll(() => held, { timeout: 15_000, message: 'the note poll never asked' }).toBe(true);
    // A space, the merge, then the next word.
    await page.keyboard.type(' ');
    release();
    await page.waitForTimeout(1500);
    await page.keyboard.type('next', { delay: 20 });
    await expect(page.locator(EDITOR)).toContainText('alpha line outside');
    await expect.poll(async () => (await api(page, 'GET', file)).text, { timeout: 15_000 }).toContain('beta line typed next');
  } finally {
    release();
    await api(page, 'DELETE', file);
  }
});
