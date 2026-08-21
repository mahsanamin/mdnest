// Mermaid labels must be readable on the node they sit on, in BOTH themes.
//
// The unit test pins the decision (a zero-area shape can't be the background).
// Only a browser can prove the decision is fed the right shapes: mermaid nests
// an empty <rect> spacer inside every flowchart node's g.label, and that
// spacer inherits the themed mainBkg. Reading it first told the contrast pass
// "this background is dark" about a #cfe4ff node, so in dark mode every label
// on an author's pale classDef came out light-on-light and near-invisible.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const FILE = process.env.MDNEST_MERMAID_FILE || 'e2e-mermaid.md';
const PALE = process.env.MDNEST_MERMAID_PALE || 'zzppale';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function useTheme(page, theme) {
  await page.evaluate(async (t) => {
    const tok = localStorage.getItem('mdnest_token');
    await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ theme: t }),
    });
  }, theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

// Perceived brightness, the same weighting the app uses to pick the ink.
const LUM = `(c) => { const m = c.match(/[\\d.]+/g).map(Number);
  return (m[0]*299 + m[1]*587 + m[2]*114) / 1000; }`;

for (const theme of ['dark', 'light']) {
  test(`mermaid labels contrast with their node fill (${theme})`, async ({ page }) => {
    await signIn(page);
    await useTheme(page, theme);
    await page.goto(`/#${NS}/${FILE}`);
    await expect(page.locator(`text=${PALE}`).first()).toBeVisible({ timeout: 30_000 });

    const pair = await page.evaluate(({ pale, lumSrc }) => {
      const lum = eval(lumSrc);
      const svg = [...document.querySelectorAll('svg')].find((s) => s.querySelector('.node'));
      if (!svg) return { error: 'no diagram rendered' };
      const node = [...svg.querySelectorAll('.node')]
        .find((n) => (n.textContent || '').includes(pale));
      if (!node) return { error: 'pale node not found' };
      const shape = node.querySelector('rect.label-container, rect.basic, rect, polygon, circle');
      const text = node.querySelector('foreignObject span, foreignObject div, foreignObject p')
        || node.querySelector('text, tspan');
      if (!shape || !text) return { error: 'node has no shape or no label' };
      const ink = getComputedStyle(text).color && getComputedStyle(text).color !== ''
        ? getComputedStyle(text).color : getComputedStyle(text).fill;
      return { fill: lum(getComputedStyle(shape).fill), ink: lum(ink) };
    }, { pale: PALE, lumSrc: LUM });

    expect(pair.error).toBeUndefined();
    // The fixture's fill is pale (#cfe4ff ≈ 225) in both themes — the node
    // colour is the author's, not the theme's. So the ink must be the dark one.
    expect(pair.fill).toBeGreaterThan(180);
    expect(Math.abs(pair.fill - pair.ink),
      `label ink (${pair.ink.toFixed(0)}) must contrast with node fill (${pair.fill.toFixed(0)})`)
      .toBeGreaterThan(80);
  });
}
