// An update from outside must not move your caret or your scroll position.
//
// A collaborator's typing or save, or a reload, replaced the whole Live
// document (replaceAll), which threw the caret to the end of the note and the
// view followed it: "my cursor jumps to the end while someone else types".
// Updates are now applied as the smallest changed range, comparing blocks
// without the heading ids a plugin adds after load (with them, the first
// heading always looked changed and the range started at 0). Live
// collaboration needs multi mode, so the test reports liveCollab on and
// stands in for the collaboration socket: a fake collaborator's live typing
// arrives exactly as it would from the server, while the editor has focus.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const DIR = 'e2e-keep-cursor';
const FILE = `${DIR}/long.md`;
const para = (i, extra = '') => `Paragraph ${i} with a few words so the note is long.${extra}`;
const doc = (edits = {}) => '# Cursor\n\n' + Array.from({ length: 50 }, (_, i) => para(i, edits[i] || '')).join('\n\n') + '\n';

async function api(page, method, path, body) {
  return page.evaluate(async ([m, ns, p, b]) => {
    const r = await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, {
      method: m, headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') }, body: b ?? undefined,
    });
    return { status: r.status, text: await r.text() };
  }, [method, NS, path, body ?? null]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await api(page, 'POST', FILE, doc());
});
test.afterEach(async ({ page }) => { await api(page, 'DELETE', DIR); });

const caret = (page) => page.evaluate(() => {
  const s = getSelection();
  const el = s.anchorNode && (s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode);
  return { para: (el?.closest('p')?.textContent || '').slice(0, 13), scroll: Math.round(document.querySelector('.live-editor-crepe-root').scrollTop) };
});

test('a collaborator typing above and below keeps your caret and scroll position', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    const r = await route.fetch();
    await route.fulfill({ response: r, json: { ...(await r.json()), liveCollab: true } });
  });
  let socket = null;
  await page.routeWebSocket(/\/api\/ws/, (ws) => { socket = ws; ws.onMessage(() => {}); });
  await page.goto(`/#${NS}/${FILE}`);
  await page.reload(); // re-read the config with liveCollab on
  await page.click('.toolbar button[title="Live rich editor"]');
  const p10 = page.locator('.live-editor-crepe-root p', { hasText: 'Paragraph 10 ' });
  await expect(p10).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => socket !== null, { timeout: 10_000 }).toBe(true);
  // A click places the caret. (Not the End key: in a scroll container Chrome
  // also smooth-scrolls on End, which would look like the jump under test.)
  await p10.click();
  await page.waitForTimeout(1800); // past the 1.5s "you are typing" hold
  const before = await caret(page);
  expect(before.para).toBe('Paragraph 10 ');

  // fazeen types in a paragraph far below, and in one above the caret.
  socket.send(JSON.stringify({ type: 'content', userId: 99, username: 'fazeen', content: doc({ 45: ' Added below.', 3: ' Added above.' }) }));
  await expect(page.locator('.live-editor-crepe-root p', { hasText: 'Added below.' })).toBeAttached({ timeout: 10_000 });
  await expect(page.locator('.live-editor-crepe-root p', { hasText: 'Added above.' })).toBeAttached();
  await page.waitForTimeout(400);

  const after = await caret(page);
  expect(after.para, 'the caret stays in the paragraph it was in').toBe('Paragraph 10 ');
  expect(Math.abs(after.scroll - before.scroll), 'the view does not jump').toBeLessThan(40);
});
