// Shared Milkdown plugins and the LiveToolbar component.
//
// These extensions used to live inside LiveEditor.jsx (the pre-v3.10.0
// editor) and were exported from there so LiveEditorCrepe.jsx could
// register the same custom behavior on top of Crepe. Since v3.10.0 the
// Crepe editor is the only Live editor, so the definitions migrated here
// and the legacy LiveEditor.jsx was deleted.
//
// What's here:
//   - commentHighlightKey / findAnchorMatches / commentHighlightPlugin —
//     persistent yellow highlights on commented text ranges, anchor
//     position math that survives inline-mark splits, transient flash
//     highlight used by goToComment().
//   - clearEmptyBlockPlugin — Backspace/Delete on an empty heading or
//     blockquote converts it to a paragraph.
//   - tableCellCheckboxPlugin — literal `[ ]` / `[x]` inside table cells
//     render as interactive checkboxes (decoration-based; markdown bytes
//     unchanged on serialize).
//   - LiveToolbar — the persistent top toolbar shown above the editor
//     (Undo, Redo, formatting, insert, table commands).

import { callCommand, $prose } from '@milkdown/utils';
import { editorViewCtx } from '@milkdown/core';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { deleteRow, deleteColumn } from '@milkdown/prose/tables';
import { undoCommand, redoCommand } from '@milkdown/plugin-history';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  insertHrCommand,
  createCodeBlockCommand,
  toggleLinkCommand,
} from '@milkdown/preset-commonmark';
import {
  insertTableCommand,
  addRowAfterCommand,
  addColAfterCommand,
  toggleStrikethroughCommand,
} from '@milkdown/preset-gfm';

// ===== Comment-highlight plugin =====

export const commentHighlightKey = new PluginKey('comment-highlight');

// Build a concatenation of every inline text node in the doc with a mapping
// from string offsets back to ProseMirror positions. This lets us find anchor
// text that spans inline marks (bold, italic, links, inline code) where the
// text is split across multiple text nodes.
function buildTextIndex(doc) {
  let combined = '';
  const segs = []; // { strStart, length, posBase }
  doc.descendants((node, pos) => {
    if (node.isText) {
      segs.push({ strStart: combined.length, length: node.text.length, posBase: pos });
      combined += node.text;
    }
  });
  return { combined, segs };
}

function strIdxToDocPos(segs, idx) {
  for (const s of segs) {
    if (idx >= s.strStart && idx <= s.strStart + s.length) {
      return s.posBase + (idx - s.strStart);
    }
  }
  return -1;
}

export function findAnchorMatches(doc, anchorText) {
  const { combined, segs } = buildTextIndex(doc);
  const matches = [];
  if (!anchorText || anchorText.length < 2) return matches;
  let startIdx = 0;
  while (true) {
    const idx = combined.indexOf(anchorText, startIdx);
    if (idx < 0) break;
    const from = strIdxToDocPos(segs, idx);
    const to = strIdxToDocPos(segs, idx + anchorText.length);
    if (from >= 0 && to > from) matches.push({ from, to });
    startIdx = idx + 1;
  }
  return matches;
}

function buildCommentDecorations(doc, anchors) {
  if (!anchors || anchors.length === 0) return DecorationSet.empty;
  const rangeMap = new Map();
  for (const anchor of anchors) {
    const text = anchor?.text;
    if (!text || text.length < 2) continue;
    const matches = findAnchorMatches(doc, text);
    if (matches.length === 0) continue;

    // Highlight only the occurrence whose position is closest to where the
    // comment was originally placed. Without this, a comment on "good"
    // would light up every "good" in the document.
    const hintPos = Number(anchor.rangeStart ?? 0);
    let best = matches[0];
    let bestDist = Math.abs(best.from - hintPos);
    for (const m of matches) {
      const d = Math.abs(m.from - hintPos);
      if (d < bestDist) { best = m; bestDist = d; }
    }

    const key = `${best.from}-${best.to}`;
    if (!rangeMap.has(key)) {
      rangeMap.set(key, { from: best.from, to: best.to, ids: [anchor.id] });
    } else {
      rangeMap.get(key).ids.push(anchor.id);
    }
  }
  const decorations = [];
  for (const { from, to, ids } of rangeMap.values()) {
    decorations.push(
      Decoration.inline(from, to, {
        class: 'comment-highlight',
        'data-comment-ids': ids.join(','),
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

export const commentHighlightPlugin = $prose(() => {
  return new Plugin({
    key: commentHighlightKey,
    state: {
      init() {
        return { anchors: [], decorations: DecorationSet.empty, flash: null };
      },
      apply(tr, old) {
        const meta = tr.getMeta(commentHighlightKey);
        let anchors = old.anchors;
        let decorations = old.decorations;
        let flash = old.flash;

        if (meta && Array.isArray(meta.anchors)) {
          anchors = meta.anchors;
          decorations = buildCommentDecorations(tr.doc, anchors);
        } else if (tr.docChanged) {
          decorations = buildCommentDecorations(tr.doc, anchors);
        }

        if (meta && 'flash' in meta) {
          flash = meta.flash;
        } else if (flash && tr.docChanged) {
          const nf = tr.mapping.map(flash.from);
          const nt = tr.mapping.map(flash.to);
          flash = nt > nf ? { from: nf, to: nt } : null;
        }

        return { anchors, decorations, flash };
      },
    },
    props: {
      decorations(state) {
        const s = this.getState(state);
        if (!s) return null;
        if (!s.flash) return s.decorations;
        try {
          return s.decorations.add(state.doc, [
            Decoration.inline(s.flash.from, s.flash.to, { class: 'comment-flash-active' }),
          ]);
        } catch {
          return s.decorations;
        }
      },
    },
  });
});

// ===== Clear-empty-block plugin =====
// Backspace/Delete on an empty heading or blockquote → paragraph.
export const clearEmptyBlockPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('clear-empty-block'),
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
        const { state } = view;
        const { selection } = state;
        if (!selection.empty) return false;

        const { $from } = selection;
        const node = $from.parent;

        if (node.content.size > 0) return false;
        if (node.type.name === 'paragraph') return false;

        const paragraph = state.schema.nodes.paragraph;
        if (!paragraph) return false;

        const pos = $from.before($from.depth);
        const tr = state.tr.setNodeMarkup(pos, paragraph);
        view.dispatch(tr);
        return true;
      },
    },
  });
});

// ===== Table-cell checkbox plugin =====
//
// Render `[ ]` / `[x]` inside table cells as interactive checkboxes.
//
// Why a decoration plugin and not a schema extension? GFM's table_cell
// node admits only `paragraph+` content — list items (where Milkdown's
// task-list-item lives) are not allowed children. Trying to widen the
// content expression breaks the ProseMirror tables editing plugin
// (cell selection, tab navigation, paste rules all assume the
// paragraph-only shape). So instead of changing the schema we layer
// pure visual decorations on top of literal `[ ]` / `[x]` text:
//   * inline decoration with class `tcc-bracket-text` hides the three
//     characters via width:0 + visibility:hidden so the cursor steps
//     over the brackets cleanly;
//   * a widget decoration at the same position renders an
//     `<input type="checkbox">` with `contentEditable=false` and a
//     click handler that dispatches a transaction replacing the
//     three-char text range with the toggled token.
// Round-trip: the underlying text in the document remains literal
// `[ ]` / `[x]`, so toMarkdown serializes it unchanged.

const tableCellCheckboxKey = new PluginKey('table-cell-checkbox');
const TASK_RE = /\[([ xX])\]/g;

function buildTableCellCheckboxDecorations(doc, viewRef) {
  const decorations = [];
  doc.descendants((cell, cellPos) => {
    if (cell.type.name !== 'table_cell' && cell.type.name !== 'table_header') {
      return true;
    }
    const cellContentStart = cellPos + 1;
    cell.descendants((child, posInCell) => {
      if (!child.isText) return true;
      const text = child.text || '';
      TASK_RE.lastIndex = 0;
      let m;
      while ((m = TASK_RE.exec(text)) !== null) {
        const from = cellContentStart + posInCell + m.index;
        const to = from + 3;
        const checked = m[1].toLowerCase() === 'x';

        decorations.push(
          Decoration.inline(from, to, { class: 'tcc-bracket-text' }),
        );
        decorations.push(
          Decoration.widget(
            from,
            () => makeCheckboxWidget(viewRef, from, to, checked),
            { side: -1, ignoreSelection: true },
          ),
        );
      }
      return false;
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function makeCheckboxWidget(viewRef, from, to, checked) {
  // Wrap the <input> in a contentEditable=false span. Without the wrapper,
  // mousedown on the input bubbles to ProseMirror's table editing plugin
  // which then selects the cell before our click handler fires. The wrapper
  // acts as the event boundary — we stopPropagation on every mouse/pointer
  // event at this layer so ProseMirror never sees the interaction.
  const wrap = document.createElement('span');
  wrap.className = 'tcc-cell-checkbox-wrap';
  wrap.contentEditable = 'false';
  wrap.setAttribute('aria-hidden', 'false');

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'tcc-cell-checkbox';
  input.checked = checked;
  input.contentEditable = 'false';
  input.tabIndex = -1;

  const stop = (e) => { e.stopPropagation(); };
  ['mousedown', 'pointerdown', 'touchstart'].forEach((evt) => {
    wrap.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });
  ['mouseup', 'pointerup', 'touchend', 'dblclick'].forEach((evt) => {
    wrap.addEventListener(evt, stop);
  });

  const toggle = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const view = viewRef.current;
    if (!view) return;
    const next = checked ? '[ ]' : '[x]';
    const { state } = view;
    const tr = state.tr.replaceWith(from, to, state.schema.text(next));
    view.dispatch(tr);
  };
  input.addEventListener('click', toggle);
  input.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') toggle(e);
  });

  wrap.appendChild(input);
  return wrap;
}

export const tableCellCheckboxPlugin = $prose(() => {
  const viewRef = { current: null };
  return new Plugin({
    key: tableCellCheckboxKey,
    view(editorView) {
      viewRef.current = editorView;
      return {
        destroy() { viewRef.current = null; },
      };
    },
    state: {
      init(_, state) {
        return buildTableCellCheckboxDecorations(state.doc, viewRef);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildTableCellCheckboxDecorations(tr.doc, viewRef);
      },
    },
    props: {
      decorations(state) {
        return tableCellCheckboxKey.getState(state);
      },
    },
  });
});

// ===== LiveToolbar — persistent top toolbar =====

export function LiveToolbar({ editor, handlesHidden, onToggleHandles }) {
  if (!editor) return null;
  const cmd = (command, payload) => {
    try { editor.action(callCommand(command.key, payload)); } catch { /* not ready */ }
  };
  const proseCmd = (pmCommand) => {
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        pmCommand(view.state, view.dispatch);
      });
    } catch { /* not ready */ }
  };
  return (
    <div className="live-toolbar">
      {onToggleHandles && (
        <>
          <div className="live-toolbar-group">
            <button
              className={handlesHidden ? '' : 'active'}
              onMouseDown={(e) => { e.preventDefault(); onToggleHandles(); }}
              title={handlesHidden ? 'Show block handles (drag / + controls)' : 'Hide block handles to use full width (slash “/” still works)'}
              aria-label="Toggle block handles"
              aria-pressed={!handlesHidden}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
            </button>
          </div>
          <span className="live-toolbar-sep" />
        </>
      )}
      <div className="live-toolbar-group">
        <button onMouseDown={(e) => { e.preventDefault(); cmd(undoCommand); }} title="Undo (Cmd/Ctrl+Z)" aria-label="Undo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>
        </button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(redoCommand); }} title="Redo (Cmd/Ctrl+Shift+Z)" aria-label="Redo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/></svg>
        </button>
      </div>
      <span className="live-toolbar-sep" />
      <div className="live-toolbar-group">
        <button onMouseDown={(e) => { e.preventDefault(); cmd(toggleStrongCommand); }} title="Bold"><b>B</b></button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(toggleEmphasisCommand); }} title="Italic"><i>I</i></button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(toggleStrikethroughCommand); }} title="Strikethrough"><s>S</s></button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(toggleInlineCodeCommand); }} title="Inline code">`</button>
      </div>
      <span className="live-toolbar-sep" />
      <div className="live-toolbar-group">
        <button onMouseDown={(e) => { e.preventDefault(); cmd(wrapInHeadingCommand, 1); }} title="Heading 1">H1</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(wrapInHeadingCommand, 2); }} title="Heading 2">H2</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(wrapInHeadingCommand, 3); }} title="Heading 3">H3</button>
      </div>
      <span className="live-toolbar-sep" />
      <div className="live-toolbar-group">
        <button onMouseDown={(e) => { e.preventDefault(); cmd(wrapInBulletListCommand); }} title="Bullet list">&#8226;</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(wrapInOrderedListCommand); }} title="Numbered list">1.</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(wrapInBlockquoteCommand); }} title="Blockquote">&gt;</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(insertHrCommand); }} title="Horizontal rule">―</button>
      </div>
      <span className="live-toolbar-sep" />
      <div className="live-toolbar-group">
        <button onMouseDown={(e) => { e.preventDefault(); cmd(toggleLinkCommand); }} title="Link">&#128279;</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(createCodeBlockCommand); }} title="Code block">{ }</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(insertTableCommand, { row: 3, col: 3 }); }} title="Insert table">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
        </button>
      </div>
      <span className="live-toolbar-sep" />
      <div className="live-toolbar-group live-toolbar-table">
        <button onMouseDown={(e) => { e.preventDefault(); cmd(addRowAfterCommand); }} title="Add row">+Row</button>
        <button onMouseDown={(e) => { e.preventDefault(); cmd(addColAfterCommand); }} title="Add column">+Col</button>
        <button className="danger" onMouseDown={(e) => { e.preventDefault(); proseCmd(deleteRow); }} title="Delete row">-Row</button>
        <button className="danger" onMouseDown={(e) => { e.preventDefault(); proseCmd(deleteColumn); }} title="Delete column">-Col</button>
      </div>
    </div>
  );
}
