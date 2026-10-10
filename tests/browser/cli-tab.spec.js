// The Settings CLI tab: Install, Update and Connect as three separate commands
// for THIS server (most people need only one of them), and a button that
// creates a token for the login prompt so nobody has to switch tabs.
//
// The install command itself is run for real by tests/e2e-browser.sh (it needs
// a terminal); this spec pins what the tab shows and that the button produces
// a token the server accepts.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function openCliTab(page) {
  await page.locator('.toolbar-more-btn').click();
  await page.locator('.toolbar-more-settings').click();
  await page.locator('.settings-tabs button:has-text("CLI")').click();
}

test.describe('Settings CLI tab', () => {
  test('shows Install, Update and Connect as separate commands for this server', async ({ page, baseURL }) => {
    await signIn(page);
    await openCliTab(page);
    const origin = new URL(baseURL).origin;
    const blocks = page.locator('.settings-code pre');
    await expect(blocks.filter({ hasText: '/cli/install.sh' }))
      .toHaveText(`curl -fsSL ${origin}/cli/install.sh | bash -s -- ${origin}`);
    await expect(blocks.filter({ hasText: 'mdnest update' }))
      .toHaveText(`mdnest update --server ${origin}`);
    await expect(blocks.filter({ hasText: 'mdnest login' }))
      .toHaveText(`mdnest login ${origin}`);
    for (const title of ['Install', 'Update', 'Connect to this server']) {
      await expect(page.locator('.settings-section-title', { hasText: title })).toBeVisible();
    }
    await expect(page.locator('.settings-content')).not.toContainText('mdnest_yourtoken');
  });

  test('every Settings tab fits on one row on a desktop screen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    await openCliTab(page);
    const tops = await page.locator('.settings-tabs button').evaluateAll(
      (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    expect(tops.length).toBe(1);
  });

  test('"Create a token and copy it" makes a token the server accepts', async ({ page }) => {
    await signIn(page);
    await openCliTab(page);
    await page.locator('button:has-text("Create a token and copy it")').click();
    const code = page.locator('.cli-token-created code');
    await expect(code).toHaveText(/^mdnest_/);
    const token = (await code.textContent()).trim();

    const result = await page.evaluate(async (tok) => {
      const ok = (await fetch('/api/namespaces', { headers: { Authorization: 'Bearer ' + tok } })).status;
      // Clean up: revoke every token this spec created.
      const jwt = localStorage.getItem('mdnest_token');
      const list = await (await fetch('/api/auth/tokens', { headers: { Authorization: 'Bearer ' + jwt } })).json();
      for (const t of list || []) {
        if (t.name && t.name.startsWith('CLI ')) {
          await fetch('/api/auth/tokens?id=' + encodeURIComponent(t.id), {
            method: 'DELETE', headers: { Authorization: 'Bearer ' + jwt },
          });
        }
      }
      return ok;
    }, token);
    expect(result).toBe(200);
  });
});
