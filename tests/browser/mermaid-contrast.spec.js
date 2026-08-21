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
const EDGE = process.env.MDNEST_MERMAID_EDGE || 'zzeedge';
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

// Perceived brightness over the diagram ground, the same weighting and the
// same compositing the app uses to pick the ink. The ground matters: mermaid's
// edge-label chip is half-transparent, so its declared colour is not the pixel.
const LUM = `(c, ground) => { const m = (c || '').match(/[\\d.]+/g);
  if (!m) return null;
  const a = m.length > 3 ? +m[3] : 1;
  const p = [0, 1, 2].map((i) => +m[i] * a + ground[i] * (1 - a));
  return (p[0]*299 + p[1]*587 + p[2]*114) / 1000; }`;
const GROUND = { dark: [30, 30, 46], light: [239, 241, 245] };

for (const theme of ['dark', 'light']) {
  test(`mermaid node and edge labels stay readable (${theme})`, async ({ page }) => {
    await signIn(page);
    await useTheme(page, theme);
    await page.goto(`/#${NS}/${FILE}`);
    await expect(page.locator(`text=${PALE}`).first()).toBeVisible({ timeout: 30_000 });

    const found = await page.evaluate(({ pale, edge, lumSrc, ground }) => {
      const lum = eval(lumSrc);
      const svg = [...document.querySelectorAll('svg')].find((s) => s.querySelector('.node'));
      if (!svg) return { error: 'no diagram rendered' };

      // The background a label is actually read against: its own CSS
      // background when it has one (edge labels), otherwise the shape behind
      // it (nodes).
      const backdrop = (el, textEl) => {
        const own = getComputedStyle(textEl).backgroundColor;
        const ownL = lum(own, ground);
        if (ownL !== null && own !== 'rgba(0, 0, 0, 0)') return ownL;
        const shape = el.querySelector('rect.label-container, rect.basic, rect, polygon, circle');
        return shape ? lum(getComputedStyle(shape).fill, ground) : null;
      };
      const measure = (sel, needle) => {
        const el = [...svg.querySelectorAll(sel)].find((n) => (n.textContent || '').includes(needle));
        if (!el) return { error: `${sel} carrying "${needle}" not found` };
        const t = el.querySelector('foreignObject span, foreignObject div, foreignObject p')
          || el.querySelector('text, tspan');
        if (!t) return { error: `${sel} has no label` };
        const ink = lum(getComputedStyle(t).color || getComputedStyle(t).fill, ground);
        return { bg: backdrop(el, t), ink };
      };
      return { node: measure('.node', pale), edge: measure('.edgeLabel', edge) };
    }, { pale: PALE, edge: EDGE, lumSrc: LUM, ground: GROUND[theme] });

    expect(found.error).toBeUndefined();
    expect(found.node.error).toBeUndefined();
    expect(found.edge.error).toBeUndefined();

    // The fixture's node fill is pale (#cfe4ff ≈ 225) in BOTH themes — the
    // colour is the author's, not the theme's — so its ink must be the dark
    // one either way. That is the case the theme could not reason about.
    expect(found.node.bg).toBeGreaterThan(180);

    for (const [what, m] of Object.entries({ node: found.node, edge: found.edge })) {
      expect(Math.abs(m.bg - m.ink),
        `${what} ink (${m.ink.toFixed(0)}) must contrast with its background (${m.bg.toFixed(0)})`)
        .toBeGreaterThan(60);
    }
  });
}
