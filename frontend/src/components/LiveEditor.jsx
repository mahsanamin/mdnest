import { useRef, useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark, codeBlockSchema } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history, undoCommand, redoCommand } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { replaceAll, callCommand, $view, insert, $prose, markdownToSlice } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { deleteRow, deleteColumn, deleteTable } from '@milkdown/prose/tables';
import { uploadImage } from '../api.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
import { looksLikeMarkdown } from '../markdown-utils.js';
import MermaidBlock from './MermaidBlock.jsx';
import MermaidViewer from './MermaidViewer.jsx';
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
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
  toggleStrikethroughCommand,
} from '@milkdown/preset-gfm';

// Plugin: persistent inline highlights for commented text.
// Built as ProseMirror Decorations (not DOM edits) so the editor state stays consistent.
//
// Exported (and the four custom plugins below) so the v3.10.0 Crepe-based
// LiveEditorCrepe.jsx can wire the same plugins onto the Crepe editor via
// `crepe.editor.use(plugin)` after `.create()`. When LiveEditor.jsx is
// deleted in Phase 5, these definitions migrate into a shared module.
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

// Map a string offset (into `combined`) to a ProseMirror doc position.
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
  const rangeMap = new Map(); // key -> { from, to, ids:[] }
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
      })
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
          flash = meta.flash; // { from, to } or null
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

// Plugin: auto-convert empty block nodes (heading, blockquote) to paragraph on backspace
export const clearEmptyBlockPlugin = $prose((ctx) => {
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

        // Only act on empty block nodes that aren't paragraphs
        if (node.content.size > 0) return false;
        if (node.type.name === 'paragraph') return false;

        // Check if this is a heading, blockquote, or similar
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

// Plugin: render `[ ]` / `[x]` inside table cells as interactive checkboxes.
//
// Why a decoration plugin and not a schema extension? GFM's table_cell
// node admits only `paragraph+` content — list items (where Milkdown's
// task-list-item lives) are not allowed children. Trying to widen the
// content expression breaks the ProseMirror tables editing plugin
// (cell selection, tab navigation, paste rules all assume the
// paragraph-only shape). So instead of changing the schema we layer
// pure visual decorations on top of literal `[ ]` / `[x]` text:
//   * an inline decoration with class `tcc-bracket-text` hides the
//     three characters via CSS (display:none does break cursor flow,
//     so we use width:0 + visibility:hidden so the cursor steps over
//     the brackets cleanly);
//   * a widget decoration at the same position renders an
//     `<input type="checkbox">` with `contentEditable=false` and a
//     click handler that dispatches a transaction replacing the
//     three-char text range with the toggled token. The widget is
//     rebuilt on every transaction (apply() runs `buildDecorations`
//     against `tr.doc`) so its captured `from`/`to` positions are
//     always fresh.
// Round-trip: the underlying text in the document remains literal
// `[ ]` / `[x]`, so toMarkdown serializes it unchanged. Rerendering
// the same markdown reapplies the decorations. Same trick works in
// any inline context (not only table cells), but we scope the scan
// to cells to avoid stepping on the existing GFM task-list rendering
// for top-level bullet lists.
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
          Decoration.inline(from, to, { class: 'tcc-bracket-text' })
        );
        decorations.push(
          Decoration.widget(
            from,
            () => makeCheckboxWidget(viewRef, from, to, checked),
            { side: -1, ignoreSelection: true }
          )
        );
      }
      return false; // text nodes have no children
    });
    return false; // already scanned this cell's contents
  });
  return DecorationSet.create(doc, decorations);
}

function makeCheckboxWidget(viewRef, from, to, checked) {
  // Wrap the <input> in a contentEditable=false span. Why a wrapper:
  // when a bare input sits inside a ProseMirror node-view-managed
  // cell, mousedown on the input bubbles up to ProseMirror's table
  // editing plugin, which selects the cell (visually "expanding" it
  // with cell-selection highlight) before our click handler fires.
  // The wrapper acts as the event boundary — we stopPropagation on
  // every mouse + pointer event at this layer so ProseMirror never
  // sees the interaction. The input keeps native checkbox styling
  // and accessibility (Space/Enter still toggles via keyboard).
  const wrap = document.createElement('span');
  wrap.className = 'tcc-cell-checkbox-wrap';
  wrap.contentEditable = 'false';
  wrap.setAttribute('aria-hidden', 'false');

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'tcc-cell-checkbox';
  input.checked = checked;
  input.contentEditable = 'false';
  input.tabIndex = -1; // don't steal focus on Tab navigation in cells

  const stop = (e) => {
    e.stopPropagation();
  };
  // mousedown is what ProseMirror's tableEditingPlugin listens to
  // for cell selection — we additionally preventDefault on the
  // outer wrapper so the click never enters the ProseMirror view's
  // event pipeline. The native checkbox's own toggle still happens
  // because we listen for `click` on the input below and dispatch
  // ourselves; we don't rely on the default toggle (which would race
  // against our state-driven re-render of the widget).
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
    // The decoration plugin rebuilds on every transaction, so `from`
    // is the position at the time this widget was painted. If a
    // concurrent transaction shifted the doc since, we map through
    // the head-of-state mapping just to be safe.
    const tr = state.tr.replaceWith(from, to, state.schema.text(next));
    view.dispatch(tr);
  };
  input.addEventListener('click', toggle);
  // Keyboard: Space/Enter on a focused checkbox should still toggle.
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

// ProseMirror node view for mermaid code blocks
// Renders MermaidBlock React component in place of the <pre> element
export const mermaidNodeView = $view(codeBlockSchema.node, (ctx) => {
  return (node, view, getPos) => {
    const lang = node.attrs.language || '';
    if (lang !== 'mermaid') {
      // Not mermaid — return null to use default rendering
      return {};
    }

    // Create container
    const dom = document.createElement('div');
    dom.className = 'mermaid-live-container';
    dom.contentEditable = 'false';

    const root = createRoot(dom);
    let currentSource = node.textContent;

    const render = (source) => {
      root.render(
        <MermaidBlock
          source={source}
          readOnly={!view.editable}
          onChange={(newSource) => {
            // Update the ProseMirror node's text content
            const pos = getPos();
            if (pos == null) return;
            const tr = view.state.tr;
            const nodeAt = view.state.doc.nodeAt(pos);
            if (!nodeAt) return;
            // Replace the code block's text content
            tr.replaceWith(
              pos + 1,
              pos + 1 + nodeAt.content.size,
              newSource ? view.state.schema.text(newSource) : view.state.schema.text('')
            );
            view.dispatch(tr);
          }}
          onFullscreen={(svg) => {
            // Dispatch a custom event that LiveEditor can listen to
            dom.dispatchEvent(new CustomEvent('mermaid-fullscreen', { detail: svg, bubbles: true }));
          }}
        />
      );
    };

    render(currentSource);

    return {
      dom,
      stopEvent: () => true, // Don't let ProseMirror handle events inside our component
      ignoreMutation: () => true, // Don't let ProseMirror sync our DOM changes
      update: (updatedNode) => {
        if (updatedNode.type.name !== 'code_block') return false;
        if ((updatedNode.attrs.language || '') !== 'mermaid') return false;
        const newSource = updatedNode.textContent;
        if (newSource !== currentSource) {
          currentSource = newSource;
          render(newSource);
        }
        return true;
      },
      destroy: () => {
        root.unmount();
      },
    };
  };
});

function MilkdownEditor({ content, onChange, readOnly, onEditorReady }) {
  const lastLocalContent = useRef(content);
  const editorRef = useRef(null);
  // Suppress onChange until user actually interacts. Starts true to block
  // Milkdown's initial re-serialization. Set true again on replaceAll (file switch).
  // Only cleared by keydown/mousedown — so MutationObserver re-serialization
  // (which fires async, long after replaceAll) is always blocked.
  const suppressSave = useRef(true);
  // Keep onChange in a ref so the markdownUpdated listener (created once in useEditor)
  // always calls the LATEST onChange, even after file switches recreate handleContentChange
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const { get } = useEditor((root) => {
    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content || '');
        ctx.set(editorViewOptionsCtx, {
          editable: () => !readOnly,
          attributes: {
            class: 'live-editor-content',
            spellcheck: 'false',
          },
        });

        const listenerManager = ctx.get(listenerCtx);
        listenerManager.markdownUpdated((ctx, markdown, prevMarkdown) => {
          lastLocalContent.current = markdown;
          if (suppressSave.current) return;
          if (markdown !== prevMarkdown) {
            if (onChangeRef.current) onChangeRef.current(markdown);
          }
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(history)
      .use(clipboard)
      .use(mermaidNodeView)
      .use(clearEmptyBlockPlugin)
      .use(commentHighlightPlugin)
      .use(tableCellCheckboxPlugin);
  }, [readOnly]);

  // Unsuppress on real user interaction — keydown/mousedown in the editor area.
  // Uses capture phase and targets .live-editor-wrapper so toolbar clicks count too.
  useEffect(() => {
    const unsuppress = (e) => {
      const wrapper = document.querySelector('.live-editor-wrapper');
      if (wrapper && wrapper.contains(e.target)) suppressSave.current = false;
    };
    document.addEventListener('keydown', unsuppress, true);
    document.addEventListener('mousedown', unsuppress, true);
    return () => {
      document.removeEventListener('keydown', unsuppress, true);
      document.removeEventListener('mousedown', unsuppress, true);
    };
  }, []);

  useEffect(() => {
    if (get) {
      const editor = get();
      if (editor) {
        editorRef.current = editor;
        if (onEditorReady) onEditorReady(editor);
      }
    }
  }, [get, onEditorReady]);

  useEffect(() => {
    if (!editorRef.current) return;
    if (content === lastLocalContent.current) return;
    suppressSave.current = true; // Block until next user interaction
    try {
      editorRef.current.action(replaceAll(content || ''));
      lastLocalContent.current = content;
    } catch (e) { /* editor not ready */ }
    // DO NOT clear suppressSave here — MutationObserver fires async later
  }, [content]);

  return <Milkdown />;
}

function LiveToolbar({ editor }) {
  if (!editor) return null;
  const cmd = (command, payload) => {
    try { editor.action(callCommand(command.key, payload)); } catch (e) {}
  };
  const proseCmd = (pmCommand) => {
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        pmCommand(view.state, view.dispatch);
      });
    } catch (e) {}
  };
  return (
    <div className="live-toolbar">
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

function LiveEditor({ content, onChange, currentPath, ns, readOnly, onComment, comments, onGoToReady, onHighlightClick }) {
  const [editor, setEditor] = useState(null);
  const [viewerSvg, setViewerSvg] = useState(null);
  const wrapperRef = useRef(null);
  const [selectionPopup, setSelectionPopup] = useState(null); // {top, left, text, start, end}
  const flashTimerRef = useRef(null);

  // Track text selection for comment button — only when the triggering
  // gesture happened inside the editor. Otherwise a sidebar click (e.g.
  // Go To) programmatically sets a selection and we end up popping the
  // "Comment" button at weird positions.
  useEffect(() => {
    if (!editor || !onComment) return;
    const checkSelection = (e) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      if (e && e.target && !wrapper.contains(e.target)) return;
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = view.state.selection;
          if (to - from < 3) { setSelectionPopup(null); return; }

          const selectedText = view.state.doc.textBetween(from, to, ' ');
          if (!selectedText.trim()) { setSelectionPopup(null); return; }

          const coords = view.coordsAtPos(to);
          const rect = wrapper.getBoundingClientRect();
          setSelectionPopup({
            top: coords.top - rect.top + wrapper.scrollTop + 20,
            left: Math.min(coords.left - rect.left, rect.width - 120),
            text: selectedText,
            start: from,
            end: to,
          });
        });
      } catch {}
    };

    document.addEventListener('mouseup', checkSelection);
    document.addEventListener('keyup', checkSelection);
    return () => {
      document.removeEventListener('mouseup', checkSelection);
      document.removeEventListener('keyup', checkSelection);
    };
  }, [editor, onComment]);

  // Handle image paste and rich HTML paste
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || readOnly) return;

    const handlePaste = async (e) => {
      const cb = e.clipboardData;
      if (!cb) return;

      // 1. Images
      for (const item of cb.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file && ns && currentPath) {
            try {
              const data = await uploadImage(ns, currentPath, file);
              const filename = (data.url || file.name).split('/').pop();
              if (editor) editor.action(insert(`![image](${filename})`));
            } catch (err) { console.error('Upload failed:', err); }
          }
          return;
        }
      }

      // 2. Table row paste — if clipboard has <tr> and cursor is in a table,
      // insert rows into the existing table instead of creating a new one.
      const html = cb.getData('text/html');
      if (html && /<tr[\s>]/i.test(html) && editor) {
        try {
          const handled = editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;
            const { $from } = state.selection;

            // Check if cursor is inside a table cell
            let tableNode = null;
            let tablePos = null;
            let currentRowIndex = 0;
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d);
              if (node.type.name === 'table') {
                tableNode = node;
                tablePos = $from.before(d);
                // Find current row index
                const cellNode = $from.node(d + 1); // table_row
                for (let i = 0; i < node.childCount; i++) {
                  if (node.child(i) === cellNode) { currentRowIndex = i; break; }
                }
                break;
              }
            }

            if (!tableNode) return false; // Not in a table — let default handler run

            // Parse the pasted HTML to extract cell contents
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const trs = doc.querySelectorAll('tr');
            if (trs.length === 0) return false;

            // Build rows from pasted HTML
            const pastedRows = [];
            for (const tr of trs) {
              const cells = [];
              for (const cell of tr.querySelectorAll('th, td')) {
                cells.push(cell.textContent.trim());
              }
              if (cells.length > 0) pastedRows.push(cells);
            }
            if (pastedRows.length === 0) return false;

            // Get table column count
            const colCount = tableNode.child(0).childCount;

            // Build ProseMirror table rows
            const schema = state.schema;
            const cellType = schema.nodes.table_cell;
            const rowType = schema.nodes.table_row;
            if (!cellType || !rowType) return false;

            const newRows = pastedRows.map((cells) => {
              const pmCells = [];
              for (let c = 0; c < colCount; c++) {
                const text = cells[c] || '';
                const content = text ? schema.text(text) : null;
                const para = schema.nodes.paragraph.create(null, content ? [content] : []);
                pmCells.push(cellType.create(null, [para]));
              }
              return rowType.create(null, pmCells);
            });

            // Insert after current row
            let insertPos = tablePos + 1; // start of table content
            for (let i = 0; i <= currentRowIndex; i++) {
              insertPos += tableNode.child(i).nodeSize;
            }

            const tr = state.tr;
            for (let i = newRows.length - 1; i >= 0; i--) {
              tr.insert(insertPos, newRows[i]);
            }
            view.dispatch(tr);
            return true;
          });

          if (handled) {
            e.preventDefault();
            return;
          }
        } catch (err) {
          // Fall through to default paste
          console.error('Table row paste failed:', err);
        }
      }

      // pasteMarkdown — go through markdownToSlice (which does a
      // markdown → ProseMirror doc → DOM → Slice round trip via the
      // schema's parseDOM rules). The DOM detour matters for task
      // list items: GFM's listItemSchema renders `<li data-item-type="task" data-checked="...">`,
      // and parseDOM picks the `checked` attr back out — so a pasted
      // `- [ ] Mercury` survives as an interactive task item. The
      // older `insert(md)` path skipped the DOM round trip and used
      // `Slice(doc.content, selection.openStart, selection.openEnd)`,
      // which mis-identified block content as inline when the cursor
      // sat in a paragraph and silently flattened bullets/checkboxes
      // to plain lines.
      const pasteMarkdown = (md) => {
        if (!md || !editor) return false;
        let inserted = false;
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const slice = markdownToSlice(md)(ctx);
          if (!slice) return;
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          inserted = true;
        });
        return inserted;
      };

      // Order matters: prefer plain-text-that-looks-like-markdown over
      // rich HTML when both are on the clipboard. Obsidian, terminals,
      // and most modern apps populate both text/plain (the source
      // markdown) and text/html (a rendered DOM version). The HTML
      // version often loses GFM semantics during htmlToMarkdown's DOM
      // round trip — task list `data-item-type="task"` attributes are
      // the prime offender, which is why `- [ ] Foo` from Obsidian
      // pasted as a plain bullet pre-v3.9.1. Plain markdown round-trips
      // cleanly via markdownToSlice, so when both are available and
      // the plain side parses as markdown, take it.
      const text = cb.getData('text/plain');
      if (text && editor && looksLikeMarkdown(text)) {
        e.preventDefault();
        pasteMarkdown(text);
        return;
      }

      // Rich HTML (from sources that don't ship markdown — Google Docs,
      // Confluence, web pages) → convert to markdown then insert.
      if (html && hasRichContent(html)) {
        e.preventDefault();
        const md = htmlToMarkdown(html);
        pasteMarkdown(md);
        return;
      }

      // Otherwise: default Milkdown paste (plain prose, no structure)
    };

    el.addEventListener('paste', handlePaste, true);
    return () => el.removeEventListener('paste', handlePaste, true);
  }, [editor, ns, currentPath, readOnly]);

  // Listen for mermaid fullscreen events from node views
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e) => setViewerSvg(e.detail);
    el.addEventListener('mermaid-fullscreen', handler);
    return () => el.removeEventListener('mermaid-fullscreen', handler);
  }, []);

  // Push active comment anchors into the highlight plugin whenever comments change.
  useEffect(() => {
    if (!editor) return;
    // Highlight only top-level threads (no parentId). Replies inherit their
    // parent's anchor, so adding them would just create duplicate decorations.
    // rangeStart flows through so the decoration picker can disambiguate
    // multiple occurrences of the same anchor text.
    const anchors = (comments || [])
      .filter((c) => !c.parentId && !c.resolved && c.anchorText)
      .map((c) => ({ text: c.anchorText, id: c.id, rangeStart: c.rangeStart }));
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.setMeta(commentHighlightKey, { anchors });
        view.dispatch(tr);
      });
    } catch {}
  }, [editor, comments]);

  // Go-to handler: finds anchor text and picks the occurrence closest to the
  // comment's stored rangeStart. This disambiguates when the same text appears
  // more than once (or when a shorter anchor is a substring of a longer one).
  // After scrolling, sets a transient "flash" decoration on the text so the
  // highlight itself pulses — same visual language as the sidebar flash.
  const goToComment = useCallback((comment) => {
    const anchorText = typeof comment === 'string' ? comment : comment?.anchorText;
    const hintPos = typeof comment === 'object' && comment ? Number(comment.rangeStart || 0) : 0;
    if (!editor || !anchorText) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const matches = findAnchorMatches(view.state.doc, anchorText);
        if (matches.length === 0) return;
        let best = matches[0];
        let bestDist = Math.abs(best.from - hintPos);
        for (const m of matches) {
          const d = Math.abs(m.from - hintPos);
          if (d < bestDist) { best = m; bestDist = d; }
        }
        const tr = view.state.tr
          .setSelection(TextSelection.create(view.state.doc, best.from, best.to))
          .setMeta(commentHighlightKey, { flash: { from: best.from, to: best.to } });
        view.dispatch(tr.scrollIntoView());
        view.focus();
        setSelectionPopup(null);

        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          try {
            editor.action((c2) => {
              const v2 = c2.get(editorViewCtx);
              v2.dispatch(v2.state.tr.setMeta(commentHighlightKey, { flash: null }));
            });
          } catch {}
        }, 1800);
      });
    } catch (e) {
      console.error('Go to comment failed:', e);
    }
  }, [editor]);

  // Clicking a yellow comment-highlight in the editor opens the sidebar
  // and flashes the relevant comment card.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || !onHighlightClick) return;
    const onClick = (e) => {
      const target = e.target.closest && e.target.closest('.comment-highlight');
      if (!target) return;
      const ids = (target.getAttribute('data-comment-ids') || '').split(',').filter(Boolean);
      if (ids.length === 0) return;
      onHighlightClick(ids[0]);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [onHighlightClick]);

  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  // Expose goToComment to parent
  useEffect(() => {
    if (onGoToReady) onGoToReady(goToComment);
  }, [goToComment, onGoToReady]);

  return (
    <div className="live-editor-pane">
      {readOnly && <div className="editor-readonly-bar">Read-only</div>}
      {!readOnly && <LiveToolbar editor={editor} />}
      <div className="live-editor-wrapper" ref={wrapperRef}>
        <MilkdownProvider>
          <MilkdownEditor
            content={content}
            onChange={onChange}
            readOnly={readOnly}
            onEditorReady={setEditor}
          />
        </MilkdownProvider>
        {selectionPopup && onComment && (
          <button
            className="comment-selection-btn"
            style={{ top: selectionPopup.top, left: selectionPopup.left }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onComment({
                rangeStart: selectionPopup.start,
                rangeEnd: selectionPopup.end,
                anchorText: selectionPopup.text,
              });
              setSelectionPopup(null);
            }}
          >
            💬 Comment
          </button>
        )}
      </div>
      {viewerSvg && (
        <MermaidViewer svgContent={viewerSvg} onClose={() => setViewerSvg(null)} />
      )}
    </div>
  );
}

export default LiveEditor;
