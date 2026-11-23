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
const PROBE = `probe-${run}`;
const OTHER = `other-${run}`;
const OTHER_SECRET = `OTHER-SECRET-${run}`;

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
  for (const [k, u] of [['other1', '../${OTHER}/index.html'], ['other2', location.origin + '/${OTHER}/index.html'], ['other3', location.pathname + '%2e%2e/${OTHER}/index.html']]) {
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
  const put = async (slug, body, ct) => {
    const r = await request.put(`/api/pages?ns=${NS}&slug=${slug}`, { headers: { ...auth, 'Content-Type': ct }, data: body });
    expect(r.status(), await r.text()).toBe(200);
  };
  await put(PROBE, tar({
    'index.html': probeHtml(mainOrigin),
    'style.css': 'body{background:rgb(1, 2, 3)}',
    'img/dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>',
    'data.json': '{"own":"OWN-DATA"}',
  }), 'application/x-tar');
  await put(OTHER, `<title>Other</title><p>${OTHER_SECRET}</p>`, 'text/html');
});

test.afterAll(async ({ request }) => {
  for (const slug of [PROBE, OTHER]) {
    await request.delete(`/api/pages?ns=${NS}&slug=${slug}`, { headers: { Authorization: `Bearer ${token}` } });
  }
});

async function openProbe(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  // The token this browser holds is the one the probe must never see.
  token = await page.evaluate(() => localStorage.getItem('mdnest_token')) || token;
  await page.evaluate(() => {
    window.__reports = [];
    window.addEventListener('message', (e) => { if (e.data && e.data.probe) window.__reports.push(e.data); });
  });
  await page.locator(`[data-testid=page-row-${PROBE}]`).click();
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
function sign(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

test('an expired pass is rejected, and a pass opens only its own page', async ({ request }) => {
  test.skip(!SECRET, 'needs MDNEST_JWT_SECRET to mint a pass');
  const auth = { Authorization: `Bearer ${token}` };
  const res = await request.post(`/api/pages/pass?ns=${NS}&slug=${PROBE}`, { headers: auth });
  const { url } = await res.json();
  const base = MODE === 'script' ? PAGES_ORIGIN : mainOrigin;
  const prefix = MODE === 'script' ? '/' : '/api/pages/view/';
  const absolute = new URL(url, mainOrigin).href;
  const pass = new URL(absolute).pathname.slice(prefix.length).split('/')[0];
  const claims = JSON.parse(Buffer.from(pass.split('.')[1], 'base64url').toString());

  // Control: the same claims, signed again with a future expiry, open the page.
  const fresh = sign({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 });
  expect((await request.get(`${base}${prefix}${fresh}/`)).status()).toBe(200);
  // Expired.
  const expired = sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 });
  const e = await request.get(`${base}${prefix}${expired}/`);
  expect(e.status()).toBe(403);
  // The pass for one page never serves another, whatever the path says.
  for (const path of [`../${OTHER}/index.html`, `%2e%2e/${OTHER}/index.html`, `..%2f${OTHER}%2findex.html`]) {
    const r = await request.get(`${base}${prefix}${pass}/${path}`, { maxRedirects: 0 });
    expect(await r.text(), path).not.toContain(OTHER_SECRET);
  }
  // A pass is not a login.
  expect((await request.get('/api/pages?ns=' + NS, { headers: { Authorization: `Bearer ${pass}` } })).status()).toBe(401);
});
