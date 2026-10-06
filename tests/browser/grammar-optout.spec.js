// Grammar-checking extensions (Grammarly and others) must stay off mdnest's
// editing surfaces. On the Live editor one changed where lines wrapped when a
// word was selected and added empty scroll space under the note; both bug
// reports showed the extension's badge in the editor. These are the attributes
// such extensions honour. The real extension cannot run in CI, so this pins
// that the opt-out reaches every surface it was meant for.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const FILE = process.env.MDNEST_SEED_FILE || 'e2e-seed.md';

const optedOut = (loc) => loc.evaluate((el) => ['data-gramm', 'data-gramm_editor', 'data-enable-grammarly'].every((a) => el.getAttribute(a) === 'false'));

test('the Live editor, the Basic editor and the chat box opt out of grammar extensions', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });

  await page.goto(`/#${NS}/${FILE}`);
  await page.click('.toolbar button[title="Live rich editor"]');
  const live = page.locator('.live-editor-crepe-root .ProseMirror');
  await expect(live).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => optedOut(live), { timeout: 5_000 }).toBe(true);

  await page.click('.toolbar button[title="Plain text editor"]');
  const basic = page.locator('textarea.editor-textarea');
  await expect(basic).toBeVisible({ timeout: 10_000 });
  expect(await optedOut(basic)).toBe(true);

  const chats = page.locator('.toolbar-view-chats');
  if (await chats.count()) {
    const chat = `__grammar-${Date.now()}.md`;
    await page.evaluate(async ([ns, p]) => {
      await fetch(`/api/chat/convert?ns=${ns}&path=${encodeURIComponent(p)}&title=G`, { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } });
    }, [NS, chat]);
    try {
      await page.goto(`/#!chats/${NS}/${chat}`);
      const draft = page.locator('textarea.chat-draft');
      await expect(draft).toBeVisible({ timeout: 20_000 });
      expect(await optedOut(draft)).toBe(true);
    } finally {
      await page.evaluate(async ([ns, p]) => {
        await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } });
      }, [NS, chat]);
    }
  }
});
