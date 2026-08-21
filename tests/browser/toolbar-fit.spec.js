// The toolbar must never paint one control on top of another.
//
// It is a single non-wrapping flex row whose groups are all flex-shrink: 0, so
// the only thing that can give is the path in the middle. The filename was
// flex-shrink: 0 too and .toolbar-path had no overflow, so on a narrow editor
// — a 13" laptop with the comment panel open is enough — the name rendered
// straight over the Rename/Delete buttons beside it.
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
}

// Any pair of toolbar controls that VISIBLY collide.
//
// Two refinements matter here. Nested pairs are skipped — Rename, Delete and
// the icon buttons live inside .toolbar-path, and a parent enclosing its own
// children is not a collision. And overlap is confirmed by hit-testing the
// intersection rather than by rectangles alone: a control clipped by an
// overflow:hidden ancestor still reports its full box while painting nothing,
// which would make this test cry wolf.
async function overlappingPairs(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll(
      '.toolbar button, .toolbar .toolbar-path-base, .toolbar .toolbar-path-dir')];
    const label = (e) => `${e.className || e.tagName}|${(e.textContent || '').trim().slice(0, 14)}`;
    const hit = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const x = els[i], y = els[j];
        if (x.contains(y) || y.contains(x)) continue;
        const a = x.getBoundingClientRect(), b = y.getBoundingClientRect();
        if (!a.width || !b.width) continue;
        // A 1px tolerance: adjacent borders are allowed to touch.
        if (!(a.right > b.left + 1 && b.right > a.left + 1 &&
              a.bottom > b.top + 1 && b.bottom > a.top + 1)) continue;
        const cx = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
        const cy = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
        const stack = document.elementsFromPoint(cx, cy);
        const shows = (e) => stack.some((s) => s === e || e.contains(s));
        if (shows(x) && shows(y)) hit.push(`${label(x)} ∩ ${label(y)}`);
      }
    }
    return hit;
  });
}

// 1024 is the width that actually reproduces it: wide enough that the sidebar
// is still docked (below ~900 it becomes an overlay and the bar gets its room
// back), narrow enough that the row cannot fit. 1440 is the control.
for (const width of [1440, 1024]) {
  test(`toolbar controls do not overlap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await page.goto(`/#${NS}/${FILE}`);
    await expect(page.locator('.toolbar-path')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);

    expect(await overlappingPairs(page), 'toolbar controls collide').toEqual([]);

    // The comment panel squeezes the bar hardest, so pin that too wherever it
    // exists. It is gated on live collab, which needs multi mode — a single
    // mode instance simply has no panel, and the width check above still holds.
    if (await page.locator('.toolbar-comments').count()) {
      await page.locator('.toolbar-comments').click();
      await page.waitForTimeout(900);
      expect(await overlappingPairs(page), 'toolbar collides with comments open').toEqual([]);
    }

    // And the filename must stay inside the path's own box rather than
    // painting over whatever sits to its right.
    const spill = await page.evaluate(() => {
      const p = document.querySelector('.toolbar-path');
      const base = document.querySelector('.toolbar-path-base');
      if (!p || !base) return 0;
      return Math.round(base.getBoundingClientRect().right - p.getBoundingClientRect().right);
    });
    expect(spill, 'the filename renders outside the path box').toBeLessThanOrEqual(1);
  });
}
