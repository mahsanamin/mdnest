// @vitest-environment jsdom

// Round-trip fidelity for wikilinks in the Live editor. The Live editor
// must never change the stored bytes of a document just because it
// contains [[...]]: Milkdown's serializer (remark-stringify) escapes
// markdown punctuation in plain text, so [[Note]] would come back as
// \[\[Note]] on every save. LiveEditorCrepe.jsx routes every serialized
// document through restoreWikilinks() before onChange; this test drives
// the exact same pipeline (real Milkdown parse -> ProseMirror doc ->
// serialize -> restoreWikilinks) headless under jsdom and asserts the
// output is byte-identical to the input.
//
// The fixture uses the serializer's canonical forms for everything else
// (`*` task bullets, ``` fences) so the only thing under test is the
// wikilink escaping, not unrelated normalization.

import { describe, it, expect } from 'vitest';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { restoreWikilinks } from '../wikilink.js';
import { findWikilinkRanges } from '../components/live-editor-plugins.jsx';

async function loadEditor(md) {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement('div'));
      ctx.set(defaultValueCtx, md);
    })
    .use(commonmark)
    .use(gfm)
    .create();
}

function serialize(editor) {
  return editor.action((ctx) => {
    const serializer = ctx.get(serializerCtx);
    const view = ctx.get(editorViewCtx);
    return serializer(view.state.doc);
  });
}

const FIXTURE = `# Planning

See [[Target Note]] and [[dir/other#Heading|alias]] plus [[my_note_v2]].

A same-note link [[#Setup]] and a broken one [[Ghost]].

* [ ] task with [[Another Note]]

\`\`\`php
$x = [['field' => 'x']];
\`\`\`

Inline \`[[not a link]]\` stays code.
`;

describe('Live editor wikilink round-trip', () => {
  it('serializes a document with wikilinks byte-identical', async () => {
    const editor = await loadEditor(FIXTURE);
    const out = restoreWikilinks(serialize(editor));
    await editor.destroy();
    expect(out).toBe(FIXTURE);
  });

  it('never emits escaped wikilink brackets', async () => {
    const editor = await loadEditor('Just [[One Link]] here.\n');
    const out = restoreWikilinks(serialize(editor));
    await editor.destroy();
    expect(out).not.toContain('\\[');
    expect(out).toContain('[[One Link]]');
  });
});

describe('findWikilinkRanges (Live editor decorations)', () => {
  it('finds wikilinks in text but not in code blocks or inline code', async () => {
    const editor = await loadEditor(FIXTURE);
    const ranges = editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      return findWikilinkRanges(view.state.doc);
    });
    await editor.destroy();

    const inners = ranges.map((r) => r.inner);
    expect(inners).toContain('Target Note');
    expect(inners).toContain('dir/other#Heading|alias');
    expect(inners).toContain('my_note_v2');
    expect(inners).toContain('#Setup');
    expect(inners).toContain('Another Note');
    // Nothing from the fenced block or the inline code span.
    expect(inners.some((i) => i.includes('field'))).toBe(false);
    expect(inners).not.toContain('not a link');
  });
});
