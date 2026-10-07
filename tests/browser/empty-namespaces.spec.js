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

async function signInExpectingEmpty(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.getByTestId('empty-namespaces')).toBeVisible({ timeout: 20_000 });
}

function fakeEmpty(route, reason) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'X-Namespaces-Empty-Reason': reason },
    body: '[]',
  });
}

// Once the server-side problem is fixed, "Check again" picks it up without a
// reload and opens the workspace like a fresh load would.
test('Check again picks up a fixed mount without a reload', async ({ page }) => {
  let fixed = false;
  await page.route('**/api/namespaces', (route) => (fixed ? route.continue() : fakeEmpty(route, 'none-mounted')));
  await signInExpectingEmpty(page);
  const box = page.getByTestId('empty-namespaces');
  await expect(box.locator('pre').first()).toContainText('./notes:/data/notes/notes');

  await box.getByRole('button', { name: 'Check again' }).click();
  await expect(box).toContainText('Still no namespaces');

  fixed = true;
  await box.getByRole('button', { name: 'Check again' }).click();
  await expect(box).toHaveCount(0);
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible();
});

// Multi mode, notes mounted, admin with no grants: one click grants them
// write at the root of every namespace they administer, then opens one.
test('an admin with no access can give themselves access in one click', async ({ page }) => {
  const granted = [];
  await page.route('**/api/config', async (route) => {
    const res = await route.fetch();
    const cfg = await res.json();
    await route.fulfill({ response: res, json: { ...cfg, authMode: 'multi' } });
  });
  await page.route('**/api/me', (route) => route.fulfill({
    json: { id: 7, username: USER, role: 'superadmin', is_super_admin: true, admin_namespaces: [], grants: [] },
  }));
  await page.route('**/api/namespaces?scope=manage', (route) => route.fulfill({ json: ['testing_workspace', 'zz_e2e_target'] }));
  await page.route('**/api/admin/grants', async (route) => {
    granted.push(route.request().postDataJSON());
    await route.fulfill({ json: { id: granted.length } });
  });
  await page.route('**/api/namespaces', (route) => (granted.length === 2 ? route.continue() : fakeEmpty(route, 'no-access')));

  await signInExpectingEmpty(page);
  const box = page.getByTestId('empty-namespaces');
  await expect(box).toContainText('No namespaces you can open yet');
  await expect(box.locator('pre')).toHaveCount(0); // not a mount problem
  await box.getByRole('button', { name: 'Give me access to all namespaces' }).click();

  await expect(box).toHaveCount(0);
  expect(granted).toEqual([
    { user_id: 7, namespace: 'testing_workspace', path: '/', permission: 'write' },
    { user_id: 7, namespace: 'zz_e2e_target', path: '/', permission: 'write' },
  ]);
});

// A real restart of the e2e backend, which runs WITHOUT a Docker restart
// policy: it only comes back if the in-place re-exec works. The page waits for
// the new process (a new bootId), not merely for /api/config to answer.
test('Settings > Server restarts the backend and the page comes back', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  const before = await page.evaluate(async () => (await (await fetch('/api/config')).json()).bootId);
  expect(before).toBeTruthy();

  await page.locator('.toolbar-more-btn').click();
  await page.locator('.toolbar-more-settings').click();
  await page.locator('.settings-tabs button:has-text("Server")').click();
  const tab = page.getByTestId('settings-server');
  await expect(tab).toContainText('docker compose up -d');
  await tab.getByRole('button', { name: 'Restart server' }).click();
  await tab.getByRole('button', { name: 'Restart now' }).click();
  await expect(tab).toContainText('Restarting');

  // The page reloads on its own once the new process answers.
  await page.waitForEvent('load', { timeout: 60_000 });
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  const after = await page.evaluate(async () => (await (await fetch('/api/config')).json()).bootId);
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);
});
