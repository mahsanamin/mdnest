// A note left open must sit still. Reported on 4.8.11-dev: "the screen
// flickers every few seconds while a note is open". This leaves a note open
// for about a minute, alone and with a second person, and fails if anything
// in the editor is replaced or redrawn, or the live connection reconnects
// (the toolbar label then switches between Live and Reconnecting, which
// moves the page). Timers that run in that minute: the approvals poll (5 s,
// the harness turns approvals on), the shared note's file check (20 s), the
// sidebar tree refresh (30 s), the note poll and update check (60 s).
//
// Runs from tests/e2e-collab-multi.sh; skips without live collab.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const USER2 = process.env.MDNEST_USER2 || '';
const PASS2 = process.env.MDNEST_PASSWORD2 || '';
const CLI = process.env.MDNEST_CLI || '';
const CLI_HOMES = process.env.MDNEST_CLI_HOMES || '';
const NOTES_DIR = process.env.MDNEST_NOTES_DIR || '';
const NS = 'testing_workspace';
const IDLE_MS = 62_000;

const RICH = '---\ntitle: Idle\n---\n\n# Idle note\n\n- [ ] a task\n- [x] done task\n\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\nSee [[other note]] and $E=mc^2$.\n\n> a quote\n';

// The server adds a hidden note-ID marker (for comments) the first time a
// note is read. That write is intended and invisible; compare without it.
const noMarker = (t) => t.replace(/<!-- mdnest:[0-9a-f-]+ -->/g, '').replace(/\s+$/, '');
const cli = (...args) => execFileSync(CLI, args, { env: { ...process.env, HOME: path.join(CLI_HOMES, 'alice-home') }, encoding: 'utf8' });

async function login(page, u, p) {
  await page.goto('/');
  await page.fill('input[name=username]', u);
  await page.fill('input[name=password]', p);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  return (await page.evaluate(async () => (await (await fetch('/api/config')).json()).liveCollab === true));
}

// Starts watching: the editor element, every change inside it, and the
// connection label. Remote carets (y-prosemirror) are the one expected
// change when someone else is in the note, so they are left out.
async function watch(page) {
  await page.evaluate(() => {
    const root = document.querySelector('.editor-wrapper .ProseMirror, .editor-wrapper textarea');
    root.dataset.idleOriginal = '1';
    const seen = { inside: [], label: [] };
    window.__idle = seen;
    const isCaret = (n) => n.nodeType === 1 && (n.classList.contains('ProseMirror-yjs-cursor') || n.closest?.('.ProseMirror-yjs-cursor'));
    new MutationObserver((muts) => {
      for (const m of muts) {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (m.type === 'childList' && nodes.length && nodes.every(isCaret)) continue;
        if (m.type === 'attributes' && (m.target.closest?.('.ProseMirror-yjs-cursor') || m.attributeName === 'data-idle-original')) continue;
        if (isCaret(m.target)) continue;
        seen.inside.push(`${m.type} on ${m.target.nodeName}.${m.target.className || ''}`);
      }
    }).observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    const label = document.querySelector('.ws-status');
    if (label) {
      new MutationObserver(() => seen.label.push(label.className)).observe(label, { attributes: true, childList: true, subtree: true, characterData: true });
    }
  });
}

async function verdict(page, who) {
  const { inside, label } = await page.evaluate(() => window.__idle);
  const replaced = await page.evaluate(() => {
    const now = document.querySelector('.editor-wrapper .ProseMirror, .editor-wrapper textarea');
    return !now || now.dataset.idleOriginal !== '1';
  });
  expect(replaced, `${who}: the editor was replaced (remounted) while idle`).toBe(false);
  expect(inside.slice(0, 10), `${who}: the editor's content changed while nobody typed`).toEqual([]);
  expect(label, `${who}: the live connection label changed (reconnect) while idle`).toEqual([]);
}

async function openNote(page, file, mode) {
  await page.goto(`/#${NS}/${file}`);
  await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
  if (mode === 'Basic') await page.locator('.toolbar button', { hasText: /^Basic$/ }).click();
  await expect(page.locator(mode === 'Basic' ? '.editor-wrapper textarea' : '.editor-wrapper .ProseMirror')).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(() => {
  if (!CLI || !CLI_HOMES) test.skip(true, 'needs tests/e2e-collab-multi.sh');
});

for (const mode of ['Live', 'Basic']) {
  test(`a note open alone in ${mode} sits still for a minute`, async ({ browser }) => {
    test.setTimeout(150_000);
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    if (!(await login(page, USER, PASS))) test.skip(true, 'live collab off');
    const file = `idle-${mode}-${Date.now()}.md`;
    cli('create', `@alice/${NS}/${file}`, RICH);
    const before = NOTES_DIR ? noMarker(fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8')) : null;
    await openNote(page, file, mode);
    await page.waitForTimeout(3000); // seeding, first render of mermaid/KaTeX
    await watch(page);
    await page.waitForTimeout(IDLE_MS);
    await verdict(page, 'alone');
    if (before !== null) expect(noMarker(fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8')), 'the file changed while idle').toBe(before);
    await ctx.close();
  });
}

test('a shared note open by two people sits still for a minute', async ({ browser }) => {
  test.setTimeout(180_000);
  if (!USER2) test.skip(true, 'needs a second account');
  const a = await browser.newContext(); const pageA = await a.newPage();
  const b = await browser.newContext(); const pageB = await b.newPage();
  if (!(await login(pageA, USER, PASS))) test.skip(true, 'live collab off');
  await login(pageB, USER2, PASS2);
  const file = `idle-two-${Date.now()}.md`;
  cli('create', `@alice/${NS}/${file}`, RICH);
  await openNote(pageA, file, 'Live');
  await openNote(pageB, file, 'Live');
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });
  await pageA.waitForTimeout(3000);
  await watch(pageA); await watch(pageB);
  await pageA.waitForTimeout(IDLE_MS);
  await verdict(pageA, 'A'); await verdict(pageB, 'B');
  await b.close(); await a.close();
});
