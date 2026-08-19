// The task board must scroll horizontally when the columns don't fit.
//
// .tb-board has always had overflow-x:auto, but it never engaged: .tb-panel is
// a flex item of .split-view (a flex row with overflow:hidden) and defaulted to
// min-width:auto, so it refused to shrink below the intrinsic width of N fixed
// columns. The panel grew past the viewport and .split-view clipped the
// right-hand columns — they were unreachable, with no scrollbar.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

test('the board scrolls sideways instead of hiding columns', async ({ page }) => {
  test.setTimeout(120_000);
  // Narrow enough that the default columns cannot all fit.
  await page.setViewportSize({ width: 900, height: 720 });

  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });

  // The button only renders once /api/config has told the app the board is
  // enabled, which lands after the sidebar does — so wait, don't sample.
  const board = page.locator('.toolbar-view-board');
  const boardAvailable = await board.waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true).catch(() => false);
  if (!boardAvailable) test.skip(true, 'task board disabled (ENABLE_TASK_BOARD)');

  // Seed a note with tasks so the board renders columns rather than its empty
  // state. It must go into the namespace the UI is actually showing, not
  // whichever one the API lists first.
  const file = `boardscroll-${Date.now()}.md`;
  await page.evaluate(async ({ file }) => {
    const t = localStorage.getItem('mdnest_token');
    const ns = document.querySelector('.ns-select')?.value
      || document.querySelector('.ns-label')?.textContent.trim();
    // Two steps on purpose: POST creates the (empty) note, PUT writes its
    // bytes. PUT alone 404s on a path that doesn't exist yet, and the note API
    // takes raw markdown as the body, not a JSON envelope.
    const url = `/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(file)}`;
    await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: '' });
    const put = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + t },
      body: '# board scroll\n\n- [ ] alpha\n- [ ] beta\n- [x] gamma\n',
    });
    if (!put.ok) throw new Error(`seed failed: ${put.status}`);
  }, { file });

  await board.click();
  await expect(page.locator('.tb-board')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tb-column').first()).toBeVisible({ timeout: 20_000 });

  const m = await page.locator('.tb-board').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    panel: el.closest('.tb-panel').clientWidth,
    split: el.closest('.split-view').clientWidth,
    columns: el.querySelectorAll('.tb-column').length,
  }));

  // The panel must be bounded by its container — this is what was broken.
  expect(m.panel, 'the board panel overflowed .split-view and got clipped')
    .toBeLessThanOrEqual(m.split);

  if (m.scrollWidth > m.clientWidth) {
    // Overflowing: it must actually scroll, and reach the last column.
    await page.locator('.tb-board').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    const scrolled = await page.locator('.tb-board').evaluate((el) => el.scrollLeft);
    expect(scrolled, 'board did not scroll horizontally').toBeGreaterThan(0);
    await expect(page.locator('.tb-column').last()).toBeInViewport();
  }
});
