// Link to one heading of a note: hover the heading, Copy link, and opening
// that link lands on the heading. The same button works in Preview and in
// the Live editor, and [[note#Heading]] from another note scrolls too.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function put(page, path, body) {
  await page.evaluate(async ([ns, p, b]) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') };
    const u = `/api/note?ns=${ns}&path=${encodeURIComponent(p)}`;
    await fetch(u, { method: 'POST', headers: h, body: '' });
    await fetch(u, { method: 'PUT', headers: h, body: b });
  }, [NS, path, body]);
}

async function remove(page, path) {
  await page.evaluate(async ([ns, p]) => {
    await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } });
  }, [NS, path]);
}

const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with enough words to take a line.`).join('\n\n');
const NOTE_BODY = `# Top\n\n${filler}\n\n## Deep section\n\nYou should land here.\n\n${filler}\n`;

// The heading is on screen, near the top of the pane it scrolls in.
async function headingInView(page, scope, text) {
  const h = page.locator(`${scope} h2`, { hasText: text }).first();
  await expect(h).toBeVisible({ timeout: 15_000 });
  return h.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight / 2;
  });
}

test('Copy link on a Preview heading opens the note at that heading', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { localStorage.setItem('mdnest_view_mode', 'preview'); });
  await signIn(page);
  const note = `__headings-${Date.now()}.md`;
  await put(page, note, NOTE_BODY);
  try {
    await page.goto(`/#${NS}/${note}`);
    const h = page.locator('.preview-pane h2', { hasText: 'Deep section' });
    await h.scrollIntoViewIfNeeded({ timeout: 15_000 });
    await h.hover();
    await page.getByTestId('heading-link-btn').click();
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(new RegExp(`#${NS}/${note.replace('.', '\\.')}#Deep%20section$`));

    // Open it fresh: the note loads scrolled to the heading.
    await page.goto('about:blank');
    await page.goto(url);
    await expect.poll(() => headingInView(page, '.preview-pane', 'Deep section'), { timeout: 15_000 }).toBe(true);
    // The heading is consumed: the address bar is back to the plain note.
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${NS}/${note}`);
  } finally {
    await remove(page, note);
  }
});

test('the Live editor has the same button, and copies a wikilink', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem('mdnest_view_mode', 'editor');
    localStorage.setItem('mdnest_editor_mode', 'live');
  });
  await signIn(page);
  const note = `__headings-live-${Date.now()}.md`;
  await put(page, note, NOTE_BODY);
  try {
    await page.goto(`/#${NS}/${note}`);
    const h = page.locator('.ProseMirror h2', { hasText: 'Deep section' });
    await h.scrollIntoViewIfNeeded({ timeout: 20_000 });
    const before = await page.evaluate(async ([ns, p]) => (await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } })).text(), [NS, note]);
    await h.hover();
    await page.getByTestId('heading-link-btn').click();
    await page.getByRole('menuitem', { name: 'Copy as [[wikilink]]' }).click();
    const wiki = await page.evaluate(() => navigator.clipboard.readText());
    expect(wiki).toBe(`[[${note.replace(/\.md$/, '')}#Deep section]]`);
    // The button is beside the document, never in it: the note is unchanged.
    await page.waitForTimeout(1500);
    const after = await page.evaluate(async ([ns, p]) => (await fetch(`/api/note?ns=${ns}&path=${encodeURIComponent(p)}`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('mdnest_token') } })).text(), [NS, note]);
    expect(after).toBe(before);

    // A heading link opened in Live mode lands on the heading too.
    await page.goto('about:blank');
    await page.goto(`/#${NS}/${note}#Deep%20section`);
    await expect.poll(() => headingInView(page, '.ProseMirror', 'Deep section'), { timeout: 20_000 }).toBe(true);
  } finally {
    await remove(page, note);
  }
});

test('[[note#Heading]] from another note opens it at the heading', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { localStorage.setItem('mdnest_view_mode', 'preview'); });
  await signIn(page);
  const stamp = Date.now();
  const target = `__headings-target-${stamp}.md`;
  const source = `__headings-source-${stamp}.md`;
  await put(page, target, NOTE_BODY);
  await put(page, source, `See [[__headings-target-${stamp}#Deep section]].\n`);
  try {
    await page.goto(`/#${NS}/${source}`);
    await page.reload(); // the tree, which resolves wikilinks, predates both notes
    await page.locator('.preview-pane a.wikilink').click({ timeout: 15_000 });
    await expect(page.locator('.toolbar-path')).toContainText(target, { timeout: 15_000 });
    await expect.poll(() => headingInView(page, '.preview-pane', 'Deep section'), { timeout: 15_000 }).toBe(true);
  } finally {
    await remove(page, source);
    await remove(page, target);
  }
});
