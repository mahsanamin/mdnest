// Download, move/copy between namespaces, and copy/paste between mdnest
// servers (issue #114), driven from the tree's context menu the way a user
// does it. Every assertion about the result reads stored state through the
// API, not the UI.
//
// The harness mounts two namespaces: testing_workspace (where the app opens)
// and zz_e2e_target. Each test keeps its fixtures in one uniquely named folder
// and deletes it afterwards: other specs drag rows in the same tree, and a
// root crowded with leftovers pushes their rows off-screen.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const SRC = 'testing_workspace';
const DST = 'zz_e2e_target';

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

// api calls the backend with the logged-in session's token.
function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + t }, body });
    const text = await r.text();
    return { status: r.status, text };
  }, { method, path, body });
}

const note = (ns, p) => `/note?ns=${ns}&path=${encodeURIComponent(p)}`;

async function seed(page, ns, p, content) {
  const r = await api(page, 'POST', note(ns, p), content);
  expect(r.status, `seed ${ns}:${p}`).toBe(201);
}

// Reload so the tree shows what the API just wrote, then open the menu on a row.
async function menuOn(page, name, item) {
  const row = page.locator('.tree-row', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: item }).first().click();
}

async function reloadTree(page) {
  await page.reload();
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

// Each test's fixtures live under one folder in each namespace; afterEach
// removes both.
let base;
test.beforeEach(() => { base = `xfer-${Date.now()}-${Math.floor(Math.random() * 1e4)}`; });
test.afterEach(async ({ page }) => {
  for (const ns of [SRC, DST]) await api(page, 'DELETE', note(ns, base)).catch(() => {});
});

// Expand the test's folder in the tree so its children have rows.
async function openBase(page) {
  const row = page.locator('.tree-row', { hasText: base }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // An open folder shows the folder-open icon; a click toggles it.
  if ((await row.locator('.tree-icon-svg.folder-open').count()) === 0) await row.click();
  await expect(row.locator('.tree-icon-svg.folder-open')).toHaveCount(1);
}

test.describe('download', () => {
  test('a file downloads as itself', async ({ page }) => {
    await login(page);
    const name = `dl-${Date.now()}.md`;
    await seed(page, SRC, `${base}/${name}`, '# hello download\n');
    await reloadTree(page);
    await openBase(page);
    const wait = page.waitForEvent('download');
    await menuOn(page, name, 'Download');
    const d = await wait;
    expect(d.suggestedFilename()).toBe(name);
    expect(fs.readFileSync(await d.path(), 'utf8')).toContain('# hello download');
  });

  test('a folder downloads as a zip that keeps its hierarchy', async ({ page }) => {
    await login(page);
    const dir = `dlzip-${Date.now()}`;
    await seed(page, SRC, `${base}/${dir}/a.md`, 'a\n');
    await seed(page, SRC, `${base}/${dir}/sub/b.md`, 'b\n');
    await reloadTree(page);
    await openBase(page);
    const wait = page.waitForEvent('download');
    await menuOn(page, dir, 'Download as zip');
    const d = await wait;
    expect(d.suggestedFilename()).toBe(`${dir}.zip`);
    const bytes = fs.readFileSync(await d.path());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    // Entry names are stored uncompressed in the zip's directory.
    const raw = bytes.toString('latin1');
    for (const entry of [`${dir}/`, `${dir}/a.md`, `${dir}/sub/`, `${dir}/sub/b.md`]) {
      expect(raw).toContain(entry);
    }
  });
});

test.describe('move and copy between namespaces', () => {
  // Choose the test's own folder in the target namespace.
  async function pick(page, ns, name) {
    const modal = page.getByTestId('transfer-modal');
    await expect(modal).toBeVisible();
    await modal.getByTestId('transfer-namespace').selectOption(ns);
    await modal.locator('.moveto-item', { hasText: base }).click();
    if (name) await modal.getByTestId('transfer-name').fill(name);
    return modal;
  }

  test('copy to another namespace keeps the source and lands in the target', async ({ page }) => {
    await login(page);
    const name = `copy-${Date.now()}.md`;
    await seed(page, SRC, `${base}/${name}`, 'copied body\n');
    await api(page, 'POST', `/folder?ns=${DST}&path=${base}`);
    await reloadTree(page);
    await openBase(page);
    await menuOn(page, name, 'Copy to…');
    const modal = await pick(page, DST);
    await expect(modal.getByTestId('transfer-check')).toContainText('Ready', { timeout: 10_000 });
    await modal.getByTestId('transfer-confirm').click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    const target = await api(page, 'GET', note(DST, `${base}/${name}`));
    expect(target.status).toBe(200);
    expect(target.text).toContain('copied body');
    expect((await api(page, 'GET', note(SRC, `${base}/${name}`))).status).toBe(200);
  });

  test('a collision is shown before confirming and nothing is overwritten', async ({ page }) => {
    await login(page);
    const name = `clash-${Date.now()}.md`;
    await seed(page, SRC, `${base}/${name}`, 'mine\n');
    await seed(page, DST, `${base}/${name}`, 'theirs\n');
    await reloadTree(page);
    await openBase(page);
    await menuOn(page, name, 'Copy to…');
    const modal = await pick(page, DST);
    await expect(modal.getByTestId('transfer-check')).toContainText(`"${base}/${name}" already exists`, { timeout: 10_000 });
    await expect(modal.getByTestId('transfer-confirm')).toBeDisabled();
    await expect(modal.getByTestId('transfer-name')).toHaveClass(/conflict/);
    // Renaming clears it.
    await modal.getByTestId('transfer-name').fill(`renamed-${name}`);
    await expect(modal.getByTestId('transfer-check')).toContainText('Ready', { timeout: 10_000 });
    await modal.locator('button', { hasText: 'Cancel' }).click();
    expect((await api(page, 'GET', note(DST, `${base}/${name}`))).text).toContain('theirs');
  });

  test('move to another namespace removes the source', async ({ page }) => {
    await login(page);
    const dir = `mv-${Date.now()}`;
    await seed(page, SRC, `${base}/${dir}/one.md`, 'one\n');
    await api(page, 'POST', `/folder?ns=${DST}&path=${base}`);
    await reloadTree(page);
    await openBase(page);
    await menuOn(page, dir, 'Move to…');
    const modal = await pick(page, DST);
    await expect(modal.getByTestId('transfer-check')).toContainText('Ready', { timeout: 10_000 });
    await modal.getByTestId('transfer-confirm').click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    expect((await api(page, 'GET', note(DST, `${base}/${dir}/one.md`))).text).toContain('one');
    expect((await api(page, 'GET', note(SRC, `${base}/${dir}/one.md`))).status).toBe(404);
    await expect(page.locator('.tree-row', { hasText: dir })).toHaveCount(0, { timeout: 20_000 });
  });
});

test.describe('a new folder in the picker', () => {
  test('moves a folder into a folder created in the picker, sized up first', async ({ page }) => {
    await login(page);
    const dir = `nf-${Date.now()}`;
    await seed(page, SRC, `${base}/${dir}/one.md`, 'one\n');
    await seed(page, SRC, `${base}/${dir}/sub/two.md`, 'two\n');
    await api(page, 'POST', `/folder?ns=${DST}&path=${base}`);
    await reloadTree(page);
    await openBase(page);
    await menuOn(page, dir, 'Move to…');

    const modal = page.getByTestId('transfer-modal');
    await modal.getByTestId('transfer-namespace').selectOption(DST);
    await modal.locator('.moveto-item', { hasText: base }).click();
    await modal.getByTestId('transfer-new-folder').click();
    // A name that would be refused explains itself and adds nothing.
    await modal.getByTestId('transfer-new-folder-name').fill('a/b');
    await modal.getByTestId('transfer-new-folder-add').click();
    await expect(modal.locator('.moveto-newfolder-error')).toBeVisible();
    await modal.getByTestId('transfer-new-folder-name').fill('Archive');
    await modal.getByTestId('transfer-new-folder-name').press('Enter');

    const row = modal.locator('.moveto-item', { hasText: 'Archive' });
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(row.locator('.moveto-new-badge')).toBeVisible();
    const check = modal.getByTestId('transfer-check');
    await expect(check).toContainText('Ready', { timeout: 10_000 });
    await expect(check).toContainText('move 2 files');
    await expect(check).toContainText(`creates the folder ${base}/Archive`);
    // Nothing was created yet: cancelling now would leave no empty folder.
    const before = await api(page, 'GET', `/tree?ns=${DST}`);
    expect(before.text).not.toContain('Archive');

    await modal.getByTestId('transfer-confirm').click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    expect((await api(page, 'GET', note(DST, `${base}/Archive/${dir}/sub/two.md`))).text).toContain('two');
    expect((await api(page, 'GET', note(SRC, `${base}/${dir}/one.md`))).status).toBe(404);
  });
});

test.describe('copy for another mdnest, paste here', () => {
  // A real paste event carrying the given text, as Ctrl/Cmd+V produces.
  async function pasteInto(page, text) {
    const box = page.getByTestId('paste-capture');
    await expect(box).toBeFocused();
    await box.evaluate((el, t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
  }

  test('copy puts the note on the clipboard and paste creates it, never overwriting', async ({ page }) => {
    await login(page);
    const name = `clip-${Date.now()}.md`;
    await seed(page, SRC, `${base}/${name}`, '# clipboard note\n\n![pic](pic.png)\n');
    await reloadTree(page);
    await openBase(page);
    await menuOn(page, name, 'Copy for another mdnest');
    await expect(page.getByTestId('notice-bar')).toContainText('Copied', { timeout: 10_000 });
    await expect(page.getByTestId('notice-bar')).toContainText('1 linked file');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const payload = JSON.parse(clip);
    expect(payload).toMatchObject({ mdnest: 'file/v1', name });
    expect(payload.content).toContain('# clipboard note');
    expect(payload.content).not.toMatch(/<!-- mdnest:/);

    // Paste into a folder of its own (inside the test's folder) — as the
    // other server would, here the same one.
    const sub = `pastein-${Date.now()}`;
    const dir = `${base}/${sub}`;
    await api(page, 'POST', `/folder?ns=${SRC}&path=${dir}`);
    await reloadTree(page);
    await openBase(page);
    await menuOn(page, sub, 'Paste here');
    await pasteInto(page, clip);
    await expect(page.getByTestId('paste-name')).toHaveValue(name);
    await expect(page.getByTestId('paste-message')).toContainText('not copied');
    await page.getByTestId('paste-confirm').click();
    await expect(page.getByTestId('paste-modal')).toBeHidden({ timeout: 10_000 });
    expect((await api(page, 'GET', note(SRC, `${dir}/${name}`))).text).toContain('# clipboard note');

    // Again: the name is taken, so a "(copy)" name is offered, not applied.
    await reloadTree(page);
    await openBase(page);
    await menuOn(page, sub, 'Paste here');
    await pasteInto(page, clip);
    await page.getByTestId('paste-confirm').click();
    await expect(page.getByTestId('paste-message')).toContainText('already exists');
    const copyName = name.replace(/\.md$/, ' (copy).md');
    await expect(page.getByTestId('paste-name')).toHaveValue(copyName);
    expect((await api(page, 'GET', note(SRC, `${dir}/${copyName}`))).status).toBe(404);
    await page.getByTestId('paste-confirm').click();
    await expect(page.getByTestId('paste-modal')).toBeHidden({ timeout: 10_000 });
    expect((await api(page, 'GET', note(SRC, `${dir}/${copyName}`))).status).toBe(200);
  });

  test('a paste over 1 MB is refused with the download hint', async ({ page }) => {
    await login(page);
    await reloadTree(page);
    const root = page.locator('.tree-root-row').first();
    await root.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Paste here' }).click();
    // Under a million characters, over a million UTF-8 bytes.
    const big = JSON.stringify({ mdnest: 'file/v1', name: 'big.md', content: 'ملاحظات '.repeat(80_000) });
    await pasteInto(page, big);
    await expect(page.getByTestId('paste-message')).toContainText('over the 1.0 MB clipboard limit');
    await expect(page.getByTestId('paste-message')).toContainText('Download');
    await expect(page.getByTestId('paste-confirm')).toBeDisabled();
  });
});

test.describe('an open note that moves', () => {
  // Someone else (another tab, an agent) moves the note this editor has open.
  // The next autosave must not re-create it at the old path, and must say so.
  test('autosave to a moved note shows a banner and re-creates nothing', async ({ page }) => {
    await login(page);
    const name = `open-${Date.now()}.md`;
    await seed(page, SRC, `${base}/${name}`, 'start\n');
    await api(page, 'POST', `/folder?ns=${DST}&path=${base}`);
    await reloadTree(page);
    await openBase(page);
    await page.locator('.tree-row', { hasText: name }).first().click();
    await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });

    const moved = await api(page, 'POST', '/transfer', JSON.stringify({
      mode: 'move', from: { ns: SRC, path: `${base}/${name}` }, to: { ns: DST, path: `${base}/${name}` },
    }));
    expect(moved.status).toBe(200);

    const editor = page.locator('.ProseMirror, textarea.editor-textarea, .editor textarea').first();
    await editor.click();
    await page.keyboard.type(' edited after the move');
    await expect(page.getByTestId('missing-note-banner')).toBeVisible({ timeout: 15_000 });
    expect((await api(page, 'GET', note(SRC, `${base}/${name}`))).status).toBe(404);
    expect((await api(page, 'GET', note(DST, `${base}/${name}`))).text).not.toContain('edited after the move');
  });

  test('moving the open note to another namespace takes the editor with it', async ({ page }) => {
    await login(page);
    const name = `follow-${Date.now()}.md`;
    await seed(page, SRC, `${base}/${name}`, 'follow me\n');
    await api(page, 'POST', `/folder?ns=${DST}&path=${base}`);
    await reloadTree(page);
    await openBase(page);
    await page.locator('.tree-row', { hasText: name }).first().click();
    await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });

    await menuOn(page, name, 'Move to…');
    const modal = page.getByTestId('transfer-modal');
    await modal.getByTestId('transfer-namespace').selectOption(DST);
    await modal.locator('.moveto-item', { hasText: base }).click();
    await expect(modal.getByTestId('transfer-check')).toContainText('Ready', { timeout: 10_000 });
    await modal.getByTestId('transfer-confirm').click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    await expect(page.locator('.ns-select')).toHaveValue(DST, { timeout: 20_000 });
    await expect(page.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });
    expect(decodeURIComponent(new URL(page.url()).hash)).toContain(`${DST}/${base}/${name}`);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // A long-press is the phone's right-click: hold a row, the menu opens.
  async function longPress(page, locator) {
    const box = await locator.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await locator.evaluate((el, { x, y }) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
    }, { x, y });
    await page.waitForTimeout(700);
    await locator.evaluate((el, { x, y }) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true }));
    }, { x, y });
  }

  test('long-press opens Copy to…, and the picker fits the screen', async ({ page }) => {
    await login(page);
    const name = `phone-${Date.now()}.md`;
    await seed(page, SRC, `${base}/${name}`, 'phone\n');
    await api(page, 'POST', `/folder?ns=${DST}&path=${base}`);
    await reloadTree(page);
    // The sidebar is a slide-over on a phone; a closed one is merely moved
    // off-screen, so wait for the row to be in the viewport, not "visible".
    await page.locator('.toolbar-hamburger').click();
    await expect(page.locator('.tree-row', { hasText: base }).first()).toBeInViewport({ timeout: 10_000 });
    await openBase(page);
    await longPress(page, page.locator('.tree-row', { hasText: name }).first());
    for (const item of ['Download', 'Copy to…', 'Copy for another mdnest']) {
      await expect(page.locator('.context-menu-item', { hasText: item }).first()).toBeVisible();
    }
    await page.locator('.context-menu-item', { hasText: 'Copy to…' }).click();

    const modal = page.getByTestId('transfer-modal');
    await expect(modal).toBeVisible();
    const mb = await modal.boundingBox();
    expect(mb.x).toBeGreaterThanOrEqual(0);
    expect(mb.x + mb.width).toBeLessThanOrEqual(390);
    await modal.getByTestId('transfer-namespace').selectOption(DST);
    await modal.locator('.moveto-item', { hasText: base }).tap();
    await expect(modal.getByTestId('transfer-check')).toContainText('Ready', { timeout: 10_000 });
    const confirm = modal.getByTestId('transfer-confirm');
    const cb = await confirm.boundingBox();
    expect(cb.height).toBeGreaterThanOrEqual(40);
    expect(cb.x + cb.width).toBeLessThanOrEqual(390);
    await confirm.tap();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    expect((await api(page, 'GET', note(DST, `${base}/${name}`))).status).toBe(200);
  });
});
