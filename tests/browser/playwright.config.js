// Playwright config for mdnest browser E2E.
// The stack is booted by tests/e2e-browser.sh (full frontend+backend in Docker);
// this config just points the browser at it via MDNEST_BASE_URL. No webServer
// block — we don't want Playwright to start anything itself.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.MDNEST_BASE_URL || 'http://127.0.0.1:8080',
    headless: true,
    // Grant clipboard access so the Settings copy-button test can use the
    // async Clipboard API (127.0.0.1 is a secure context) without a prompt.
    permissions: ['clipboard-read', 'clipboard-write'],
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
