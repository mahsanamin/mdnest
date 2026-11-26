// A link put in the address bar must open, even when the app updates its own
// state in the same moment.
//
// The browser changes location.hash at once but dispatches hashchange a task
// later. The app keeps the URL in step with its state, and a state change in
// that gap used to write the app's current route over the new hash, so the
// hashchange handler then read the app's own route and the link was lost.
// It showed as a link opened right after sign-in landing on the bare
// namespace ("No file selected"), about 1 run in 15. Here the state change
// is a click on the Stickies button in the same task as the hash change,
// which opens that gap every time. The second test recreates the sign-in
// case: the link arrives as the namespace is drawn, and the namespace's
// loading effect (which wrote the bare namespace) runs before hashchange.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const SEED = process.env.MDNEST_SEED_FILE || 'e2e-seed.md';

test('a link set in the address bar survives a state change in the same moment', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.tree-row', { hasText: SEED }).first()).toBeVisible({ timeout: 20_000 });
  const stickies = page.locator('[data-testid=toolbar-stickies]');
  test.skip(!(await stickies.count()), 'needs the Stickies button');

  await page.evaluate(([ns, file]) => {
    window.location.hash = `#${ns}/${file}`;
    document.querySelector('[data-testid=toolbar-stickies]').click();
  }, [NS, SEED]);

  await expect(page.locator('.toolbar-path')).toContainText(SEED.replace(/\.md$/, ''), { timeout: 10_000 });
  expect(decodeURIComponent(await page.evaluate(() => window.location.hash))).toBe(`#${NS}/${SEED}`);
});

test('a link set as the namespace finishes loading is not replaced by the namespace', async ({ page }) => {
  // The browser updates location.hash at once and dispatches hashchange
  // later; with a real navigation that was late enough for the namespace's
  // loading effect to run first. Recreate it on purpose: set the hash as the
  // namespace is drawn, and hold that hashchange back for 300 ms (this
  // listener is registered before the app's, so it can stop the event and
  // dispatch it again).
  await page.addInitScript(([ns, file]) => {
    let done = false;
    let held = false;
    window.addEventListener('hashchange', (e) => {
      if (!done || held) return;
      held = true;
      e.stopImmediatePropagation();
      setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange')), 300);
    });
    const shown = () => document.querySelector('.ns-label')?.textContent === ns
      || document.querySelector('.ns-select')?.value === ns;
    new MutationObserver(() => {
      if (done || !shown()) return;
      done = true;
      window.location.hash = `#${ns}/${file}`;
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, [NS, SEED]);
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.toolbar-path')).toContainText(SEED.replace(/\.md$/, ''), { timeout: 20_000 });
  expect(decodeURIComponent(await page.evaluate(() => window.location.hash))).toBe(`#${NS}/${SEED}`);
});
