// GitHub issue #123: with no namespaces the page said "No namespaces found.
// Check your mdnest.conf mounts." for every cause, even on a plain Docker
// Compose install (no mdnest.conf) or a multi-mode account that is simply not
// granted anything yet. The server now says why (X-Namespaces-Empty-Reason)
// and the page names the fix. The reasons themselves are pinned in Go tests;
// here the server's answer is faked to check what the page shows.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

const cases = [
  ['none-mounted', 'No namespaces found', 'backend service (not the frontend)'],
  ['files-at-root', 'Your notes are mounted one level too high', './notes:/data/notes/notes'],
  ['no-access', 'No namespaces you can open yet', 'no access to any namespace'],
  ['unreadable', 'The notes folder cannot be read', ':z'],
];

for (const [reason, title, hint] of cases) {
  test(`an empty namespace list explains itself: ${reason}`, async ({ page }) => {
    await page.route('**/api/namespaces', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Namespaces-Empty-Reason': reason, 'Access-Control-Expose-Headers': 'X-Namespaces-Empty-Reason' },
      body: '[]',
    }));
    await page.goto('/');
    await page.fill('input[name=username]', USER);
    await page.fill('input[name=password]', PASS);
    await page.click('button:has-text("Sign in")');
    const box = page.getByTestId('empty-namespaces');
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(box).toContainText(title);
    await expect(box).toContainText(hint);
    await expect(page.locator('text=Check your mdnest.conf mounts')).toHaveCount(0);
  });
}
