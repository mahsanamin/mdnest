// HTML pages (ENABLE_PAGES) in a real browser, against a stack booted by
// tests/e2e-pages.sh in one mode at a time (MDNEST_PAGES_MODE=static|script).
// The page under test is a probe: its script tries everything a hostile page
// would (read the login token, call the API as the viewer, navigate the window
// around it, reach another page) and reports each result with postMessage.
// Each "cannot" has a control next to it that shows the probe itself works.
import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const MODE = process.env.MDNEST_PAGES_MODE || '';
const PAGES_ORIGIN = process.env.MDNEST_PAGES_ORIGIN || '';
const SECRET = process.env.MDNEST_JWT_SECRET || '';
const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = 'testing_workspace';

test.skip(!MODE, 'needs a stack with pages on (tests/e2e-pages.sh)');

const run = `${process.pid}${Date.now() % 100000}`;
const DIR = `pages-e2e-${run}`;
const PROBE = `${DIR}/probe.page.md`;
const OTHER = `${DIR}/other.page.md`;
const OTHER_SECRET = `OTHER-SECRET-${run}`;
const NOTES_DIR = process.env.MDNEST_NOTES_DIR || '';
let otherId = '';

// The probe knows the other page's id: a handle is readable, so a hostile
// page author may well know it. It still cannot load that page.
function probeHtml(main) {
  return `<!doctype html><html><head><title>Probe ${run}</title><link rel="stylesheet" href="style.css"></head>
<body><p id="status">Scripts did not run.</p><img id="img" src="img/dot.svg" width="20">
<script>
(async () => {
  const out = { probe: ${JSON.stringify(run)}, ran: true };
  document.getElementById('status').textContent = 'SCRIPT RAN';
  try { out.token = String(localStorage.getItem('mdnest_token')); } catch (e) { out.token = 'blocked:' + e.name; }
  try { out.parentToken = String(parent.localStorage.getItem('mdnest_token')); } catch (e) { out.parentToken = 'blocked:' + e.name; }
  try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked:' + e.name; }
  try { const r = await fetch('data.json'); out.own = r.status + ':' + (await r.text()); } catch (e) { out.own = 'blocked:' + e.name; }
  try { const r = await fetch(${JSON.stringify(main)} + '/api/namespaces', { credentials: 'include' }); out.api = r.status + ':' + (await r.text()).slice(0, 200); } catch (e) { out.api = 'blocked:' + e.name; }
  for (const [k, u] of [['other1', '../' + ${JSON.stringify(otherId)} + '/index.html'], ['other2', location.origin + '/' + ${JSON.stringify(otherId)} + '/index.html'], ['other3', location.pathname + '%2e%2e/' + ${JSON.stringify(otherId)} + '/index.html']]) {
    try { const r = await fetch(u); out[k] = r.status + ':' + (await r.text()).slice(0, 200); } catch (e) { out[k] = 'blocked:' + e.name; }
  }
  parent.postMessage(out, '*');
  try { top.location.href = ${JSON.stringify(main)} + '/#hijacked-${run}'; out.nav = 'no-throw'; } catch (e) { out.nav = 'blocked:' + e.name; }
  parent.postMessage({ probe: out.probe, nav: out.nav }, '*');
})();
</script></body></html>`;
}

// A minimal ustar, enough for a few small text files (names under 100 bytes).
function tar(files) {
  const blocks = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(' ', 148, 156); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

let token = '';
let mainOrigin = '';

test.beforeAll(async ({ request, baseURL }) => {
  mainOrigin = new URL(baseURL).origin;
  const login = await request.post('/api/auth/login', { data: { username: USER, password: PASS } });
  token = (await login.json()).token;
  const auth = { Authorization: `Bearer ${token}` };
  const put = async (path, body, ct) => {
    const r = await request.put(`/api/pages?ns=${NS}&path=${encodeURIComponent(path)}`, { headers: { ...auth, 'Content-Type': ct }, data: body });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()).id;
  };
  otherId = await put(OTHER, `<title>Other</title><p>${OTHER_SECRET}</p>`, 'text/html');
  await put(PROBE, tar({
    'index.html': probeHtml(mainOrigin),
    'style.css': 'body{background:rgb(1, 2, 3)}',
    'img/dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>',
    'data.json': '{"own":"OWN-DATA"}',
  }), 'application/x-tar');
});

// Deleting the folder deletes the handles in it, and with them their pages.
test.afterAll(async ({ request }) => {
  for (const d of [DIR, `${DIR}-drop`]) {
    await request.delete(`/api/note?ns=${NS}&path=${encodeURIComponent(d)}`, { headers: { Authorization: `Bearer ${token}` } });
  }
});

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

// The toolbar's Pages button opens the Pages view (cards); a card's Open
// shows the HTML page in the viewer.
async function openPagesView(page) {
  // The toolbar's Pages button opens the side panel's Pages tab where it
  // fits; the full view is the panel's ⤢ (or the button itself where it
  // does not fit).
  // The button toggles: when the panel already shows Pages, clicking it
  // would close the panel, so go straight to its ⤢ then.
  const onPagesTab = await page.locator('[data-testid=side-panel-title][data-tab=pages]').isVisible().catch(() => false);
  if (!onPagesTab) await page.locator('[data-testid=toolbar-pages]').click();
  // Either the panel (with its ⤢) or the full view comes up; wait for one.
  const expand = page.locator('[data-testid=side-panel-expand]');
  await expect(expand.or(page.locator('[data-testid=pages-view]')).first()).toBeVisible({ timeout: 15_000 });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator('[data-testid=pages-view]')).toBeVisible({ timeout: 15_000 });
}
async function openFromPagesView(page, path) {
  await openPagesView(page);
  await page.locator(`[data-testid="page-card-${path}"] .page-card-open`).click();
}

async function openProbe(page) {
  await login(page);
  // The token this browser holds is the one the probe must never see.
  token = await page.evaluate(() => localStorage.getItem('mdnest_token')) || token;
  await page.evaluate(() => {
    window.__reports = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.probe) window.__reports.push(e.data); });
  });
  await openFromPagesView(page, PROBE);
  const frameEl = page.locator('[data-testid=page-frame]');
  await expect(frameEl).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.page-bar')).toContainText(`Probe ${run}`);
  return frameEl;
}

const reports = (page) => page.evaluate(() => window.__reports);

test('static mode: the page shows, its script does not run', async ({ page }) => {
  test.skip(MODE !== 'static');
  const frameEl = await openProbe(page);
  expect(await frameEl.getAttribute('sandbox')).toBe('');
  const frame = page.frameLocator('[data-testid=page-frame]');
  // Control: the page itself, its CSS and its image load.
  await expect(frame.locator('#status')).toHaveText('Scripts did not run.');
  await expect.poll(() => frame.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(1, 2, 3)');
  await expect.poll(() => frame.locator('#img').evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(await reports(page)).toEqual([]);
  expect(page.url()).not.toContain('hijacked');
  await expect(page.locator('.page-bar')).toBeVisible();
});

test('script mode: the script runs, but cannot reach the viewer or other pages', async ({ page }) => {
  test.skip(MODE !== 'script');
  const frameEl = await openProbe(page);
  expect(await frameEl.getAttribute('sandbox')).toBe('allow-scripts');
  expect(new URL(await frameEl.getAttribute('src')).origin).toBe(PAGES_ORIGIN);

  await expect.poll(async () => (await reports(page)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const [r, nav] = await reports(page);

  // Control: the script ran and can load its own files.
  expect(r.ran).toBe(true);
  await expect(page.frameLocator('[data-testid=page-frame]').locator('#status')).toHaveText('SCRIPT RAN');
  expect(r.own).toBe('200:{"own":"OWN-DATA"}');

  // Cannot read mdnest_token, from its own storage or the app's.
  const all = JSON.stringify([r, nav]);
  expect(all).not.toContain(token);
  expect(r.token).toMatch(/^blocked:|^null$/);
  expect(r.parentToken).toMatch(/^blocked:/);

  // Cannot call the mdnest API as the viewer.
  expect(r.api).not.toMatch(/^200:/);
  expect(r.api).not.toContain(NS);

  // Cannot load another page with its own pass.
  for (const k of ['other1', 'other2', 'other3']) {
    expect(r[k], k).not.toContain(OTHER_SECRET);
    expect(r[k], k).not.toMatch(/^200:/);
  }

  // Cannot navigate the window around it.
  await page.waitForTimeout(1000);
  expect(page.url()).not.toContain('hijacked');
  await expect(page.locator('.page-bar')).toContainText(`Probe ${run}`);
});

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
// Passes are signed with a key derived from the JWT secret, never the secret
// itself (pagePassKey in backend/handlers/pages.go).
function passKey() { return createHmac('sha256', SECRET).update('mdnest-pages').digest(); }
function sign(payload, key = passKey()) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

test('an expired pass is rejected, and a pass opens only its own page', async ({ request }) => {
  test.skip(!SECRET, 'needs MDNEST_JWT_SECRET to mint a pass');
  const auth = { Authorization: `Bearer ${token}` };
  const res = await request.post(`/api/pages/pass?ns=${NS}&path=${encodeURIComponent(PROBE)}`, { headers: auth });
  const { url } = await res.json();
  const base = MODE === 'script' ? PAGES_ORIGIN : mainOrigin;
  const prefix = MODE === 'script' ? '/' : '/api/pages/view/';
  const absolute = new URL(url, mainOrigin).href;
  const pass = new URL(absolute).pathname.slice(prefix.length).split('/')[0];
  const claims = JSON.parse(Buffer.from(pass.split('.')[1], 'base64url').toString());

  // Control: the same claims, signed again with a future expiry, open the page.
  const fresh = sign({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 });
  expect((await request.get(`${base}${prefix}${fresh}/`)).status()).toBe(200);
  // The same claims signed with the raw JWT secret (the login key) are refused.
  const raw = sign({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
  expect((await request.get(`${base}${prefix}${raw}/`)).status()).toBe(403);
  // Expired.
  const expired = sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 });
  const e = await request.get(`${base}${prefix}${expired}/`);
  expect(e.status()).toBe(403);
  // The pass for one page never serves another, whatever the path says.
  for (const path of [`../${otherId}/index.html`, `%2e%2e/${otherId}/index.html`, `..%2f${otherId}%2findex.html`]) {
    const r = await request.get(`${base}${prefix}${pass}/${path}`, { maxRedirects: 0 });
    expect(await r.text(), path).not.toContain(OTHER_SECRET);
  }
  // A pass is not a login.
  expect((await request.get('/api/pages?ns=' + NS, { headers: { Authorization: `Bearer ${pass}` } })).status()).toBe(401);
});

// ---- the page as a handle in the tree, and publishing by drag and drop ----

// dropOnFolder fires a drop of desktop files on a tree folder row. The entries
// stand in for what Chrome's webkitGetAsEntry hands out for a dropped folder,
// with real File objects, so the app reads folders exactly as it would.
async function dropOnFolder(page, folderName, spec) {
  await page.evaluate(({ folderName, spec }) => {
    const fileEntry = (name, body, type) => {
      const f = new File([body], name, { type: type || '' });
      return { name, isFile: true, isDirectory: false, file: (ok) => ok(f) };
    };
    const dirEntry = (name, children) => ({
      name, isFile: false, isDirectory: true,
      createReader() {
        let done = false;
        return { readEntries(ok) { const b = done ? [] : children; done = true; setTimeout(() => ok(b), 0); } };
      },
    });
    const build = (n) => (n.children ? dirEntry(n.name, n.children.map(build)) : fileEntry(n.name, n.body, n.type));
    const entries = spec.map(build);
    const dt = { types: ['Files'], items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })), files: [] };
    const row = Array.from(document.querySelectorAll('.tree-row')).find((r) => r.querySelector('.tree-label')?.textContent === folderName);
    if (!row) throw new Error('no folder row ' + folderName);
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    row.dispatchEvent(ev);
  }, { folderName, spec });
}

async function makeFolder(request, path) {
  const r = await request.post(`/api/folder?ns=${NS}&path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(r.status()).toBeLessThan(300);
}

const notice = (page) => page.locator('[data-testid=notice-bar]');

test('a "Webpage, complete" save dropped on a folder becomes one page that keeps its _files', async ({ page, request }) => {
  test.skip(MODE !== 'static', 'the drop is the same in both modes');
  const dropDir = `${DIR}-drop`;
  await makeFolder(request, dropDir);
  await login(page);
  await expect(page.locator('.tree-label', { hasText: dropDir })).toBeVisible({ timeout: 15_000 });
  await dropOnFolder(page, dropDir, [
    { name: 'Q3 Sales Report.html', body: '<html><head><title>Saved Q3</title><link rel="stylesheet" href="Q3 Sales Report_files/style.css"></head><body><h1 id="h">SAVED-PAGE</h1><img id="img" src="Q3 Sales Report_files/dot.svg"></body></html>' },
    { name: 'Q3 Sales Report_files', children: [
      { name: 'style.css', body: 'body{background:rgb(4, 5, 6)}' },
      { name: 'dot.svg', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>' },
    ] },
  ]);
  await expect(notice(page)).toContainText('Published q3-sales-report', { timeout: 15_000 });
  // The app opens the new handle in the viewer, with its own files working.
  await expect(page.locator('.toolbar-path')).toContainText('q3-sales-report.page.md', { timeout: 15_000 });
  const frame = page.frameLocator('[data-testid=page-frame]');
  await expect(frame.locator('#h')).toHaveText('SAVED-PAGE');
  await expect.poll(() => frame.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(4, 5, 6)');
  await expect.poll(() => frame.locator('#img').evaluate((i) => i.naturalWidth)).toBeGreaterThan(0);
  // One page in the tree, not the assets.
  const res = await request.get(`/api/tree?ns=${NS}`, { headers: { Authorization: `Bearer ${token}` } });
  const tree = JSON.stringify(await res.json());
  expect(tree).toContain('q3-sales-report.page.md');
  expect(tree).not.toContain('style.css');
  await expect(page.locator('.tree-row', { hasText: 'q3-sales-report.page.md' }).locator('.tree-icon-svg.page')).toBeVisible();

  // Dropping it again asks first; saying no changes nothing.
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await dropOnFolder(page, dropDir, [{ name: 'Q3 Sales Report.html', body: '<p>SECOND</p>' }]);
  await expect.poll(() => asked).toBe('Replace page q3-sales-report?');
  await expect(frame.locator('#h')).toHaveText('SAVED-PAGE');
  // Saying yes replaces it.
  page.once('dialog', (d) => d.accept());
  await dropOnFolder(page, dropDir, [{ name: 'Q3 Sales Report.html', body: '<p id="h">SECOND</p>' }]);
  await expect(notice(page)).toContainText('Published q3-sales-report', { timeout: 15_000 });
  await expect(page.frameLocator('[data-testid=page-frame]').locator('#h')).toHaveText('SECOND', { timeout: 15_000 });

  // Over the size limit (the harness sets PAGES_MAX_MB=1): refused before
  // uploading, with the limit named.
  await dropOnFolder(page, dropDir, [{ name: 'huge.html', body: 'x'.repeat(1536 * 1024) }]);
  await expect(notice(page)).toContainText('at most 1 MB (PAGES_MAX_MB)', { timeout: 15_000 });
  // Not HTML: nothing happens, as before.
  await dropOnFolder(page, dropDir, [{ name: 'photo.png', body: 'PNG' }]);
  await page.waitForTimeout(500);
  const after = JSON.stringify(await (await request.get(`/api/tree?ns=${NS}`, { headers: { Authorization: `Bearer ${token}` } })).json());
  expect(after).not.toContain('photo');
  expect(after).not.toContain('huge');
});

test('dragging a handle to another folder keeps the page open', async ({ page, request }) => {
  test.skip(MODE !== 'static', 'the same in both modes');
  await makeFolder(request, `${DIR}/moved-to`);
  await login(page);
  await openFromPagesView(page, OTHER);
  await expect(page.frameLocator('[data-testid=page-frame]').locator('p')).toHaveText(OTHER_SECRET, { timeout: 15_000 });
  const handleRow = page.locator('.tree-row', { hasText: 'other.page.md' });
  const target = page.locator('.tree-row', { hasText: 'moved-to' });
  await expect(target).toBeVisible();
  await handleRow.dragTo(target);
  await expect(page.locator('.toolbar-path')).toContainText('moved-to/other.page.md', { timeout: 15_000 });
  await expect(page.frameLocator('[data-testid=page-frame]').locator('p')).toHaveText(OTHER_SECRET, { timeout: 15_000 });
  await expect(page.locator('[data-testid=page-error]')).toHaveCount(0);
});

test('a page whose handle was removed outside mdnest is listed as unlinked for a root writer', async ({ page, request }) => {
  test.skip(MODE !== 'static' || !NOTES_DIR, 'needs the notes folder (MDNEST_NOTES_DIR)');
  const { unlinkSync, writeFileSync } = await import('node:fs');
  const auth = { Authorization: `Bearer ${token}` };
  const r = await request.put(`/api/pages?ns=${NS}&path=${encodeURIComponent(`${DIR}/orphan.page.md`)}`, { headers: { ...auth, 'Content-Type': 'text/html' }, data: `<title>Orphan ${run}</title><p>o</p>` });
  expect(r.status()).toBe(200);
  // What git sync would do: the file goes away behind mdnest's back.
  unlinkSync(`${NOTES_DIR}/${NS}/${DIR}/orphan.page.md`);
  await login(page);
  await openPagesView(page);
  await page.locator('[data-testid=pages-unlinked-tab]').click();
  const card = page.locator('[data-testid=pages-unlinked] .page-card', { hasText: `Orphan ${run}` });
  await expect(card).toBeVisible({ timeout: 15_000 });
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.accept(); });
  await card.getByRole('button', { name: /Delete/ }).click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  expect(asked).toContain('cannot be undone');
  // A hand-written handle naming an id that does not exist: a clear 404 in the viewer.
  writeFileSync(`${NOTES_DIR}/${NS}/${DIR}/ghost.page.md`, '---\npage: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n');
  await page.reload();
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  await openFromPagesView(page, `${DIR}/ghost.page.md`);
  await expect(page.locator('[data-testid=page-error]')).toContainText('publish it again here', { timeout: 15_000 });
});

test('the Pages view: cards, description, search, sort, reveal in tree, and nothing in the left pane', async ({ page, request }) => {
  test.skip(MODE !== 'static', 'the same in both modes');
  const auth = { Authorization: `Bearer ${token}` };
  const put = async (path, html) => {
    const r = await request.put(`/api/pages?ns=${NS}&path=${encodeURIComponent(path)}`, { headers: { ...auth, 'Content-Type': 'text/html' }, data: html });
    expect(r.status(), await r.text()).toBe(200);
  };
  await put(`${DIR}/cards/aardvark.page.md`, `<title>Aardvark ${run}</title><meta name="description" content="About aardvarks ${run}"><p>zebracrossing${run}</p>`);
  // Published times have one-second resolution: make Zulu the newer one.
  await new Promise((r) => setTimeout(r, 1100));
  await put(`${DIR}/cards/deep/zulu.page.md`, `<title>Zulu ${run}</title><p>plain</p>`);
  await login(page);
  // Nothing of pages in the left pane any more.
  await expect(page.locator('.sidebar [data-testid=pages-section], .sidebar .pages-list')).toHaveCount(0);
  await openPagesView(page);
  await expect(page.locator('.toolbar-path')).not.toContainText('.md');

  const aard = page.locator(`[data-testid="page-card-${DIR}/cards/aardvark.page.md"]`);
  const zulu = page.locator(`[data-testid="page-card-${DIR}/cards/deep/zulu.page.md"]`);
  await expect(aard).toContainText(`Aardvark ${run}`);
  await expect(aard.locator('.page-card-folder')).toHaveText(`${DIR}/cards/`);
  await expect(aard.locator('[data-testid=page-card-desc]')).toHaveText(`About aardvarks ${run}`);
  await expect(aard.locator('.page-card-meta')).toContainText('1 file');
  await expect(zulu.locator('[data-testid=page-card-desc]')).toHaveCount(0);
  await expect(page.locator('[data-testid=pages-view] iframe')).toHaveCount(0);

  // Search runs over the stored text and the description.
  await page.locator('[data-testid=pages-search]').fill(`zebracrossing${run}`);
  await expect(zulu).toHaveCount(0, { timeout: 10_000 });
  await expect(aard).toBeVisible();
  await page.locator('[data-testid=pages-search]').fill(`about aardvarks ${run}`);
  await expect(aard).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-testid=pages-search]').fill(run);
  await expect(zulu).toBeVisible({ timeout: 10_000 });

  // Sort by title: Aardvark before Zulu; newest first by default: Zulu first.
  const titles = () => page.locator('.page-card-title').allTextContents();
  const idx = async (t) => (await titles()).findIndex((x) => x.includes(t));
  expect(await idx(`Zulu ${run}`)).toBeLessThan(await idx(`Aardvark ${run}`));
  await page.locator('[data-testid=pages-sort]').selectOption('title');
  expect(await idx(`Aardvark ${run}`)).toBeLessThan(await idx(`Zulu ${run}`));

  // The target button reveals the handle in the tree, expanded and
  // highlighted, without opening the page.
  await zulu.locator('.page-card-locate').click();
  const row = page.locator(`.tree-row[data-path="${DIR}/cards/deep/zulu.page.md"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveClass(/reveal-flash/);
  await expect(page.locator('[data-testid=pages-view]')).toBeVisible();
  await expect(page.locator('[data-testid=page-view]')).toHaveCount(0);

  // Open shows the viewer and leaves the Pages view.
  await aard.locator('.page-card-open').click();
  await expect(page.locator('[data-testid=pages-view]')).toHaveCount(0);
  await expect(page.locator('.page-bar')).toContainText(`Aardvark ${run}`, { timeout: 10_000 });
  await expect(page.frameLocator('[data-testid=page-frame]').locator('p')).toHaveText(`zebracrossing${run}`);
  // Back to the Pages view, then opening a note from the tree closes it.
  await openPagesView(page);
  await page.locator(`.tree-row[data-path="${DIR}/cards/deep/zulu.page.md"]`).click();
  await expect(page.locator('[data-testid=pages-view]')).toHaveCount(0);
  await expect(page.locator('.page-bar')).toContainText(`Zulu ${run}`, { timeout: 10_000 });
});

test('the side panel resizes smoothly both ways while an HTML page is open beside it', async ({ page, request }) => {
  test.skip(MODE !== 'static', 'the same in both modes');
  // Dragging the edge left passes over the page's iframe. The frame swallows
  // mouse events, so without a guard the drag stalls on the way left (it
  // worked on the way right, over the panel itself).
  const path = `${DIR}/drag/wide.page.md`;
  const r = await request.put(`/api/pages?ns=${NS}&path=${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' },
    data: `<title>Drag ${run}</title><body style="margin:0"><p id="b" style="height:2000px">DRAG-${run}</p></body>`,
  });
  expect(r.status(), await r.text()).toBe(200);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto(`/#${NS}/${path}`);
  await expect(page.frameLocator('[data-testid=page-frame]').locator('#b')).toHaveText(`DRAG-${run}`, { timeout: 15_000 });
  await page.locator('[data-testid=toolbar-stickies]').click();
  const panel = page.locator('[data-testid=side-panel]');
  await expect(panel).toBeVisible();
  await page.waitForTimeout(300); // let the open settle
  const width = async () => Math.round((await panel.boundingBox()).width);
  const w0 = await width();
  const h = await panel.locator('.stickies-resize-handle').boundingBox();
  const x = h.x + h.width / 2, y = h.y + 300;
  // Left (wider), across the page frame, then right (narrower).
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y, { steps: 15 });
  await page.mouse.up();
  expect(Math.abs((await width()) - (w0 + 150)), 'dragging left over the page widens the panel').toBeLessThanOrEqual(3);
  // Released over the page: the drag is over, moving on does not resize.
  await page.mouse.move(x - 300, y, { steps: 10 });
  await page.waitForTimeout(100);
  expect(Math.abs((await width()) - (w0 + 150)), 'the panel stops following the mouse after release').toBeLessThanOrEqual(3);
  const h2 = await panel.locator('.stickies-resize-handle').boundingBox();
  const x2 = h2.x + h2.width / 2;
  await page.mouse.move(x2, y);
  await page.mouse.down();
  await page.mouse.move(x2 + 100, y, { steps: 10 });
  await page.mouse.up();
  expect(Math.abs((await width()) - (w0 + 50)), 'dragging right narrows it').toBeLessThanOrEqual(3);
  // After the drag the page is clickable again (the guard is lifted).
  expect(await page.locator('[data-testid=page-frame]').evaluate((f) => getComputedStyle(f).pointerEvents)).not.toBe('none');
});

test('the Pages tab in the side panel: open two pages in a row, reveal one, panel stays open', async ({ page, request }) => {
  test.skip(MODE !== 'static', 'the same in both modes');
  const auth = { Authorization: `Bearer ${token}` };
  const put = async (path, html) => {
    const r = await request.put(`/api/pages?ns=${NS}&path=${encodeURIComponent(path)}`, { headers: { ...auth, 'Content-Type': 'text/html' }, data: html });
    expect(r.status(), await r.text()).toBe(200);
  };
  await put(`${DIR}/panel/first.page.md`, `<title>First ${run}</title><p id="b">FIRST-${run}</p>`);
  await put(`${DIR}/panel/nested/second.page.md`, `<title>Second ${run}</title><p id="b">SECOND-${run}</p>`);
  await login(page);
  const panel = page.locator('[data-testid=side-panel]');
  await page.locator('[data-testid=toolbar-pages]').click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('side-panel-title')).toHaveText('Pages');
  await expect(panel.locator('[role=tab]')).toHaveCount(0); // the toolbar switches the panel, not tabs in it
  // Same width as Stickies: switching views never makes the panel jump.
  const pagesWidth = Math.round((await panel.boundingBox()).width);
  await page.locator('[data-testid=toolbar-stickies]').click();
  await expect(page.getByTestId('side-panel-title')).toHaveText('Stickies');
  expect(Math.round((await panel.boundingBox()).width)).toBe(pagesWidth);
  await page.locator('[data-testid=toolbar-pages]').click();
  await expect(page.getByTestId('side-panel-title')).toHaveText('Pages');
  await expect(page.locator('[data-testid=toolbar-pages]')).toHaveAttribute('aria-pressed', 'true');
  const rowOf = (p) => panel.locator(`[data-testid="pages-panel-row-${p}"]`);
  const first = rowOf(`${DIR}/panel/first.page.md`);
  const second = rowOf(`${DIR}/panel/nested/second.page.md`);
  await expect(second.locator('.pages-panel-folder')).toHaveText(`${DIR}/panel/nested/`);

  // Search narrows the list.
  await panel.getByTestId('pages-panel-search').fill(`SECOND-${run}`);
  await expect(first).toHaveCount(0, { timeout: 10_000 });
  await expect(second).toBeVisible();
  await panel.getByTestId('pages-panel-search').fill(run);
  await expect(first).toBeVisible({ timeout: 10_000 });

  // Open one, then the other: the viewer follows, the panel stays, the row is highlighted.
  const frameText = () => page.frameLocator('[data-testid=page-frame]').locator('#b');
  await first.locator('.pages-panel-open').click();
  await expect(frameText()).toHaveText(`FIRST-${run}`, { timeout: 15_000 });
  await expect(first).toHaveClass(/active/);
  await second.locator('.pages-panel-open').click();
  await expect(frameText()).toHaveText(`SECOND-${run}`, { timeout: 15_000 });
  await expect(second).toHaveClass(/active/);
  await expect(first).not.toHaveClass(/active/);
  await expect(panel).toBeVisible();

  // Reveal the first in the tree without opening it.
  await first.locator('.pages-panel-locate').click();
  const treeRow = page.locator(`.tree-row[data-path="${DIR}/panel/first.page.md"]`);
  await expect(treeRow).toBeVisible({ timeout: 10_000 });
  await expect(treeRow).toHaveClass(/reveal-flash/);
  await expect(frameText()).toHaveText(`SECOND-${run}`);

  // The full view (the panel's ⤢) does not close the panel, and a row clicked
  // while it shows opens the page, like Open on a card.
  await panel.getByTestId('side-panel-expand').click();
  await expect(page.locator('[data-testid=pages-view]')).toBeVisible();
  await expect(panel).toBeVisible();
  await first.locator('.pages-panel-open').click();
  await expect(page.locator('[data-testid=pages-view]')).toHaveCount(0);
  await expect(frameText()).toHaveText(`FIRST-${run}`, { timeout: 15_000 });
  await expect(panel).toBeVisible();
  // "Open full view" in the panel goes to the toolbar's view.
  await panel.getByTestId('pages-panel-full').click();
  await expect(page.locator('[data-testid=pages-view]')).toBeVisible();
});

// The Chats | Pages | Stickies group at phone, tablet and small-laptop sizes,
// in both themes: all three visible in that order, nothing colliding or
// scrolling sideways, Pages opening the right surface (the full view where
// the panel cannot fit, the side panel's tab where it can), and a way back.
for (const scheme of ['dark', 'light']) {
  for (const [w, h] of [[375, 812], [768, 1024], [1024, 768]]) {
    test(`toolbar group at ${w}x${h}, ${scheme}: order, no overlap, Pages opens and closes`, async ({ page }) => {
      test.skip(MODE !== 'static', 'the same in both modes');
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: w, height: h });
      await login(page);
      await page.goto(`/#${NS}/${OTHER}`);
      const ids = await page.locator('.toolbar-panel-group .toolbar-panel-btn').evaluateAll((bs) => bs.map((b) => b.dataset.testid));
      expect(ids.filter((i) => i !== 'toolbar-chats')).toEqual(['toolbar-pages', 'toolbar-stickies']);
      if (ids.includes('toolbar-chats')) expect(ids[0]).toBe('toolbar-chats');
      const collisions = await page.evaluate(() => {
        const els = [...document.querySelectorAll('.toolbar button, .toolbar .toolbar-path-base')].filter((e) => e.getBoundingClientRect().width);
        const hit = [];
        for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
          const x = els[i], y = els[j];
          if (x.contains(y) || y.contains(x)) continue;
          const a = x.getBoundingClientRect(), b = y.getBoundingClientRect();
          if (a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1) hit.push(`${x.className} ∩ ${y.className}`);
        }
        return hit;
      });
      expect(collisions).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      for (const b of await page.locator('.toolbar-panel-btn').all()) await expect(b).toBeVisible();
      await expect(page.locator('.toolbar-more-btn')).toBeVisible();

      const pages = page.getByTestId('toolbar-pages');
      await pages.click();
      await expect(pages).toHaveAttribute('aria-pressed', 'true');
      if (w <= 768) {
        // A phone or tablet has no side panel: the full Pages view, with a way back.
        await expect(page.getByTestId('pages-view')).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId('side-panel')).toHaveCount(0);
        await page.getByTestId('pages-view-back').click();
      } else {
        await expect(page.getByTestId('pages-panel')).toBeVisible({ timeout: 10_000 });
        await pages.click();
      }
      await expect(page.getByTestId('pages-view')).toHaveCount(0);
      await expect(page.getByTestId('pages-panel')).toHaveCount(0);
      await expect(pages).toHaveAttribute('aria-pressed', 'false');
    });
  }
}
