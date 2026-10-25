// Typing, switching to another note and coming back must leave the text ON
// DISK, not only in the editor or the server's shared-editing room.
//
// Reported after 4.8.10: a note edited three times was back to its old text
// later, with no history entry (so it never reached the file). Switching away
// and back showed the old text (12345) for a moment and then the new one
// (123456789): the file still held the old text while the room in the
// server's memory held the new. A room the last person left with unsaved
// updates is kept in memory only, so a backend restart (an upgrade) loses it.
//
// Every case types, switches note, comes back, and then checks the bytes on
// disk, again after every tab is closed, and (in multi mode) that the
// backend never kept a room with unsaved updates. Runs in both harnesses:
// tests/e2e-collab-multi.sh (shared editing on) and tests/e2e-browser.sh
// (single mode, no rooms). Cases that need a room skip without one.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NOTES_DIR = process.env.MDNEST_NOTES_DIR || '';
const BACKEND = process.env.MDNEST_BACKEND_CONTAINER || '';
const NS = 'testing_workspace';
const WS = /\/api\/ws/;
const EDITOR = '.editor-wrapper .ProseMirror';

async function login(page) {
  if (process.env.MDNEST_E2E_DEBUG) {
    page.on('console', (m) => { if (/mdnest|shared|collab/i.test(m.text())) console.log(`[page] ${m.text()}`); });
  }
  await page.addInitScript(() => { try { localStorage.setItem('mdnest_editor_mode', 'live'); } catch { /* ignore */ } });
  await page.goto('/');
  // Wait for either the login form or a session already signed in (the
  // cleanup page shares the context). isVisible() does not wait: called
  // before the form had rendered it said "signed in", and the sign-in
  // never happened.
  await expect(page.locator('input[name=username], .ns-label, .ns-select').first()).toBeVisible({ timeout: 20_000 });
  if (await page.locator('input[name=username]').isVisible()) {
    await page.fill('input[name=username]', USER);
    await page.fill('input[name=password]', PASS);
    await page.click('button:has-text("Sign in")');
  }
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  return page.evaluate(async () => (await fetch('/api/config')).json());
}

async function api(page, method, file, body) {
  return page.evaluate(async ([m, u, b]) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b, cache: 'no-store' });
    return { status: r.status, text: await r.text() };
  }, [method, `/api/note?ns=${NS}&path=${encodeURIComponent(file)}`, body]);
}

// The file itself when the harness shares the notes dir, else the API.
async function onDisk(page, file) {
  if (NOTES_DIR) {
    try { return fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8'); } catch { return ''; }
  }
  return (await api(page, 'GET', file)).text;
}

function unsavedWarnings(file) {
  if (!BACKEND) return [];
  let out = '';
  try { out = execFileSync('docker', ['logs', BACKEND], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  return out.split('\n').filter((l) => l.includes('unsaved updates') && l.includes(file));
}

async function open(page, file, marker) {
  await page.evaluate((h) => { window.location.hash = h; }, `#${NS}/${file}`);
  await expect(page.locator(EDITOR)).toContainText(marker, { timeout: 15_000 });
  await expect(page.locator(EDITOR)).toHaveAttribute('contenteditable', 'true', { timeout: 15_000 });
}

// Waits until the tab is in the note's room. Builds before LIVE-1 have no
// data-shared marker: there the editor waited for the room before it became
// editable, so a short settle is enough.
async function waitInRoom(page) {
  if (await page.locator('.editor-wrapper[data-shared]').count()) {
    await expect(page.locator('.editor-wrapper[data-shared=bound]')).toBeVisible({ timeout: 15_000 });
  } else {
    await page.waitForTimeout(3000);
  }
}

// Appends to the paragraph holding `text`, like the reporter's 12345 -> 123456789.
async function typeAfter(page, text, words) {
  await page.locator(`${EDITOR} p`, { hasText: text }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(words, { delay: 20 });
}

// Every distinct text the editor shows for `ms`, sampled each animation frame:
// "old, then new" on return is the reporter's symptom.
async function watchEditor(page, ms) {
  return page.evaluate(async ([sel, limit]) => {
    const seen = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const el = document.querySelector(sel);
        const t = el ? (el.textContent || '') : '';
        if (seen[seen.length - 1] !== t) seen.push(t);
        if (performance.now() - t0 > limit) resolve(); else requestAnimationFrame(tick);
      };
      tick();
    });
    return seen;
  }, [EDITOR, ms]);
}

// A websocket that can be cut on demand (see live-never-blocks.spec.js).
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

const CASES = [
  // One tab, switching away inside the autosave debounce, just after it, and
  // well after it.
  { name: 'one tab, switch at once', delay: 0 },
  { name: 'one tab, switch after 400 ms', delay: 400 },
  { name: 'one tab, switch after 2 s', delay: 2000 },
  // A second tab of the same person opened the note first, so it holds the
  // saver role, and sits idle (visible), or is frozen (a background tab the
  // browser suspended, a laptop lid closed on another window).
  { name: 'second tab idle on the note', delay: 400, second: 'idle', shared: true },
  { name: 'second tab frozen on the note', delay: 400, second: 'frozen', shared: true },
  // The connection drops right after typing and is back before the return.
  { name: 'socket drops after typing', delay: 400, cut: true, shared: true },
];

for (const c of CASES) {
  test(`content stays on disk: ${c.name}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const sock = c.cut ? await cuttableSocket(page) : null;
    const cfg = await login(page);
    const shared = !!(cfg.liveCollab && cfg.sharedEditing);
    test.skip(c.shared && !shared, 'needs shared editing (tests/e2e-collab-multi.sh)');
    const stamp = Date.now();
    const file = `loss-${stamp}.md`;
    const other = `loss-other-${stamp}.md`;
    expect((await api(page, 'POST', file, '# Loss\n\n12345\n')).status).toBe(201);
    expect((await api(page, 'POST', other, '# Other\n\nsomething else\n')).status).toBe(201);
    let second = null;
    try {
      if (c.second) {
        second = await ctx.newPage();
        await second.goto(`/#${NS}/${file}`);
        await expect(second.locator(EDITOR)).toContainText('12345', { timeout: 20_000 });
        await waitInRoom(second);
        if (c.second === 'frozen') {
          const cdp = await ctx.newCDPSession(second);
          await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        }
      }
      await open(page, file, '12345');
      if (shared) await waitInRoom(page);
      await typeAfter(page, '12345', '6789');
      if (sock) { await page.waitForTimeout(150); sock.cut(); }
      await page.waitForTimeout(c.delay);
      await open(page, other, 'something else');
      await page.waitForTimeout(1500);
      if (sock) { sock.restore(); await page.waitForTimeout(2500); }
      await page.evaluate((h) => { window.location.hash = h; }, `#${NS}/${file}`);
      const shown = await watchEditor(page, 3000);
      const flash = shown.some((t) => t.includes('12345') && !t.includes('123456789'));
      const diskAtReturn = await onDisk(page, file);
      console.log(`RESULT ${c.name}: disk at return ${JSON.stringify(diskAtReturn)}; old text flashed on return: ${flash}`);
      await expect(page.locator(EDITOR)).toContainText('123456789', { timeout: 10_000 });
      await expect.poll(() => onDisk(page, file), { timeout: 15_000, message: 'the typed text never reached the file' }).toContain('123456789');
      // Everyone gone: the file is all there is.
      await page.goto('about:blank');
      if (second) await second.close().catch(() => {});
      second = null;
      await new Promise((r) => setTimeout(r, 2000));
      const after = fs.existsSync(NOTES_DIR) ? fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8') : null;
      if (after !== null) expect(after, 'the file after every tab closed').toContain('123456789');
      expect(unsavedWarnings(file), 'the backend kept a room with unsaved updates').toEqual([]);
    } finally {
      if (second) await second.close().catch(() => {});
      const p = await ctx.newPage();
      await login(p);
      await api(p, 'DELETE', file);
      await api(p, 'DELETE', other);
      await ctx.close();
    }
  });
}

// The file changed on disk behind the app's back, the way git-sync does it:
// before merging the remote it stashes uncommitted edits (the old committed
// text is on disk until the stash is popped), and when the pop conflicts it
// resets to the remote's version. None of this sends a file-changed event.
function diskWrite(file, text) {
  execFileSync('docker', ['exec', '-i', BACKEND, 'sh', '-c', `cat > '/notes/${NS}/${file}'`], { input: text });
}

for (const how of ['stash window', 'reset to old']) {
  test(`file changed under the app (${how}): what the editor and the file end up with`, async ({ browser }) => {
    test.setTimeout(150_000);
    test.skip(!BACKEND || !NOTES_DIR, 'needs the backend container and notes dir (tests/e2e-collab-multi.sh)');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cfg = await login(page);
    const shared = !!(cfg.liveCollab && cfg.sharedEditing);
    const stamp = Date.now();
    const file = `loss-disk-${stamp}.md`;
    const other = `loss-disk-other-${stamp}.md`;
    expect((await api(page, 'POST', file, '# Loss\n\n12345\n')).status).toBe(201);
    expect((await api(page, 'POST', other, '# Other\n\nsomething else\n')).status).toBe(201);
    try {
      await open(page, file, '12345');
      if (shared) await waitInRoom(page);
      await typeAfter(page, '12345', '6789');
      await expect.poll(() => onDisk(page, file), { timeout: 15_000 }).toContain('123456789');
      const saved = await onDisk(page, file);
      const old = saved.replace('123456789', '12345');
      diskWrite(file, old);
      if (how === 'stash window') {
        await page.waitForTimeout(3000);
        diskWrite(file, saved);
      }
      // Past the saver's and the app's file checks.
      await page.waitForTimeout(25_000);
      await open(page, other, 'something else');
      await page.waitForTimeout(1500);
      await page.evaluate((h) => { window.location.hash = h; }, `#${NS}/${file}`);
      const shown = await watchEditor(page, 3000);
      await page.waitForTimeout(3000);
      const disk = await onDisk(page, file);
      const editor = await page.locator(EDITOR).textContent();
      console.log(`RESULT disk/${how}: shown on return ${JSON.stringify(shown.map((t) => t.replace(/\s+/g, ' ').slice(0, 40)))}; disk ${JSON.stringify(disk.split('\n')[2])}; editor ${JSON.stringify(editor.replace(/\s+/g, ' ').slice(0, 40))}; unsaved-room warnings ${unsavedWarnings(file).length}`);
      if (how === 'stash window') {
        expect(disk, 'the app wrote the stashed-away text back over the restored file').toContain('123456789');
        expect(editor).toContain('123456789');
      } else {
        // The file is the truth: the editor must show what is on disk, not a
        // room's copy the file no longer has.
        expect(editor.includes('123456789'), 'editor and file disagree').toBe(disk.includes('123456789'));
      }
    } finally {
      await api(page, 'DELETE', file);
      await api(page, 'DELETE', other);
      await ctx.close();
    }
  });
}

// A socket the tab has lost but the server still holds: a proxy or tunnel
// that dropped the browser's side and keeps its own connection to the
// backend open (and answering pings). The tab reconnects on a new socket;
// the server still counts the old one as present, and as the room's saver.
async function ghostableSocket(page) {
  const state = { ghost: false, open: new Set() };
  await page.routeWebSocket(WS, (ws) => {
    const server = ws.connectToServer();
    const conn = { ws, server, dead: false };
    state.open.add(conn);
    ws.onClose(() => { if (!conn.dead) server.close(); state.open.delete(conn); });
    server.onClose(() => { if (!conn.dead) ws.close(); state.open.delete(conn); });
    ws.onMessage((m) => { if (!conn.dead) server.send(m); });
    server.onMessage((m) => { if (!conn.dead) ws.send(m); });
  });
  return {
    // Close the browser's side only; the server's side stays open.
    ghost() { for (const c of state.open) { c.dead = true; c.ws.close({ code: 1006 }); } },
  };
}

test('content stays on disk: the socket goes half-open and the tab reconnects', async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const sock = await ghostableSocket(page);
  const cfg = await login(page);
  test.skip(!(cfg.liveCollab && cfg.sharedEditing), 'needs shared editing (tests/e2e-collab-multi.sh)');
  const stamp = Date.now();
  const file = `loss-ghost-${stamp}.md`;
  const other = `loss-ghost-other-${stamp}.md`;
  expect((await api(page, 'POST', file, '# Loss\n\n12345\n')).status).toBe(201);
  expect((await api(page, 'POST', other, '# Other\n\nsomething else\n')).status).toBe(201);
  try {
    await open(page, file, '12345');
    await waitInRoom(page);
    // An edit through the first socket, so it is the saver and recently active.
    await typeAfter(page, '12345', '6');
    await expect.poll(() => onDisk(page, file), { timeout: 15_000 }).toContain('123456');
    await typeAfter(page, '123456', '7');
    sock.ghost();
    // The tab notices, reconnects on a new socket and rejoins the note.
    await page.waitForTimeout(3000);
    await waitInRoom(page);
    await typeAfter(page, '1234567', '89');
    await page.waitForTimeout(1000);
    await open(page, other, 'something else');
    await page.waitForTimeout(1500);
    await page.evaluate((h) => { window.location.hash = h; }, `#${NS}/${file}`);
    const shown = await watchEditor(page, 3000);
    const flash = shown.some((t) => t.includes('12345') && !t.includes('123456789'));
    console.log(`RESULT half-open socket: disk at return ${JSON.stringify((await onDisk(page, file)).split('\n')[2])}; old text flashed on return: ${flash}`);
    // The server hands the saver role on once an update has gone unsaved for
    // 10 s (collab yjsSaverStuck), and this tab then saves. Coming back
    // sooner than that can still show the old file for a moment; what must
    // not happen is the text never reaching it.
    await expect.poll(() => onDisk(page, file), { timeout: 30_000, message: 'the typed text never reached the file' }).toContain('123456789');
    // And it stays there with every tab gone.
    await page.goto('about:blank');
    await new Promise((r) => setTimeout(r, 2000));
    expect(await onDisk(page, file)).toContain('123456789');
  } finally {
    if (page.url().startsWith('about:')) await page.goto('/');
    await api(page, 'DELETE', file);
    await api(page, 'DELETE', other);
    await ctx.close();
  }
});

// The note is open on another device (here another browser context) that
// opened it first, so the server picked it as the room's saver. This tab
// types and leaves at once, and comes back a moment later: the file must
// already hold the text. When only the saver wrote the file, this tab's
// typing reached it only after the other device's save delay, so coming
// back showed the old file and then the room's newer text, every time.
test('note open on another device: leaving and coming back at once shows the new text, from the file', async ({ browser }) => {
  test.setTimeout(120_000);
  const other = await browser.newContext();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cfg = await login(page);
  test.skip(!(cfg.liveCollab && cfg.sharedEditing), 'needs shared editing (tests/e2e-collab-multi.sh)');
  const stamp = Date.now();
  const file = `loss-device-${stamp}.md`;
  const away = `loss-device-away-${stamp}.md`;
  expect((await api(page, 'POST', file, '# Loss\n\n12345\n')).status).toBe(201);
  expect((await api(page, 'POST', away, '# Away\n\nsomething else\n')).status).toBe(201);
  try {
    const device = await other.newPage();
    await login(device);
    await open(device, file, '12345');
    await waitInRoom(device);
    await open(page, file, '12345');
    await waitInRoom(page);
    await typeAfter(page, '12345', '6789');
    await open(page, away, 'something else');
    await page.waitForTimeout(300);
    await page.evaluate((h) => { window.location.hash = h; }, `#${NS}/${file}`);
    const shown = await watchEditor(page, 3000);
    const flash = shown.some((t) => t.includes('12345') && !t.includes('123456789'));
    console.log(`RESULT other device: shown on return ${JSON.stringify(shown.map((t) => t.replace(/\s+/g, ' ').slice(0, 30)))}`);
    expect(flash, 'the old text showed before the new on return').toBe(false);
    expect(await onDisk(page, file)).toContain('123456789');
  } finally {
    await api(page, 'DELETE', file);
    await api(page, 'DELETE', away);
    await other.close();
    await ctx.close();
  }
});
