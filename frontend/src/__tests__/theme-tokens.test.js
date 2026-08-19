// Guards the design-token layer.
//
// The token layer only buys anything if it stays complete. One hex literal
// dropped back into App.css is a colour that silently does not switch when the
// user picks light mode — and it will not throw, it will just look broken for
// whoever is not on the theme the author happened to be using. Same for a
// var(--x) whose token was never defined: CSS resolves an unknown custom
// property to nothing and the declaration is simply dropped, so the failure is
// invisible until someone looks at that exact widget.
//
// These are cheap file-level assertions on purpose. They run in the fast tier
// and catch the erosion at the moment it is introduced.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// The stylesheets that must be fully tokenised. MarpDeck.css is deliberately
// absent: a slide deck is an authored artifact and does not follow the app
// theme. vendor/ is third-party code we do not edit.
const TOKENISED = ['App.css', 'index.css', 'components/TaskBoard.css'];

const read = (rel) => readFileSync(join(SRC, rel), 'utf-8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// #0000 is shorthand for transparent, and pure black/white are absolutes
// rather than palette entries — none of them are theme colours.
const ALLOWED = new Set(['#0000', '#000', '#fff', '#ffffff', '#00000000']);

describe('design tokens', () => {
  for (const file of TOKENISED) {
    it(`${file} declares no raw colour literals`, () => {
      const found = (stripComments(read(file)).match(/#[0-9a-fA-F]{3,8}\b/g) || [])
        .filter((h) => !ALLOWED.has(h.toLowerCase()));
      expect(found).toEqual([]);
    });
  }

  it('every token used by a stylesheet is defined in theme.css', () => {
    const theme = read('theme.css');
    const defined = new Set(
      [...theme.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );

    // Names owned by other systems, or set on an element at runtime rather
    // than in theme.css. A var() naming one of these is not our token.
    // Excalidraw's stylesheet supplies --island-bg-color / --icon-fill-color /
    // --button-hover-bg / --shadow-island to controls we render inside its UI.
    const foreign =
      /^--(crepe|milkdown|marp|excalidraw|island|icon-fill|button-hover|shadow-island|tree-depth|cursor-bg|bov)/;

    const missing = new Set();
    for (const file of TOKENISED) {
      const css = stripComments(read(file));
      for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*([,)])/g)) {
        const [, name, next] = m;
        if (defined.has(name) || foreign.test(name)) continue;
        // A var() with a fallback is a deliberate "may not exist" — the
        // fallback is what renders. Only a bare var() must resolve.
        if (next === ',') continue;
        missing.add(`${file}: ${name}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('theme.css keeps primitives out of the stylesheets', () => {
    // --ctp-* is the raw palette. Only theme.css may name it; anything else
    // referencing it has bypassed the semantic layer and will not re-theme.
    const leaked = [];
    for (const file of TOKENISED) {
      if (/var\(\s*--ctp-/.test(stripComments(read(file)))) leaked.push(file);
    }
    expect(leaked).toEqual([]);
  });
});
