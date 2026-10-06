// Selecting a word in the Live editor must not move the text or grow the
// scroll area.
//
// Crepe hides its block handle (the "+" and grip beside each block) with
// opacity only and leaves it parked where it extends the scroll area by its
// own height, ~52px. As the handle hid and showed (mouse away, a selection,
// the next click) the scroll height grew and shrank: empty space under the
// note, gone on the next click. On a note that just fitted, a scrollbar came
// and went with it and every line rewrapped. Real scrollbars are turned on
// for this file: headless Chromium hides them by default, which hid the bug.
import { test, expect } from '@playwright/test';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar,OverlayScrollbars'] } });

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const DIR = 'e2e-live-scroll';
const FILE = `${DIR}/lines.md`;

let BODY = '# Lines\n\n';
for (let i = 0; i < 24; i++) BODY += `Line ${i}: some words in a paragraph that wrap on a narrow window.\n\n`;

async function api(page, method, path, body) {
  return page.evaluate(async ([m, ns, p, b]) => {
    const r = await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, {
      method: m, headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') }, body: b ?? undefined,
    });
    return r.status;
  }, [method, NS, path, body ?? null]);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await api(page, 'POST', FILE, BODY);
});
test.afterEach(async ({ page }) => { await api(page, 'DELETE', DIR); });

const scroll = (page) => page.evaluate(() => {
  const r = document.querySelector('.live-editor-crepe-root');
  return { sh: r.scrollHeight, cw: r.clientWidth };
});

test('the hidden block handle does not change the scroll area or the text width', async ({ page }) => {
  await page.goto(`/#${NS}/${FILE}`);
  await page.click('.toolbar button[title="Live rich editor"]');
  const paras = page.locator('.live-editor-crepe-root p');
  await expect(paras.nth(20)).toBeAttached({ timeout: 20_000 });

  const handleState = () => page.evaluate(() => document.querySelector('.milkdown-block-handle')?.getAttribute('data-show'));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  // At load the handle is hidden (data-show="false"), parked by Crepe.
  const atLoad = { ...(await scroll(page)), handle: await handleState() };
  const hoverP = async (i) => {
    const b = await paras.nth(i).evaluate((e) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; });
    await page.mouse.move(b.x, b.y);
    await page.waitForTimeout(350);
    return { ...(await scroll(page)), handle: await handleState() };
  };
  const shown = await hoverP(5);
  expect(shown.handle, 'hovering a block shows the handle').toBe('true');
  expect(atLoad.handle, 'the handle starts hidden').toBe('false');
  expect({ sh: atLoad.sh, cw: atLoad.cw }, 'scroll area with the handle hidden vs shown').toEqual({ sh: shown.sh, cw: shown.cw });

  // Select a word: the paragraph must keep its width (no rewrap).
  const target = paras.nth(10);
  const width = async () => Math.round((await target.boundingBox()).width);
  const before = await width();
  const w = await target.evaluate((e) => { const t = e.firstChild; const i = t.textContent.indexOf('some'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 4); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.dblclick(w.x, w.y);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => String(getSelection()))).toBe('some');
  expect(await width(), 'paragraph width after selecting a word').toBe(before);
  expect(await scroll(page), 'scroll area after selecting a word').toEqual({ sh: shown.sh, cw: shown.cw });
});
