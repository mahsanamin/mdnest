// A change made with the CLI must show in a browser that has the note open,
// without a reload. Reported on 4.8.11-dev: after shared editing, `mdnest
// append` (and prepend) no longer appeared live. The backend never announced
// a PATCH, and a shared note skipped the browser's 60 s fallback poll.
//
// Drives the REAL ./mdnest from the working tree, logged in with an API token
// as alice (the same account as the browser, the usual setup) or bob.
// Runs from tests/e2e-collab-multi.sh, which sets MDNEST_CLI and
// MDNEST_CLI_HOMES; it skips anywhere else.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const USER2 = process.env.MDNEST_USER2 || '';
const PASS2 = process.env.MDNEST_PASSWORD2 || '';
const NOTES_DIR = process.env.MDNEST_NOTES_DIR || '';
const CLI = process.env.MDNEST_CLI || '';
const CLI_HOMES = process.env.MDNEST_CLI_HOMES || '';
const NS = 'testing_workspace';

function cli(account, ...args) {
  return execFileSync(CLI, args, {
    env: { ...process.env, HOME: path.join(CLI_HOMES, `${account}-home`), MDNEST_JSON: '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
// `mdnest edit` is a guarded read-modify-write: if the note is saved between
// its read and its write (here, by the browser's autosave while someone
// types), it gets a 409 and writes nothing. That is the correct outcome, and
// what a person or script does next is run the edit again. So: one retry,
// and only after checking the 409 really said nothing was overwritten.
function cliEdit(account, ...args) {
  try {
    return cli(account, 'edit', ...args);
  } catch (e) {
    const err = String(e.stderr || '');
    expect(err, 'the edit failed for a reason other than a 409').toContain('Error (409)');
    expect(err, 'a 409 must say nothing was overwritten').toContain('Nothing was overwritten');
    return cli(account, 'edit', ...args);
  }
}
const notePath = (account, file) => `@${account}/${NS}/${file}`;
const disk = (file) => fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8');

async function login(page, u, p) {
  await page.goto('/');
  await page.fill('input[name=username]', u);
  await page.fill('input[name=password]', p);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function open(page, file) {
  await page.goto(`/#${NS}/${file}`);
  await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
}

const live = (page) => page.locator('.editor-wrapper .ProseMirror');

// Set once after the note is open; a reload would drop it.
async function markPage(page) {
  await page.evaluate(() => { window.__mdnestNoReload = true; });
}
async function notReloaded(page) {
  expect(await page.evaluate(() => window.__mdnestNoReload === true), 'the page reloaded').toBe(true);
}

test.beforeEach(() => {
  if (!CLI || !CLI_HOMES || !NOTES_DIR) test.skip(true, 'needs tests/e2e-collab-multi.sh (real CLI + notes dir)');
});

test('CLI write, append, prepend and edit show live in a shared note (same account)', async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, USER, PASS);
  const file = `cli-live-${Date.now()}.md`;
  cli('alice', 'create', notePath('alice', file), '# CLI live\n\nstarting line\n');
  await open(page, file);
  await expect(live(page)).toContainText('starting line', { timeout: 20_000 });
  await page.waitForTimeout(1500); // the room is seeded and this tab saves for it
  await markPage(page);

  cli('alice', 'write', notePath('alice', file), '# CLI live\n\nstarting line\n\nwritten by cli\n');
  await expect(live(page), 'mdnest write did not show').toContainText('written by cli', { timeout: 10_000 });

  cli('alice', 'append', notePath('alice', file), 'appended by cli');
  await expect(live(page), 'mdnest append did not show').toContainText('appended by cli', { timeout: 10_000 });

  cli('alice', 'prepend', notePath('alice', file), 'prepended by cli\n');
  await expect(live(page), 'mdnest prepend did not show').toContainText('prepended by cli', { timeout: 10_000 });

  cli('alice', 'edit', notePath('alice', file), 'starting line', 'edited line');
  await expect(live(page), 'mdnest edit did not show').toContainText('edited line', { timeout: 10_000 });
  await expect(live(page)).not.toContainText('starting line');

  await notReloaded(page);
  // The browser must not have written an older copy back over the CLI.
  await page.waitForTimeout(2500);
  const text = disk(file);
  for (const w of ['written by cli', 'appended by cli', 'prepended by cli', 'edited line']) {
    expect(text, `file lost "${w}"`).toContain(w);
  }
  await ctx.close();
});

test('CLI append from another account shows live in a shared note', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, USER, PASS);
  const file = `cli-other-${Date.now()}.md`;
  cli('bob', 'create', notePath('bob', file), '# Other\n\nline\n');
  await open(page, file);
  await expect(live(page)).toContainText('line', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await markPage(page);
  cli('bob', 'append', notePath('bob', file), 'bob appended');
  await expect(live(page)).toContainText('bob appended', { timeout: 10_000 });
  await notReloaded(page);
  await ctx.close();
});

test('CLI append shows live in a note open in Basic mode (old path)', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, USER, PASS);
  const file = `cli-basic-${Date.now()}.md`;
  cli('alice', 'create', notePath('alice', file), '# Basic\n\nline\n');
  await open(page, file);
  await page.locator('.toolbar button', { hasText: /^Basic$/ }).click();
  const ta = page.locator('.editor-wrapper textarea');
  await expect(ta).toBeVisible({ timeout: 20_000 });
  await markPage(page);
  cli('alice', 'append', notePath('alice', file), 'appended in basic');
  await expect.poll(() => ta.inputValue(), { timeout: 10_000, message: 'append did not show in Basic' }).toContain('appended in basic');
  await notReloaded(page);
  await ctx.close();
});

test('a CLI write while someone types merges, it never overwrites', async ({ browser }) => {
  test.setTimeout(150_000);
  if (!USER2) test.skip(true, 'needs a second account');
  const a = await browser.newContext(); const pageA = await a.newPage();
  const b = await browser.newContext(); const pageB = await b.newPage();
  await login(pageA, USER, PASS);
  await login(pageB, USER2, PASS2);
  const file = `cli-typing-${Date.now()}.md`;
  cli('alice', 'create', notePath('alice', file), '# Typing\n\nalice line\n\nbob line\n\ntail\n');
  await open(pageA, file);
  await expect(live(pageA)).toContainText('bob line', { timeout: 20_000 });
  await open(pageB, file);
  await expect(live(pageB)).toContainText('bob line', { timeout: 20_000 });
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });

  const para = live(pageB).locator('p', { hasText: 'bob line' }).first();
  await para.click();
  await pageB.keyboard.press('End');
  const typed = ['kilo1', 'kilo2', 'kilo3', 'kilo4', 'kilo5', 'kilo6'];
  const typing = (async () => {
    for (const w of typed) {
      await pageB.keyboard.type(' ' + w, { delay: 40 });
      await pageB.waitForTimeout(500);
    }
  })();
  // CLI changes land while bob is still typing.
  await pageB.waitForTimeout(700);
  cli('alice', 'append', notePath('alice', file), 'cli append during typing');
  await pageB.waitForTimeout(900);
  cliEdit('alice', notePath('alice', file), 'alice line', 'alice line edited by cli');
  await pageB.waitForTimeout(900);
  // A whole-file write based on what is on disk now, as a script would do.
  const current = disk(file);
  cli('alice', 'write', notePath('alice', file), current.replace(/\n*$/, '\n\ncli write during typing\n'));
  await typing;

  const want = [...typed, 'cli append during typing', 'alice line edited by cli', 'cli write during typing'];
  await expect.poll(() => want.filter((w) => !disk(file).includes(w)), {
    timeout: 25_000, message: 'the file lost text (typed or from the CLI)',
  }).toEqual([]);
  for (const page of [pageA, pageB]) {
    await expect.poll(async () => {
      const t = await live(page).innerText();
      return want.filter((w) => !t.includes(w));
    }, { timeout: 15_000, message: 'an editor is missing text' }).toEqual([]);
  }
  await b.close(); await a.close();
});

test('a change written straight to disk (like a git-sync pull) shows in a shared note', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, USER, PASS);
  const file = `cli-disk-${Date.now()}.md`;
  cli('alice', 'create', notePath('alice', file), '# Disk\n\nline\n');
  await open(page, file);
  await expect(live(page)).toContainText('line', { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await markPage(page);
  // No API call, so no file-changed: only the saver's own check finds it.
  // Written beside the note and renamed over it, the way git replaces a file
  // on checkout (and the container owns the original, so the host cannot
  // open it for writing anyway).
  const target = path.join(NOTES_DIR, NS, file);
  const tmp = `${target}.pull`;
  fs.writeFileSync(tmp, disk(file).replace(/\n*$/, '\n\npulled by git-sync\n'));
  fs.chmodSync(tmp, 0o666);
  fs.renameSync(tmp, target);
  await expect(live(page), 'a disk write never showed').toContainText('pulled by git-sync', { timeout: 35_000 });
  await notReloaded(page);
  await ctx.close();
});
