// A Live note never waits for the shared-editing connection (LIVE-1).
//
// From v4.8.10 a note opened in Live stayed read-only until the room's shared
// document arrived over the websocket. On a slow, sleeping or blocked
// connection that was every note, and switching notes closed one websocket
// and opened another, so each switch flashed "Reconnecting" and waited again.
// v4.8.13's first fix waited 4 s and then showed a long notice. What is wanted:
//
//   (a) a note is editable at once even when the websocket hangs or is refused
//   (b) switching notes never shows "Reconnecting" or a notice
//   (c) one websocket for the whole visit, not one per note
//   (d) editable quickly after a switch on a healthy connection
//   (e) typing before the room is ready is kept, for both people
//   (f) the connection dropping mid-edit: typing keeps working and saving,
//       and the tab rejoins when the socket is back
//   (g) opening a note and leaving it is not an unsaved edit on the server
//   plus: an older backend (token-only socket refused) still edits, saves
//   and shares through the per-note socket; and a room seeded from A's live
//   document holds exactly A's markdown, for B and on disk.
//
// Live collaboration exists only in multi mode, so this runs from
// tests/e2e-collab-multi.sh. Elsewhere it skips.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const USER2 = process.env.MDNEST_USER2 || '';
const PASS2 = process.env.MDNEST_PASSWORD2 || '';
const NOTES_DIR = process.env.MDNEST_NOTES_DIR || '';
const BACKEND = process.env.MDNEST_BACKEND_CONTAINER || '';
const NS = 'testing_workspace';
// MDNEST_E2E_CPU=4 slows the browser's CPU 4x (a stress run for the
// correctness checks); the time budgets scale with it.
const CPU = Number(process.env.MDNEST_E2E_CPU || 1);
// The budget for (d), editable after a switch on a healthy connection, for
// the median switch. develop measured 31 to 165 ms on the same machine. No
// single switch may take over a second (one GC pause under load is not the
// same as a slow switch, but a second is).
const SWITCH_BUDGET_MS = Number(process.env.MDNEST_SWITCH_BUDGET_MS || 300) * CPU;
const SWITCH_MAX_MS = 1000 * CPU;
const OPEN_BUDGET_MS = 1000 * CPU;

const WS = /\/api\/ws/;
const EDITOR = '.editor-wrapper .ProseMirror';

async function login(page, u, p) {
  if (process.env.MDNEST_E2E_DEBUG) {
    page.on('console', (m) => { if (/mdnest|shared|collab/i.test(m.text())) console.log(`[${u}] ${m.text()}`); });
  }
  // Live is the mode under test; the app reads this on load.
  await page.addInitScript(() => { try { localStorage.setItem('mdnest_editor_mode', 'live'); } catch { /* ignore */ } });
  await page.goto('/');
  if (process.env.MDNEST_E2E_CPU) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.MDNEST_E2E_CPU) });
  }
  await page.fill('input[name=username]', u);
  await page.fill('input[name=password]', p);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
  test.skip(!cfg.liveCollab || !cfg.sharedEditing, 'needs live collaboration and shared editing on (tests/e2e-collab-multi.sh)');
}

async function api(page, method, file, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b, cache: 'no-store' });
    return { status: r.status, text: await r.text() };
  }, [method, `/api/note?ns=${NS}&path=${encodeURIComponent(file)}`, body]);
}

async function makeNote(page, file, text) {
  expect((await api(page, 'POST', file, text)).status).toBe(201);
}

async function readNote(page, file) {
  if (NOTES_DIR) return fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8');
  return (await api(page, 'GET', file)).text;
}

// Navigates to a note through the address bar (a same-page navigation, like
// clicking it in the tree) and returns how many milliseconds passed until the
// Live editor showed that note's text AND accepted typing. Measured inside
// the page, so Playwright's own round trips are not counted.
async function openAndTime(page, file, marker, limitMs = 15_000) {
  return page.evaluate(async ([hash, sel, mark, limit]) => {
    const t0 = performance.now();
    window.location.hash = hash;
    return new Promise((resolve) => {
      const tick = () => {
        const el = document.querySelector(sel);
        const ms = performance.now() - t0;
        if (el && el.getAttribute('contenteditable') === 'true' && (el.textContent || '').includes(mark)) {
          resolve(Math.round(ms));
          return;
        }
        if (ms > limit) { resolve(-1); return; }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }, [`#${NS}/${file}`, EDITOR, marker, limitMs]);
}

// Records anything that looks like the connection status flickering or a
// notice popping up, from now on. Read back with seenTrouble().
async function watchTrouble(page) {
  await page.evaluate(() => {
    window.__mdnestTrouble = [];
    const look = () => {
      for (const el of document.querySelectorAll('.ws-status')) {
        const t = (el.textContent || '').trim();
        if (/Reconnecting|Offline|Not live/i.test(t)) window.__mdnestTrouble.push(`status: ${t}`);
      }
      for (const el of document.querySelectorAll('[data-testid=notice-bar]')) {
        window.__mdnestTrouble.push(`notice: ${(el.textContent || '').trim().slice(0, 80)}`);
      }
      for (const el of document.querySelectorAll('.editor-readonly-bar')) {
        window.__mdnestTrouble.push('read-only bar');
      }
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    look();
  });
}
const seenTrouble = (page) => page.evaluate(() => [...new Set(window.__mdnestTrouble || [])]);

// The editor's text without other people's cursor labels.
const noteText = (page) => page.locator(EDITOR).evaluate((el) => {
  const c = el.cloneNode(true);
  c.querySelectorAll('.ProseMirror-yjs-cursor').forEach((n) => n.remove());
  return c.innerText;
});

async function typeAfter(page, text, words) {
  await page.locator(`${EDITOR} p`, { hasText: text }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(words, { delay: 15 });
  if (process.env.MDNEST_E2E_DEBUG) {
    const st = await page.evaluate(() => {
      const a = document.activeElement;
      const eds = document.querySelectorAll('.editor-wrapper .ProseMirror');
      return { active: a ? `${a.tagName}.${a.className}`.slice(0, 80) : null, editors: eds.length, text: [...eds].map((e) => e.textContent.slice(-40)), ce: [...eds].map((e) => e.getAttribute('contenteditable')) };
    });
    console.log(`[typeAfter ${words}] ${JSON.stringify(st)}`);
  }
}

// A websocket that works, but can be cut and restored on demand: while cut,
// the open socket is closed and every new attempt is closed at once.
async function cuttableSocket(page) {
  const state = { cut: false, open: new Set() };
  await page.routeWebSocket(WS, (ws) => {
    if (state.cut) { ws.close({ code: 1006 }); return; }
    const server = ws.connectToServer();
    state.open.add(ws);
    ws.onClose(() => { state.open.delete(ws); server.close(); });
    server.onClose(() => { state.open.delete(ws); ws.close(); });
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
  });
  return {
    cut() { state.cut = true; for (const ws of state.open) ws.close({ code: 1006 }); state.open.clear(); },
    restore() { state.cut = false; },
  };
}

// A websocket whose server side starts answering only when release() is
// called: a connection that is not there yet, for as long as the spec needs.
async function heldSocket(page) {
  let open;
  const go = new Promise((r) => { open = r; });
  await page.routeWebSocket(WS, (ws) => {
    const queue = [];
    let server = null;
    ws.onMessage((m) => (server ? server.send(m) : queue.push(m)));
    go.then(() => {
      server = ws.connectToServer();
      server.onMessage((m) => ws.send(m));
      server.onClose(() => ws.close());
      ws.onClose(() => server.close());
      for (const m of queue) server.send(m);
    });
  });
  return { release: () => open() };
}

const BROKEN = {
  // The socket opens but nothing ever comes back.
  hangs: (ws) => { ws.onMessage(() => {}); },
  // The socket is closed as soon as it opens.
  refused: (ws) => { ws.close({ code: 1006 }); },
};

for (const [how, handler] of Object.entries(BROKEN)) {
  // @budget: a timing budget, run alone after the shards (tests/lib/e2e-images.sh).
  test(`(a) websocket ${how}: a Live note is editable within 1 s and saves`, { tag: '@budget' }, async ({ page }) => {
    test.setTimeout(90_000);
    await page.routeWebSocket(WS, handler);
    await login(page, USER, PASS);
    const file = `lnb-a-${how}-${Date.now()}.md`;
    await makeNote(page, file, '# Broken socket\n\nhello there\n');
    await watchTrouble(page);
    try {
      const ms = await openAndTime(page, file, 'hello there');
      console.log(`RESULT (a) ${how}: editable after ${ms} ms`);
      expect(ms, 'never became editable').toBeGreaterThanOrEqual(0);
      expect(ms, 'took longer than 1 s to become editable').toBeLessThanOrEqual(OPEN_BUDGET_MS);
      await typeAfter(page, 'hello there', ' typed now');
      await expect.poll(() => readNote(page, file), { timeout: 15_000 }).toContain('hello there typed now');
      // "Not live" is right here; a notice or a read-only bar is not.
      expect((await seenTrouble(page)).filter((t) => !t.startsWith('status:')), 'no notice and no read-only bar').toEqual([]);
    } finally {
      await api(page, 'DELETE', file);
    }
  });
}

test('(b)+(c)+(d) switching notes: one websocket, no flicker, editable fast', async ({ page }) => {
  test.setTimeout(120_000);
  const sockets = [];
  page.on('websocket', (ws) => { if (WS.test(ws.url())) sockets.push(ws.url()); });
  await login(page, USER, PASS);
  const stamp = Date.now();
  const files = [0, 1, 2, 3].map((i) => `lnb-switch-${stamp}-${i}.md`);
  for (const [i, f] of files.entries()) await makeNote(page, f, `# Switch ${i}\n\nnote number ${i} body\n`);
  try {
    // First open loads the editor; it is not what (d) measures.
    expect(await openAndTime(page, files[0], 'note number 0')).toBeGreaterThanOrEqual(0);
    await expect(page.locator('.ws-status')).toContainText('Live', { timeout: 10_000 });
    await page.waitForTimeout(1500);
    const before = sockets.length;
    await watchTrouble(page);
    const times = [];
    for (const i of [1, 2, 3, 1, 0, 2]) {
      const ms = await openAndTime(page, files[i], `note number ${i}`);
      times.push(ms);
      await page.waitForTimeout(700);
    }
    console.log(`RESULT (d) switch-to-editable ms: ${times.join(', ')} (budget ${SWITCH_BUDGET_MS})`);
    console.log(`RESULT (c) websockets opened: ${sockets.length} (before switching: ${before})`);
    expect(await seenTrouble(page), '(b) status flicker or notice during a switch').toEqual([]);
    expect(sockets.length, '(c) one websocket for the visit').toBe(1);
    for (const ms of times) {
      expect(ms, '(d) never became editable').toBeGreaterThanOrEqual(0);
      expect(ms, `(d) no switch over ${SWITCH_MAX_MS} ms`).toBeLessThanOrEqual(SWITCH_MAX_MS);
    }
    const median = [...times].sort((x, y) => x - y)[Math.floor(times.length / 2)];
    expect(median, `(d) the median switch is editable within ${SWITCH_BUDGET_MS} ms`).toBeLessThanOrEqual(SWITCH_BUDGET_MS);
  } finally {
    for (const f of files) await api(page, 'DELETE', f);
  }
});

test('(e) one person types while the other opens on a slow connection: nothing lost', async ({ browser }) => {
  test.setTimeout(150_000);
  if (!USER2) test.skip(true, 'needs MDNEST_USER2 (tests/e2e-collab-multi.sh)');
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await login(pageA, USER, PASS);
  const bSocket = await heldSocket(pageB);
  await login(pageB, USER2, PASS2);
  const file = `lnb-e-${Date.now()}.md`;
  const warm = `lnb-e-warm-${Date.now()}.md`;
  await makeNote(pageA, file, '# Together\n\nalice line\n\nbob line\n');
  await makeNote(pageB, warm, '# Warm\n\nwarm line\n');
  let aliceTyping = Promise.resolve();
  try {
    // B's editor code is loaded on another note first: the open measured
    // below is about the connection, not a cold page.
    expect(await openAndTime(pageB, warm, 'warm line')).toBeGreaterThanOrEqual(0);
    expect(await openAndTime(pageA, file, 'alice line')).toBeGreaterThanOrEqual(0);
    await pageA.waitForTimeout(1500); // A seeds the room and saves for it
    await typeAfter(pageA, 'alice line', '');
    const aliceWords = ['amber1', 'amber2', 'amber3', 'amber4', 'amber5', 'amber6'];
    aliceTyping = (async () => {
      for (const w of aliceWords) {
        await pageA.keyboard.type(` ${w}`, { delay: 30 });
        await pageA.waitForTimeout(400);
      }
    })();
    // B opens while A types, and types straight away, while B's socket is
    // still not answering; it does once B has typed.
    const ms = await openAndTime(pageB, file, 'bob line', 5000);
    console.log(`RESULT (e) B editable after ${ms} ms on a slow socket`);
    expect(ms, 'B could not type before the room was ready').toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(OPEN_BUDGET_MS);
    await typeAfter(pageB, 'bob line', ' basil1 basil2');
    bSocket.release();
    await aliceTyping;

    const all = [...aliceWords, 'basil1', 'basil2'];
    await expect.poll(async () => {
      const disk = await readNote(pageA, file);
      return all.filter((w) => !disk.includes(w));
    }, { timeout: 25_000, message: 'words missing on disk' }).toEqual([]);
    for (const p of [pageA, pageB]) {
      await expect.poll(async () => {
        const t = await p.locator(EDITOR).innerText();
        return all.filter((w) => !t.includes(w));
      }, { timeout: 15_000, message: 'words missing from an editor' }).toEqual([]);
    }
    // Both end up in the room (B joins once the room has what B typed), and
    // then A's typing reaches B's screen live, well before any save-and-poll
    // could carry it.
    await expect(pageB.locator('.editor-wrapper[data-shared=bound]')).toHaveCount(1, { timeout: 15_000 });
    await expect(pageA.locator('.editor-wrapper[data-shared=bound]')).toHaveCount(1);
    await typeAfter(pageA, 'basil2', ' livecheck');
    await expect(pageB.locator(EDITOR)).toContainText('livecheck', { timeout: 2000 });
    const disk = await readNote(pageA, file);
    expect(disk.split('amber1').length - 1, 'a word was duplicated').toBe(1);
    expect(disk.split('basil1').length - 1, 'a word was duplicated').toBe(1);
  } finally {
    bSocket.release();
    // A failure above must not be hidden by A still typing into a page
    // that is being closed.
    await aliceTyping.catch(() => {});
    await api(pageA, 'DELETE', file);
    await api(pageA, 'DELETE', warm);
    await a.close(); await b.close();
  }
});

test('(f) the connection drops mid-edit: typing keeps saving, and it rejoins', async ({ browser }) => {
  test.setTimeout(150_000);
  if (!USER2) test.skip(true, 'needs MDNEST_USER2 (tests/e2e-collab-multi.sh)');
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const sock = await cuttableSocket(pageA);
  await login(pageA, USER, PASS);
  await login(pageB, USER2, PASS2);
  const file = `lnb-f-${Date.now()}.md`;
  await makeNote(pageB, file, '# Drop\n\nfirst line\n\nsecond line\n');
  try {
    // B opens first, so B is the room's saver; A is only a member.
    expect(await openAndTime(pageB, file, 'first line')).toBeGreaterThanOrEqual(0);
    await pageB.waitForTimeout(1500);
    expect(await openAndTime(pageA, file, 'first line')).toBeGreaterThanOrEqual(0);
    await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 20_000 });
    await typeAfter(pageA, 'first line', ' online1');
    await expect(pageB.locator(EDITOR)).toContainText('online1', { timeout: 5000 });

    // The caret is in the editor when the socket goes; typing carries on
    // without a click (the editor unbinding must not take the keyboard away).
    await typeAfter(pageA, 'second line', '');
    sock.cut();
    await pageA.waitForTimeout(300);
    await pageA.keyboard.type(' offline1 offline2', { delay: 15 });
    await expect(pageA.locator(EDITOR)).toContainText('offline2');
    await expect.poll(() => readNote(pageA, file), { timeout: 15_000, message: 'typing while the socket is down was not saved' })
      .toContain('offline1 offline2');

    sock.restore();
    // Typing straight through the rejoin, without a click: joining the room
    // again must not take the keyboard away either.
    // Until 2.5 s after the dot says Live again.
    let liveAt = 0;
    let last = -1;
    for (let i = 0; i < 120; i += 1) {
      await pageA.keyboard.type(` thru${i}`, { delay: 15 });
      last = i;
      await pageA.waitForTimeout(300);
      if (!liveAt && /^Live/.test((await pageA.locator('.ws-status').textContent()) || '')) liveAt = Date.now();
      if (liveAt && Date.now() - liveAt > 2500) break;
    }
    expect(liveAt, 'never reconnected').toBeGreaterThan(0);
    await expect(pageB.locator(EDITOR)).toContainText('offline2', { timeout: 15_000 });
    await expect(pageB.locator(EDITOR)).toContainText(`thru${last}`, { timeout: 15_000 });
    await expect(pageA.locator('.editor-wrapper[data-shared=bound]')).toHaveCount(1, { timeout: 15_000 });
    await typeAfter(pageA, `thru${last}`, ' rejoined');
    await expect(pageB.locator(EDITOR)).toContainText('rejoined', { timeout: 2000 });
    await expect.poll(() => readNote(pageA, file), { timeout: 15_000 }).toContain('rejoined');
    const disk = await readNote(pageA, file);
    for (const w of ['online1', 'offline1', 'offline2', 'rejoined']) {
      expect(disk.split(w).length - 1, `${w} once on disk`).toBe(1);
    }
    for (let i = 0; i <= last; i += 1) {
      expect(disk.split(` thru${i} `).length + disk.split(` thru${i}\n`).length - 2, `thru${i} once on disk`).toBe(1);
    }
  } finally {
    await api(pageB, 'DELETE', file);
    await a.close(); await b.close();
  }
});

test('(g) opening a note and leaving it leaves no unsaved updates on the server', async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!BACKEND, 'needs MDNEST_BACKEND_CONTAINER to read the backend log (tests/e2e-collab-multi.sh)');
  await login(page, USER, PASS);
  const stamp = Date.now();
  const files = [0, 1, 2].map((i) => `lnb-g-${stamp}-${i}.md`);
  // Front matter, headings, a list, a task list, a table, code, a diagram, an
  // image and a wikilink: blocks the editor adds attributes to, renders
  // late, or writes back differently. None of that is an edit.
  const body = (i) => `---\ntitle: Leave ${i}\n---\n\n# Leave ${i}\n\n## Part\n\n* one\n* two\n\n- [ ] task\n- [x] done\n\n`
    + '| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n'
    + `![pic](missing.png)\n\nsee [[Other note]]\n\nopen and leave ${i}\n`;
  for (const [i, f] of files.entries()) await makeNote(page, f, body(i));
  const created = [];
  for (const f of files) created.push(await readNote(page, f));
  // The note the warning was seen on (v4.8.10, the test server): a heading,
  // a line of prose and tagged task lines.
  const fixture = `lnb-g-${stamp}-module.md`;
  const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'module-092.md'), 'utf8');
  await makeNote(page, fixture, fixtureText);
  const fixtureOnDisk = await readNote(page, fixture);
  files.unshift(fixture);
  try {
    // The fixture for a while, then a long stay, a short one, and leaving
    // the moment the note is editable.
    const marks = ['Some prose about this module', 'open and leave 0', 'open and leave 1', 'open and leave 2'];
    for (const [i, f] of files.entries()) {
      expect(await openAndTime(page, f, marks[i])).toBeGreaterThanOrEqual(0);
      await page.waitForTimeout([6000, 2500, 400, 0][i]);
    }
    await page.evaluate(() => { window.location.hash = '#'; });
    await page.waitForTimeout(2500);
    // The backend logs to stderr.
    const logs = execFileSync('sh', ['-c', 'docker logs "$0" 2>&1', BACKEND], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const bad = logs.split('\n').filter((l) => l.includes(`lnb-g-${stamp}`) && /unsaved updates/.test(l));
    expect(bad, 'the server kept a room with unsaved updates after open-and-leave').toEqual([]);
    // The server adds the note's id marker when the app first looks the note
    // up (comments are keyed by it); that is not the editor writing.
    const unmarked = (t) => t.replace(/\n*<!-- mdnest:[0-9a-f-]+ -->\n*/g, '\n').trimEnd();
    expect(unmarked(await readNote(page, fixture)), 'opening the note rewrote it').toBe(unmarked(fixtureOnDisk));
    for (const [i, f] of files.slice(1).entries()) {
      expect(unmarked(await readNote(page, f)), 'opening the note rewrote it').toBe(unmarked(created[i]));
    }
  } finally {
    for (const f of files) await api(page, 'DELETE', f);
  }
});

test('an older backend that refuses the token-only socket: the per-note socket still works', async ({ browser }) => {
  test.setTimeout(150_000);
  if (!USER2) test.skip(true, 'needs MDNEST_USER2 (tests/e2e-collab-multi.sh)');
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  // What a backend before v4.8.13 does with /api/ws?token= alone: refuse it.
  const oldServer = (ws) => {
    if (!/[?&]ns=/.test(ws.url())) { ws.close({ code: 1008 }); return; }
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    ws.onClose(() => server.close());
    server.onClose(() => ws.close());
  };
  await pageA.routeWebSocket(WS, oldServer);
  await pageB.routeWebSocket(WS, oldServer);
  await login(pageA, USER, PASS);
  await login(pageB, USER2, PASS2);
  const stamp = Date.now();
  const file = `lnb-old-${stamp}.md`;
  const other = `lnb-old-${stamp}-2.md`;
  await makeNote(pageA, file, '# Old server\n\nfirst line\n');
  await makeNote(pageA, other, '# Other\n\nother line\n');
  try {
    // Editable (the time budget is (a)'s; this one is the first open of the
    // page, editor chunks included, and only has to work).
    expect(await openAndTime(pageA, file, 'first line')).toBeGreaterThanOrEqual(0);
    await expect(pageA.locator('.ws-status')).toContainText('Live', { timeout: 15_000 });
    expect(await openAndTime(pageB, file, 'first line')).toBeGreaterThanOrEqual(0);
    await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 20_000 });
    await typeAfter(pageA, 'first line', ' oldsrv');
    await expect(pageB.locator(EDITOR)).toContainText('oldsrv', { timeout: 10_000 });
    await expect.poll(() => readNote(pageA, file), { timeout: 15_000 }).toContain('first line oldsrv');
    // A switch on the per-note socket.
    expect(await openAndTime(pageA, other, 'other line')).toBeGreaterThanOrEqual(0);
    await typeAfter(pageA, 'other line', ' switched');
    await expect.poll(() => readNote(pageA, other), { timeout: 15_000 }).toContain('other line switched');
  } finally {
    await api(pageA, 'DELETE', file);
    await api(pageA, 'DELETE', other);
    await a.close(); await b.close();
  }
});

test('a room seeded from the live editor holds exactly the markdown, for the other person and on disk', async ({ browser }) => {
  test.setTimeout(150_000);
  if (!USER2) test.skip(true, 'needs MDNEST_USER2 (tests/e2e-collab-multi.sh)');
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await login(pageA, USER, PASS);
  await login(pageB, USER2, PASS2);
  const file = `lnb-seed-${Date.now()}.md`;
  await makeNote(pageA, file, '---\ntitle: Seed\ntags: [x]\n---\n\n# Seed heading\n\n## Second heading\n\n- [ ] a task\n\nplain line\n');
  try {
    // A types before and after the room is there; the room is seeded from
    // A's document as it is.
    expect(await openAndTime(pageA, file, 'plain line')).toBeGreaterThanOrEqual(0);
    await typeAfter(pageA, 'plain line', ' added');
    await pageA.waitForTimeout(1500);
    await typeAfter(pageA, 'added', ' more');
    await expect.poll(() => readNote(pageA, file), { timeout: 15_000 }).toContain('plain line added more');
    const saved = await readNote(pageA, file);
    // The front matter exactly as it was, the headings as written, nothing
    // the editor adds (heading ids) in the file.
    expect(saved.startsWith('---\ntitle: Seed\ntags: [x]\n---\n\n# Seed heading\n\n## Second heading\n\n'), saved).toBe(true);
    expect(saved).not.toMatch(/\{#|id=/);
    expect(await openAndTime(pageB, file, 'plain line added more')).toBeGreaterThanOrEqual(0);
    await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 20_000 });
    const textA = await noteText(pageA);
    await expect.poll(() => noteText(pageB), { timeout: 10_000 }).toBe(textA);
    // B being there does not rewrite it.
    await pageB.waitForTimeout(2500);
    expect(await readNote(pageA, file)).toBe(saved);
    expect(textA).not.toContain('title: Seed');
  } finally {
    await api(pageA, 'DELETE', file);
    await a.close(); await b.close();
  }
});

// Everyone's socket drops at once, everyone types while apart, everyone
// comes back. Nobody in the room was saving when they came back, and each
// tab has text of its own, so each joins only once the room holds its text;
// the room must get there by itself, within a bounded time after typing
// stops, with every word once on disk and the same text on both screens.
for (const variant of ['pauses', 'nonstop']) {
  test(`(h) every socket drops and everyone comes back with text of their own (${variant})`, async ({ browser }) => {
    test.setTimeout(240_000);
    if (!USER2) test.skip(true, 'needs MDNEST_USER2 (tests/e2e-collab-multi.sh)');
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    const sockA = await cuttableSocket(pageA);
    const sockB = await cuttableSocket(pageB);
    await login(pageA, USER, PASS);
    await login(pageB, USER2, PASS2);
    const file = `lnb-h-${variant}-${Date.now()}.md`;
    await makeNote(pageB, file, '# All apart\n\nline for alice\n\nline for bob\n');
    const bound = (p) => p.locator('.editor-wrapper[data-shared=bound]');
    const live = async (p) => /^Live/.test((await p.locator('.ws-status').textContent()) || '');
    try {
      expect(await openAndTime(pageB, file, 'line for bob')).toBeGreaterThanOrEqual(0);
      await expect(bound(pageB)).toHaveCount(1, { timeout: 15_000 });
      expect(await openAndTime(pageA, file, 'line for alice')).toBeGreaterThanOrEqual(0);
      await expect(bound(pageA)).toHaveCount(1, { timeout: 15_000 });
      const words = [];
      // Each tab remembers the words it has finished typing, so a sampler
      // in the page can check none of them ever leaves its screen.
      const say = async (p, w) => {
        words.push(w);
        await p.keyboard.type(` ${w}`, { delay: 15 });
        await p.evaluate((x) => { (window.__typed = window.__typed || []).push(x); }, w);
      };
      const sample = (p) => p.evaluate((sel) => {
        window.__gone = [];
        window.__samples = 0;
        window.__sampler = setInterval(() => {
          const el = document.querySelector(sel);
          if (!el) return;
          const c = el.cloneNode(true);
          c.querySelectorAll('.ProseMirror-yjs-cursor').forEach((n) => n.remove());
          const text = c.textContent || '';
          window.__samples += 1;
          for (const w of window.__typed || []) {
            if (!text.includes(w)) {
              if (!window.__gone.length) window.__goneText = text.slice(-160);
              window.__gone.push(`${w} missing (${document.querySelector('.editor-wrapper')?.dataset.shared})`);
            }
          }
        }, 50);
      }, EDITOR);
      const sampled = (p) => p.evaluate(() => { clearInterval(window.__sampler); return { gone: [...new Set(window.__gone)], samples: window.__samples, text: window.__goneText }; });

      // Text in the room that nobody has saved yet when the sockets go, so
      // the server keeps the room (with no saver) for its grace period.
      await typeAfter(pageA, 'line for alice', '');
      await typeAfter(pageB, 'line for bob', '');
      await say(pageA, 'roomA');
      await say(pageB, 'roomB');
      sockA.cut();
      sockB.cut();
      await expect(pageA.locator('.ws-status')).toContainText('Not live', { timeout: 10_000 });
      // Apart: both type, and both save the normal way.
      await say(pageA, 'apartA1');
      await say(pageB, 'apartB1');
      await pageA.waitForTimeout(1500);
      await say(pageA, 'apartA2');
      await say(pageB, 'apartB2');
      await sample(pageA);
      await sample(pageB);
      sockA.restore();
      sockB.restore();

      // Both keep typing while they reconnect.
      let i = 0;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !((await live(pageA)) && (await live(pageB)))) {
        await say(pageA, `backA${i}`);
        await say(pageB, `backB${i}`);
        i += 1;
        await pageA.waitForTimeout(variant === 'nonstop' ? 100 : 900);
      }
      expect((await live(pageA)) && (await live(pageB)), 'never reconnected').toBe(true);
      if (variant === 'nonstop') {
        // A types without a pause for 8 s after reconnecting.
        const until = Date.now() + 8000;
        let k = 0;
        while (Date.now() < until) { await say(pageA, `cont${k}`); k += 1; }
      }
      const stopped = Date.now();

      await expect(bound(pageA), 'A never joined the room').toHaveCount(1, { timeout: 10_000 });
      await expect(bound(pageB), 'B never joined the room').toHaveCount(1, { timeout: Math.max(1000, 10_000 - (Date.now() - stopped)) });
      console.log(`RESULT (h ${variant}) both in the room ${Date.now() - stopped} ms after typing stopped`);
      // Nothing a tab had typed ever left its screen while it joined.
      for (const [who, p] of [['A', pageA], ['B', pageB]]) {
        const { gone, samples, text } = await sampled(p);
        console.log(`RESULT (h ${variant}) ${who}: ${samples} samples, ${gone.length} problems${gone.length ? ` first seen with: ${JSON.stringify(text)}` : ''}`);
        expect(gone, `${who}: own words left the screen while joining`).toEqual([]);
      }
      // Each bad word with its count: 0 is missing, 2 or more is doubled
      // (different bugs). The file goes to the log when anything is off.
      const badWords = async () => {
        const disk = await readNote(pageA, file);
        const bad = words.map((w) => [w, disk.split(new RegExp(`\\b${w}\\b`)).length - 1]).filter(([, n]) => n !== 1);
        return { bad: bad.map(([w, n]) => `${w}=${n}`), disk };
      };
      await expect.poll(async () => (await badWords()).bad, { timeout: 15_000 }).toEqual([]).catch(async (e) => {
        const { bad, disk } = await badWords();
        console.log(`RESULT (h ${variant}) bad words ${bad.join(' ')} disk=${JSON.stringify(disk)}`);
        throw e;
      });
      await expect.poll(() => noteText(pageB), { timeout: 10_000 }).toBe(await noteText(pageA));
      // And they are together again: typing shows live.
      await say(pageA, 'together');
      await expect(pageB.locator(EDITOR)).toContainText('together', { timeout: 2000 });
    } finally {
      await api(pageB, 'DELETE', file);
      await a.close(); await b.close();
    }
  });
}

// The race behind a doubled line, pinned without timing luck. The room's
// saver starts a check of the file (after an outside change); that request
// is held until the saver's socket has been cut and its editor has gone back
// to saving the normal way. When the answer then arrives it must change
// nothing: the editor keeps what the person typed meanwhile, and the file
// ends up with every word once.
test('(i) a file check that outlives the room changes nothing when it returns', async ({ browser }) => {
  test.setTimeout(150_000);
  if (!USER2) test.skip(true, 'needs MDNEST_USER2 (tests/e2e-collab-multi.sh)');
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const sock = await cuttableSocket(pageA);
  await login(pageA, USER, PASS);
  await login(pageB, USER2, PASS2);
  const file = `lnb-i-${Date.now()}.md`;
  await makeNote(pageA, file, '# Held\n\nmy line\n\nother line\n');
  // Hold the next GET of this note from A's page, once armed.
  let armed = false;
  let held = null;
  let release;
  const released = new Promise((r) => { release = r; });
  await pageA.route((u) => u.pathname === '/api/note' && u.searchParams.get('path') === file, async (route) => {
    if (armed && !held && route.request().method() === 'GET') {
      held = route;
      await released;
    }
    await route.continue();
  });
  try {
    expect(await openAndTime(pageA, file, 'my line')).toBeGreaterThanOrEqual(0);
    await expect(pageA.locator('.editor-wrapper[data-shared=bound]')).toHaveCount(1, { timeout: 15_000 });
    await typeAfter(pageA, 'my line', ' roomword');
    await expect.poll(() => readNote(pageA, file), { timeout: 15_000 }).toContain('my line roomword');

    // An outside change: A, the saver, checks the file, and that GET is held.
    armed = true;
    const disk = await readNote(pageA, file);
    expect((await api(pageB, 'PUT', file, disk.replace('other line', 'other line outside'))).status).toBe(200);
    await expect.poll(() => held !== null, { timeout: 15_000, message: 'the saver never checked the file' }).toBe(true);

    // The socket goes; the editor unbinds and A keeps typing, no click.
    sock.cut();
    await expect(pageA.locator('.editor-wrapper[data-shared=apart]')).toHaveCount(1, { timeout: 15_000 });
    await pageA.keyboard.type(' apartword', { delay: 15 });
    await pageA.waitForTimeout(300);

    // Now the old check's answer arrives.
    release();
    await pageA.waitForTimeout(2500);
    const shown = await noteText(pageA);
    for (const w of ['roomword', 'apartword']) expect(shown, `${w} left the screen`).toContain(w);

    await expect.poll(async () => {
      const t = await readNote(pageA, file);
      return ['roomword', 'apartword', 'outside'].map((w) => `${w}=${t.split(w).length - 1}`);
    }, { timeout: 20_000 }).toEqual(['roomword=1', 'apartword=1', 'outside=1']);
  } finally {
    release();
    sock.restore();
    await api(pageA, 'DELETE', file);
    await a.close(); await b.close();
  }
});
