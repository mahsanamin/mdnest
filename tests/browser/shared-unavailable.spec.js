// Live collaboration is on, but this browser's websocket does not work: a
// proxy, CDN or network that refuses websockets, or accepts them and never
// passes frames. Reported by a user: from v4.8.10 almost every note opened
// read-only in Live, with "Waiting for the live connection to edit this note
// together", because the editor waited for a shared document that never came.
// Notes must stay editable and save the normal way instead.
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

const BROKEN = {
  // The socket opens but nothing ever comes back.
  hangs: { handler: (ws) => { ws.onMessage(() => {}); }, why: 'no-reply' },
  // The socket is closed as soon as it opens.
  refused: { handler: (ws) => { ws.close({ code: 1006 }); }, why: 'no-connection' },
};

for (const [how, { handler, why }] of Object.entries(BROKEN)) {
  test(`live collaboration on but the websocket ${how}: notes stay editable and save`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.routeWebSocket(/\/api\/ws/, handler);
    await page.goto('/');
    await page.fill('input[name=username]', USER);
    await page.fill('input[name=password]', PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
    const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
    test.skip(!cfg.liveCollab || !cfg.sharedEditing, 'needs live collaboration and shared editing on');

    const stamp = `${how}-${Date.now()}`;
    const first = `ws-${stamp}-a.md`;
    const second = `ws-${stamp}-b.md`;
    expect((await api(page, 'POST', noteUrl(first), '# First\n\nhello\n')).status).toBe(201);
    expect((await api(page, 'POST', noteUrl(second), '# Second\n\nhello\n')).status).toBe(201);
    try {
      await page.goto(`/#${NS}/${first}`);
      await expect(page.locator('.toolbar-path')).toContainText(first, { timeout: 20_000 });
      await page.locator('.toolbar button', { hasText: /^Live$/ }).click();
      const editor = page.locator('.editor-wrapper .ProseMirror');
      // Editable within a few seconds, not read-only for good.
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 10_000 });
      await page.locator('.editor-wrapper .ProseMirror p', { hasText: 'hello' }).first().click();
      await page.keyboard.press('End');
      await page.keyboard.type(' typed here');
      await expect.poll(async () => (await api(page, 'GET', noteUrl(first))).text, { timeout: 15_000 })
        .toContain('hello typed here');
      await expect(page.getByText('Waiting for the live connection')).toHaveCount(0);
      // The notice says which step failed, for a support report.
      await expect(page.locator('[data-testid=notice-bar]')).toContainText(why);

      // The next note does not wait at all.
      await page.goto(`/#${NS}/${second}`);
      await expect(page.locator('.toolbar-path')).toContainText(second, { timeout: 20_000 });
      await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 3_000 });
    } finally {
      await api(page, 'DELETE', noteUrl(first));
      await api(page, 'DELETE', noteUrl(second));
    }
  });
}
