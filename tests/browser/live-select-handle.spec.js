// Selecting text in the Live editor must not set anything moving beside it.
//
// Crepe's block handle (the "+" and drag grip in the left gutter) follows the
// block under the pointer and animates there with `transition: all 0.2s`. A
// mouse selection crosses one block after another, so the handle glided up
// and down next to the text being selected, which read as the text jumping.
// LiveEditorCrepe marks the pane `.selecting` while the button is held, and
// the handle is hidden for that time.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const DIR = 'e2e-live-select';
const FILE = `${DIR}/blocks.md`;

let body = '# Selecting\n\n';
for (let i = 1; i <= 8; i++) body += `Paragraph ${i} has enough words in it to be a real block of text.\n\n`;

async function api(page, method, path, content) {
  return page.evaluate(async ([m, ns, p, b]) => {
    const r = await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, {
      method: m,
      headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') },
      body: b ?? undefined,
    });
    return r.status;
  }, [method, NS, path, content ?? null]);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await api(page, 'POST', FILE, body);
});

test.afterEach(async ({ page }) => {
  await api(page, 'DELETE', DIR);
});

const handleState = (page) => page.evaluate(() => {
  const h = document.querySelector('.milkdown-block-handle');
  if (!h) return null;
  return { opacity: getComputedStyle(h).opacity, top: Math.round(h.getBoundingClientRect().top) };
});

test('the block handle stays hidden and still while text is drag-selected', async ({ page }) => {
  await page.goto(`/#${NS}/${FILE}`);
  await page.click('.toolbar button[title="Live rich editor"]');
  const first = page.locator('.live-editor-crepe-root p', { hasText: 'Paragraph 1 ' });
  const last = page.locator('.live-editor-crepe-root p', { hasText: 'Paragraph 6 ' });
  await expect(first).toBeVisible({ timeout: 20_000 });

  // Hovering a block shows the handle, so there is something to hide.
  const a = await first.boundingBox();
  await page.mouse.move(a.x + 30, a.y + a.height / 2);
  await expect.poll(async () => (await handleState(page))?.opacity, { timeout: 5_000 }).toBe('1');

  // Drag a selection down across five blocks, sampling as it goes.
  const b = await last.boundingBox();
  await page.mouse.down();
  const seen = [];
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(a.x + 30 + i * 10, a.y + ((b.y - a.y) * i) / 12, { steps: 2 });
    await page.waitForTimeout(40);
    seen.push(await handleState(page));
  }
  await page.mouse.up();

  const visible = seen.filter((s) => s && Number(s.opacity) > 0);
  expect(visible, `the handle showed during the drag: ${JSON.stringify(visible)}`).toEqual([]);
  // Something was really selected, so the drag did what a user would see.
  const selected = await page.evaluate(() => String(window.getSelection()));
  expect(selected).toContain('Paragraph 3');

  // After the button is released the handle works again on hover.
  await page.mouse.move(a.x + 30, a.y + a.height / 2);
  await expect.poll(async () => (await handleState(page))?.opacity, { timeout: 5_000 }).toBe('1');
});
