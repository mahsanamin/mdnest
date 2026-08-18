// Switching files must not throw away a drawing's unsaved strokes.
//
// The drawing canvas debounces its own changes for 500ms before handing them
// to the app, and the app then debounces the PUT. Opening another note used to
// clearTimeout() that queued save, so anything drawn in the window between the
// last stroke and the click was lost — reliably, because you stop drawing at
// the moment you reach for the next file. A freshly created drawing could stay
// 0 bytes on disk.
//
// This asserts on the stored bytes, not the canvas, so it fails if the write
// never reaches the server.
import { test, expect, request as pwRequest } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

test('a drawing survives switching to another file immediately after drawing', async ({ page, baseURL }) => {
  // The drawing chunk is ~1.5MB and compiles on first load, so the default
  // per-test budget is tight on a cold cache.
  test.setTimeout(120_000);
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });

  const drawingBtn = page.locator('button:has-text("+ Drawing")');
  if (!(await drawingBtn.count())) test.skip(true, 'drawings disabled (ENABLE_EXCALIDRAW)');

  const name = `savetest-${Date.now()}`;
  page.once('dialog', (d) => d.accept(name));
  await drawingBtn.click();

  const canvas = page.locator('.excalidraw canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // Which file did we just create?
  const hash = decodeURIComponent(new URL(page.url()).hash.replace(/^#/, ''));
  const ns = hash.split('/')[0];
  const notePath = hash.slice(ns.length + 1);
  expect(notePath).toContain(name);

  // Draw a rectangle. Click the tool rather than using the keyboard shortcut:
  // the shortcut depends on canvas focus, which makes the test flaky. The
  // data-testid sits on a visually-hidden radio input, so drive its label.
  await page.locator('label[title*="Rectangle"]').click();
  // Drag well right of centre: picking a shape tool opens Excalidraw's
  // properties panel over the left edge of the canvas, which would otherwise
  // swallow the drag.
  const box = await canvas.boundingBox();
  const x = box.x + box.width * 0.55;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y + 120, { steps: 15 });
  await page.mouse.up();

  // Immediately switch away — this is the race that used to lose the work.
  const other = page.locator('.tree-label').filter({ hasNot: page.locator(`text=${name}`) }).first();
  await other.click();
  await expect(page.locator('.toolbar-path')).not.toContainText(name, { timeout: 20_000 });

  // The bytes must be on the server.
  const api = await pwRequest.newContext({ baseURL });
  const auth = await api.post('/api/auth/login', { data: { username: USER, password: PASS } });
  const token = (await auth.json()).token;
  const res = await api.get(`/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(notePath)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  const body = await res.text();

  expect(body.length, 'drawing was saved as empty — the pending save was dropped').toBeGreaterThan(0);
  expect(body).toContain('excalidraw');
  // The rectangle itself must be in the scene, not just the file scaffolding.
  expect(body, 'the drawn element was not persisted').toContain('"type": "rectangle"');
  await api.dispose();
});
