// Someone is typing in a note when the CLI changes it. The CLI's text must be
// kept on disk, whatever the editor shows. Reported on a build before shared
// editing: the CLI's text disappeared. The likely cause on those builds: the
// tab took the newer version's etag (60 s poll or file-changed) while it had
// unsaved typing, so its next autosave wrote the whole note over the CLI's
// change.
//
// The person types without a pause long enough to autosave (one key every
// 300 ms, for longer than the 60 s poll), so the tab holds unsaved text when
// the poll runs. Each test prints a RESULT line: whether the CLI text and the
// typed text reached the file, and whether a conflict banner showed.
//
// Runs from tests/e2e-collab-multi.sh (real CLI, notes dir on the host).
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const CLI = process.env.MDNEST_CLI || '';
const CLI_HOMES = process.env.MDNEST_CLI_HOMES || '';
const NOTES_DIR = process.env.MDNEST_NOTES_DIR || '';
const NS = 'testing_workspace';
const TYPE_MS = Number(process.env.MDNEST_TYPE_MS || 75_000);

const cli = (...args) => execFileSync(CLI, args, { env: { ...process.env, HOME: path.join(CLI_HOMES, 'alice-home') }, encoding: 'utf8' });
const disk = (file) => fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8');

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(() => {
  if (!CLI || !CLI_HOMES || !NOTES_DIR) test.skip(true, 'needs tests/e2e-collab-multi.sh');
});

for (const mode of ['Basic', 'Live']) {
  test(`one person typing in ${mode} while the CLI appends: the CLI text is kept`, async ({ browser }) => {
    test.setTimeout(TYPE_MS + 90_000);
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await login(page);
    const cfg = await page.evaluate(async () => (await fetch('/api/config')).json());
    const file = `typing-${mode}-${Date.now()}.md`;
    cli('create', `@alice/${NS}/${file}`, '# Typing\n\nmy paragraph\n\nend\n');
    await page.goto(`/#${NS}/${file}`);
    await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
    if (mode === 'Basic') {
      await page.locator('.toolbar button', { hasText: /^Basic$/ }).click();
      const ta = page.locator('.editor-wrapper textarea');
      await expect(ta).toBeVisible({ timeout: 20_000 });
      // Caret at the end of "my paragraph".
      await ta.evaluate((el) => { const i = el.value.indexOf('my paragraph') + 'my paragraph'.length; el.focus(); el.setSelectionRange(i, i); });
    } else {
      const para = page.locator('.editor-wrapper .ProseMirror p', { hasText: 'my paragraph' }).first();
      await expect(para).toBeVisible({ timeout: 20_000 });
      await para.click();
      await page.keyboard.press('End');
    }
    await page.evaluate(() => {
      window.__banner = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('.conflict-banner, .restore-banner')) {
          const t = (el.textContent || '').slice(0, 60);
          if (!window.__banner.includes(t)) window.__banner.push(t);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    // Type continuously; the CLI appends a few seconds in.
    const words = [];
    const started = Date.now();
    let appended = false;
    let n = 0;
    while (Date.now() - started < TYPE_MS) {
      const w = ` w${String(n).padStart(3, '0')}`;
      for (const ch of w) { await page.keyboard.type(ch); await page.waitForTimeout(300); }
      words.push(w.trim());
      n += 1;
      if (!appended && Date.now() - started > 4000) {
        cli('append', `@alice/${NS}/${file}`, 'line from the cli');
        appended = true;
      }
    }
    await page.waitForTimeout(6000); // let the last save land

    const text = disk(file);
    const editorText = mode === 'Basic'
      ? await page.locator('.editor-wrapper textarea').inputValue()
      : await page.locator('.editor-wrapper .ProseMirror').innerText();
    const result = {
      build: cfg.version, commit: cfg.commit, sharedEditing: cfg.sharedEditing === true, mode,
      cliKept: text.includes('line from the cli'),
      typedSaved: `${words.filter((w) => text.includes(w)).length}/${words.length}`,
      editorShowsCli: editorText.includes('line from the cli'),
      banners: await page.evaluate(() => window.__banner),
    };
    console.log('RESULT ' + JSON.stringify(result));
    expect(result.cliKept, 'the CLI text was lost from the file').toBe(true);
    await ctx.close();
  });
}
