// Guards every shell command the UI hands the user with a Copy button.
//
// `<your-token>` is not a placeholder to a shell — it is a REDIRECTION. Paste
// `mdnest login https://notes.example.com <your-token>` into zsh or bash and
// you get "no such file or directory: your-token", so the instruction meant to
// get someone unstuck becomes the next thing that breaks. The CLI learned this
// in v4.1.3 and tests/cli-unit.sh has pinned it for CLI *output* ever since;
// the Settings page was never covered and had nine of them, each behind a Copy
// button that reproduces the text verbatim.
//
// Bracket notation is still fine in prose and in `Usage:` synopses — nobody
// pastes those. The rule is specifically about a line someone is told to RUN.
// Use a literal stand-in instead: `mdnest_yourtoken`, `notes`, `@myserver`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files that render copyable command blocks to the user.
const FILES = ['components/Settings.jsx'];

// A shell block is any CodeBlock containing a tool invocation. The Copy button
// reproduces the WHOLE block, so once a block is shell, every line in it is
// something someone will paste — including a line that starts with `echo` and
// pipes into mdnest, which a naive "starts with mdnest" rule walks straight
// past. Non-shell blocks (the MCP tab's JSON config) are left alone.
const INVOKES_A_TOOL = /\b(mdnest|mdnest-server|curl|npx|docker)\b/;

function codeBlocks(source) {
  return [
    ...(source.match(/<CodeBlock[^>]*code=\{`[\s\S]*?`\}/g) || []),
    ...(source.match(/<CodeBlock[^>]*code="[^"]*"/g) || []),
  ];
}

// A JSON config block (the MCP tab's claude_desktop_config.json) mentions
// `node` and `mdnest`, but it is pasted into a FILE, not a shell — `<your
// token>` is a perfectly good placeholder there. Only shell blocks are bound
// by the redirection rule.
const IS_JSON_CONFIG = /code=[{"]`?\s*\{/;

function shellLines(source) {
  return codeBlocks(source)
    .filter((b) => INVOKES_A_TOOL.test(b) && !IS_JSON_CONFIG.test(b))
    .flatMap((b) => b.split('\n'))
    .map((l) => l.replace(/^.*code=[{"]`?/, '').replace(/`\}\s*\/?>?\s*$/, ''))
    .filter((l) => l.trim() !== '');
}

describe('commands the UI tells you to run', () => {
  for (const file of FILES) {
    const source = readFileSync(join(SRC, file), 'utf8');

    it(`${file}: finds shell blocks to check`, () => {
      // If this ever hits zero the extraction has drifted and every assertion
      // below would pass vacuously.
      expect(shellLines(source).length).toBeGreaterThan(10);
    });

    it(`${file}: no angle brackets — they are shell redirections`, () => {
      const offenders = shellLines(source).filter((l) => /<[^>\s][^>]*>/.test(l));
      expect(offenders, `pasting these fails in zsh/bash:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
