// Where the tree puts things: drops and new files must land where the user is
// aiming. Both tests build their own fixtures so they don't depend on whatever
// the namespace happens to contain.
//
// Two bugs pinned here:
//  1. Only a folder's own row accepted a drop. The expanded folder's contents
//     area had no handlers, so a drop there bubbled up to .sidebar-tree, which
//     treats a drop as "move to the namespace root" — aiming *inside* an open
//     folder silently moved the file OUT of it.
//  2. The sidebar's "+ Note" / "+ Drawing" always created at the namespace
//     root, even with a folder selected in the tree.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

// Read the tree from the API so assertions are about stored state, not the UI.
function readTree(page) {
  return page.evaluate(async () => {
    const t = localStorage.getItem('mdnest_token');
    const nss = await (await fetch('/api/namespaces', { headers: { Authorization: 'Bearer ' + t } })).json();
    const ns = location.hash.replace(/^#/, '').split('/')[0] || nss[0];
    const r = await fetch(`/api/tree?ns=${encodeURIComponent(ns)}`, { headers: { Authorization: 'Bearer ' + t } });
    return await r.json();
  });
}

const btn = (page, label) => page.locator('.sidebar-action-btn', { hasText: label });

async function create(page, label, name) {
  page.once('dialog', (d) => d.accept(name));
  await btn(page, label).click();
}

test('a new note lands in the folder selected in the tree', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  const folder = `target-${Date.now()}`;
  await create(page, '+ Folder', folder);
  const folderRow = page.locator('.tree-row', { hasText: folder }).first();
  await expect(folderRow).toBeVisible({ timeout: 20_000 });

  // Selecting the folder aims the create buttons at it, visibly.
  await folderRow.click();
  await expect(page.locator('.tree-row.folder-target')).toBeVisible();
  await expect(btn(page, '+ Note')).toHaveAttribute('title', new RegExp(`in ${folder}/`));

  const note = `inside-${Date.now()}.md`;
  await create(page, '+ Note', note);
  await expect(page.locator('.toolbar-path')).toContainText(note, { timeout: 20_000 });

  const t = await readTree(page);
  const f = (t.children || []).find((c) => c.name === folder);
  expect(f, 'folder missing from tree').toBeTruthy();
  expect((f.children || []).map((c) => c.name)).toContain(note);
  expect((t.children || []).map((c) => c.name), 'note leaked to the namespace root').not.toContain(note);
});

test("dropping onto an open folder's contents moves the file in, not to the root", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  // A file at the root to drag...
  const stray = `stray-${Date.now()}.md`;
  await create(page, '+ Note', stray);
  await expect(page.locator('.toolbar-path')).toContainText(stray, { timeout: 20_000 });

  // ...and a folder with something in it, so it has a contents area on screen.
  const folder = `dropzone-${Date.now()}`;
  await create(page, '+ Folder', folder);
  const folderRow = page.locator('.tree-row', { hasText: folder }).first();
  await expect(folderRow).toBeVisible({ timeout: 20_000 });
  await folderRow.click();
  const seeded = `seed-${Date.now()}.md`;
  await create(page, '+ Note', seeded);
  await expect(page.locator('.toolbar-path')).toContainText(seeded, { timeout: 20_000 });

  // Drop onto the folder's CONTENTS (the child row), never its own row.
  const childRow = page.locator('.tree-row', { hasText: seeded }).first();
  await expect(childRow).toBeVisible({ timeout: 20_000 });
  await page.locator('.tree-row', { hasText: stray }).first().dragTo(childRow);

  await expect.poll(async () => {
    const t = await readTree(page);
    const f = (t.children || []).find((c) => c.name === folder);
    return (f?.children || []).map((c) => c.name).includes(stray);
  }, { timeout: 20_000, message: 'file did not move into the folder' }).toBe(true);

  const after = await readTree(page);
  expect((after.children || []).map((c) => c.name), 'file was moved to the root instead')
    .not.toContain(stray);
});

test('the root row aims creation back at the top level', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  // Select a folder first — this is the state that used to be a one-way trip.
  const folder = `rootback-${Date.now()}`;
  await create(page, '+ Folder', folder);
  const folderRow = page.locator('.tree-row', { hasText: folder }).first();
  await expect(folderRow).toBeVisible({ timeout: 20_000 });
  await folderRow.click();
  await expect(btn(page, '+ Note')).toHaveAttribute('title', new RegExp(`in ${folder}/`));

  // Click the root row to aim back at the top level.
  await page.locator('.tree-root-row').click();
  await expect(page.locator('.tree-root-row')).toHaveClass(/folder-target/);
  await expect(btn(page, '+ Note')).toHaveAttribute('title', /namespace root/);

  const note = `atroot-${Date.now()}.md`;
  await create(page, '+ Note', note);
  await expect(page.locator('.toolbar-path')).toContainText(note, { timeout: 20_000 });

  const t = await readTree(page);
  expect((t.children || []).map((c) => c.name), 'note was not created at the root')
    .toContain(note);
  const f = (t.children || []).find((c) => c.name === folder);
  expect((f?.children || []).map((c) => c.name), 'note leaked into the selected folder')
    .not.toContain(note);
});

test('a file can be dragged out of a folder back to the root', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  // Put a file inside a folder.
  const folder = `outbound-${Date.now()}`;
  await create(page, '+ Folder', folder);
  const folderRow = page.locator('.tree-row', { hasText: folder }).first();
  await expect(folderRow).toBeVisible({ timeout: 20_000 });
  await folderRow.click();
  const note = `escape-${Date.now()}.md`;
  await create(page, '+ Note', note);
  await expect(page.locator('.toolbar-path')).toContainText(note, { timeout: 20_000 });

  // Drag it onto the root row.
  const noteRow = page.locator('.tree-row', { hasText: note }).first();
  await expect(noteRow).toBeVisible({ timeout: 20_000 });
  await noteRow.dragTo(page.locator('.tree-root-row'));

  await expect.poll(async () => {
    const t = await readTree(page);
    return (t.children || []).map((c) => c.name).includes(note);
  }, { timeout: 20_000, message: 'file did not move to the root' }).toBe(true);

  const after = await readTree(page);
  const f = (after.children || []).find((c) => c.name === folder);
  expect((f?.children || []).map((c) => c.name), 'file is still in the folder')
    .not.toContain(note);
});
