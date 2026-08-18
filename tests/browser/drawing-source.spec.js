// "Basic" must do something on a .excalidraw.md.
//
// A drawing is a real markdown file — scene JSON plus a mirrored text section —
// but the canvas short-circuited the whole editor branch, so the Basic/Live
// buttons were rendered and simply did nothing when a drawing was open. The
// toggle now offers the two views a drawing actually has: the canvas, or the
// markdown behind it. Live is deliberately not offered; the rich editor would
// reformat the JSON and corrupt the scene.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

test('a drawing can be switched between canvas and markdown source', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });

  const drawingBtn = page.locator('button:has-text("+ Drawing")');
  if (!(await drawingBtn.count())) test.skip(true, 'drawings disabled (ENABLE_EXCALIDRAW)');
  page.once('dialog', (d) => d.accept(`srctest-${Date.now()}`));
  await drawingBtn.click();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });

  // Draw something: a brand-new drawing is legitimately an empty file, so
  // there would be no source to show yet.
  await page.locator('label[title*="Rectangle"]').click();
  const canvas = page.locator('.excalidraw canvas').first();
  const box = await canvas.boundingBox();
  const x = box.x + box.width * 0.55;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y + 120, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(1200);

  // The toggle offers Basic/Drawing, and never Live for this file type.
  const toggle = page.locator('.editor-mode-toggle');
  await expect(toggle.locator('button:has-text("Drawing")')).toBeVisible();
  await expect(toggle.locator('button:has-text("Basic")')).toBeVisible();
  await expect(toggle.locator('button:has-text("Live")')).toHaveCount(0);

  // Order must match the normal Basic|Live pair — raw on the left, rich on the
  // right — so "Basic" doesn't move depending on the file you opened.
  const labels = (await toggle.locator('button').allInnerTexts()).map((t) => t.trim());
  expect(labels).toEqual(['Basic', 'Drawing']);

  // Basic reveals the markdown, not a blank pane.
  await toggle.locator('button:has-text("Basic")').click();
  const textarea = page.locator('.editor-wrapper textarea');
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  await expect(textarea).toHaveValue(/excalidraw-plugin: parsed/);
  await expect(textarea).toHaveValue(/## Drawing/);
  await expect(page.locator('.excalidraw canvas')).toHaveCount(0);

  // And back to the canvas.
  await toggle.locator('button:has-text("Drawing")').click();
  await expect(page.locator('.excalidraw canvas').first()).toBeVisible({ timeout: 30_000 });
});
