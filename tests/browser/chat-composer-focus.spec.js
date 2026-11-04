// The chat composer on a phone must keep focus while a spelling suggestion is
// applied. A report said the on-screen keyboard closed when the misspelled
// word was tapped. Tapping a word selects it; picking a suggestion replaces
// the selection (an insertReplacementText input). Anything in the app that
// blurs, disables or rebuilds the textarea at those moments closes the
// keyboard, so this checks focus and element identity across both steps,
// and across a poll and a resize like the keyboard opening.
import { test, expect, devices } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

test.use({ ...devices['Pixel 7'], defaultBrowserType: undefined });

async function api(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b });
    return { status: r.status, text: await r.text() };
  }, [method, url, body]);
}

test('the chat composer keeps focus while a misspelled word is selected and replaced', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select').first()).toBeAttached({ timeout: 20_000 });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const chat = `__focus-${id}.md`;
  const created = await api(page, 'POST', `/api/chat/convert?ns=${NS}&path=${encodeURIComponent(chat)}&title=${encodeURIComponent('Focus ' + id)}`);
  test.skip(created.status === 404, 'chat disabled (ENABLE_CHAT)');
  expect(created.status).toBe(201);
  try {
    await page.goto(`/#!chats/${NS}/${chat}`);
    const ta = page.locator('.chat-draft');
    await expect(ta).toBeEnabled({ timeout: 20_000 });
    await ta.tap();
    await page.keyboard.type('I think teh plan is fine');
    // Mark the element so a rebuilt one is noticed.
    await ta.evaluate((el) => { el.dataset.probe = 'same'; });

    // Tap on the misspelled word: the browser selects it.
    await ta.evaluate((el) => { const i = el.value.indexOf('teh'); el.setSelectionRange(i, i + 3); });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('chat-draft');

    // Pick the suggestion: the selection is replaced as one input.
    await page.evaluate(() => {
      const el = document.activeElement;
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: 'the', bubbles: true, cancelable: true }));
      document.execCommand('insertText', false, 'the');
    });
    await expect(ta).toHaveValue('I think the plan is fine');

    // The keyboard opening shrinks the viewport; a poll comes in.
    await page.setViewportSize({ width: 412, height: 500 });
    await page.waitForTimeout(3500);

    expect(await page.evaluate(() => document.activeElement?.className)).toContain('chat-draft');
    expect(await ta.evaluate((el) => el.dataset.probe)).toBe('same');
    await expect(ta).toBeEnabled();
  } finally {
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`).catch(() => {});
  }
});
