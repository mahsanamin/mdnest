// A label's colour must survive zooming and the full-screen viewer.
//
// fixMermaidTextColors picks each label's ink from the fill behind it (white
// on a dark purple node in light mode). Those colours are inline styles on
// the rendered DOM, so two paths lost them: a zoom click re-rendered the block
// without them, and the full-screen viewer draws its own sanitized copy of
// the SVG, where the label's span wrapper is gone and the fixer found nothing.
// Both showed the theme's dark ink on a dark fill. An edge label must keep the
// ordinary ink, not inherit some node's.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const DIR = 'e2e-mermaid-zoom';
const FILE = `${DIR}/colors.md`;
const WHITE = 'rgb(255, 255, 255)';
const BODY = [
  '# Colours', '', '```mermaid', 'flowchart TB',
  '  A["DARK_NODE_LABEL"] -->|"edge words"| B["OTHER_NODE"]',
  '  classDef data fill:#6741d9,stroke:#b197fc,stroke-width:2px;',
  '  class A,B data;', '```', '',
].join('\n');

async function api(page, method, path, body) {
  return page.evaluate(async ([m, ns, p, b]) => {
    const r = await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, {
      method: m, headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') }, body: b ?? undefined,
    });
    return r.status;
  }, [method, NS, path, body ?? null]);
}

// The computed colour of the innermost element holding `text` under `scope`.
const inkOf = (page, scope, text) => page.evaluate(([scope, text]) => {
  const root = document.querySelector(scope);
  if (!root) return null;
  const leaf = [...root.querySelectorAll('*')].reverse()
    .find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(text)));
  return leaf ? getComputedStyle(leaf).color : null;
}, [scope, text]);

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await api(page, 'POST', FILE, BODY);
});

test.afterEach(async ({ page }) => { await api(page, 'DELETE', DIR); });

test('mermaid labels keep their colour after zoom and in full screen', async ({ page }) => {
  await page.goto(`/#${NS}/${FILE}`);
  await page.click('.toolbar button[title="Live rich editor"]');
  const block = '.live-editor-crepe-root';
  await expect.poll(() => inkOf(page, block, 'DARK_NODE_LABEL'), { timeout: 20_000 }).toBe(WHITE);

  await page.locator('button[title="Zoom in"]').first().click();
  // The fix re-runs after the re-render; give it its frame, then it must hold.
  await expect.poll(() => inkOf(page, block, 'DARK_NODE_LABEL'), { timeout: 5_000 }).toBe(WHITE);
  await page.waitForTimeout(400);
  expect(await inkOf(page, block, 'DARK_NODE_LABEL'), 'zoom dropped the label colour').toBe(WHITE);

  await page.locator('button[title="Fullscreen"]').first().click();
  const viewer = '.mermaid-viewer-content';
  await expect.poll(() => inkOf(page, viewer, 'DARK_NODE_LABEL'), { timeout: 5_000 }).toBe(WHITE);
  // The edge label sits on the pale canvas: it must not turn white with the nodes.
  const edge = await inkOf(page, viewer, 'edge words');
  expect(edge, 'edge label').not.toBe(WHITE);
  expect(edge).not.toBeNull();
});
