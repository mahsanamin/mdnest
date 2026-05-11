// LiveEditorCrepe — Crepe-based Live editor for v3.10.0.
//
// Layered on top of @milkdown/crepe (the editor that Milkdown's playground
// uses) so we inherit the block-edit / slash menu / drag handle / native
// task-list checkboxes / CodeMirror code blocks / KaTeX math / image upload UI.
//
// Customizations on top:
//   - Mermaid: via Crepe's CodeMirror `renderPreview` hook (NOT a separate
//     $view nodeView) — mermaid blocks toggle between source-in-CodeMirror
//     and live-rendered SVG using the same affordance other code blocks get.
//   - Catppuccin Mocha palette: variable overrides on `.editor-wrapper .milkdown`
//     in App.css; we don't import any of Crepe's color themes (nord, frame, …).
//   - Comments: ported `commentHighlightPlugin` for yellow highlights on
//     anchored text + click-to-open-sidebar + goToComment(c) flash-and-scroll.
//   - `clearEmptyBlockPlugin`: Backspace on an empty heading/blockquote
//     converts it to a paragraph.
//   - `tableCellCheckboxPlugin`: literal `[ ]` / `[x]` inside table cells
//     render as interactive checkboxes (decoration-based; markdown bytes
//     unchanged on serialize).
//   - Paste handler with v3.9.1 priority — images upload first, then
//     table-row HTML splices into existing tables, then text/plain that
//     looks like markdown wins over text/html (so Obsidian's `- [ ] Foo`
//     stays a task item instead of getting flattened by the HTML round trip).
//   - `<LiveToolbar>` above the editor (Crepe's floating selection toolbar
//     is disabled via `features: { toolbar: false }`).
//
// What we DELIBERATELY drop versus the legacy LiveEditor:
//   - `topLevelTaskCheckboxPlugin` — Crepe's `list-item` feature renders
//     native SVG task checkboxes for top-level task items, which is exactly
//     what the hand-rolled plugin was trying (and visually failing) to do.
//   - The standalone `mermaidNodeView` $view — replaced by `renderPreview`.

import { useEffect, useRef, useState, useCallback } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/core';
import { TextSelection } from '@milkdown/prose/state';
import { insert, markdownToSlice } from '@milkdown/utils';
import mermaid, { fixMermaidTextColors } from '../mermaid-config.js';
import { uploadImage } from '../api.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
import { looksLikeMarkdown } from '../markdown-utils.js';
import {
  commentHighlightPlugin,
  commentHighlightKey,
  findAnchorMatches,
  clearEmptyBlockPlugin,
  tableCellCheckboxPlugin,
  LiveToolbar,
} from './LiveEditor.jsx';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';

// Render mermaid source into a DOM element. Used as Crepe's renderPreview
// callback — returns the element so Crepe's code-block component can swap
// it in for the CodeMirror view when "preview" mode is active.
async function renderMermaidInto(el, source) {
  if (!source || !source.trim()) {
    el.innerHTML = '<div class="crepe-mermaid-empty">Empty mermaid diagram</div>';
    return;
  }
  try {
    await mermaid.parse(source);
    const id = 'crepe-mermaid-' + Math.random().toString(36).slice(2, 9);
    const { svg } = await mermaid.render(id, source);
    el.innerHTML = svg;
    const svgEl = el.querySelector('svg');
    if (svgEl) fixMermaidTextColors(svgEl);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const pre = document.createElement('pre');
    pre.className = 'crepe-mermaid-error';
    pre.textContent = msg;
    el.innerHTML = '';
    el.appendChild(pre);
  }
}

export default function LiveEditorCrepe({
  content,
  onChange,
  readOnly,
  ns,
  currentPath,
  comments,
  onGoToReady,
  onHighlightClick,
}) {
  const rootRef = useRef(null);
  const crepeRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const flashTimerRef = useRef(null);
  // LiveToolbar needs the underlying Milkdown Editor instance. Track it in
  // state so the toolbar re-renders once crepe.create() resolves.
  const [innerEditor, setInnerEditor] = useState(null);

  const suppressSaveRef = useRef(true);

  useEffect(() => {
    if (!rootRef.current) return;
    if (content === null || content === undefined) return;

    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: content,
      // Disable Crepe's floating selection toolbar. We render our own
      // persistent <LiveToolbar> above the editor instead — it has Undo /
      // Redo / table delete-row/col that Crepe's bar doesn't replicate.
      features: { toolbar: false },
      featureConfigs: {
        'code-mirror': {
          // Default code blocks to preview-only mode. For non-renderable
          // languages renderPreview returns null, which means preview.value
          // stays null and Crepe falls back to showing CodeMirror anyway —
          // so this only affects mermaid (and any future renderable langs).
          previewOnlyByDefault: true,
          renderPreview: (language, content) => {
            if (language !== 'mermaid') return null;
            const container = document.createElement('div');
            container.className = 'crepe-mermaid-preview';
            renderMermaidInto(container, content);
            return container;
          },
        },
      },
    });

    // Custom plugins: layer onto the underlying Milkdown editor that Crepe
    // wraps. These must be registered BEFORE crepe.create() runs the editor
    // creation pipeline.
    //
    // Skipped vs. legacy LiveEditor:
    //   - mermaidNodeView: replaced by Crepe's CodeMirror `renderPreview` hook
    //     (see featureConfigs above)
    //   - topLevelTaskCheckboxPlugin: Crepe's `list-item` feature renders
    //     native SVG task checkboxes — no longer needed
    crepe.editor
      .use(commentHighlightPlugin)
      .use(clearEmptyBlockPlugin)
      .use(tableCellCheckboxPlugin);

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prev) => {
        if (suppressSaveRef.current) return;
        if (markdown === prev) return;
        const cb = onChangeRef.current;
        if (cb) cb(markdown);
      });
    });

    crepe.create().then(() => {
      crepeRef.current = crepe;
      setInnerEditor(crepe.editor);
      if (readOnly) crepe.setReadonly(true);
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Crepe init failed:', err);
    });

    const unsuppress = (e) => {
      if (!rootRef.current?.contains(e.target)) return;
      suppressSaveRef.current = false;
    };
    document.addEventListener('keydown', unsuppress, true);
    document.addEventListener('mousedown', unsuppress, true);

    return () => {
      document.removeEventListener('keydown', unsuppress, true);
      document.removeEventListener('mousedown', unsuppress, true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      setInnerEditor(null);
      try {
        crepe.destroy();
      } catch {
        // best-effort cleanup
      }
      crepeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (crepeRef.current) {
      crepeRef.current.setReadonly(!!readOnly);
    }
  }, [readOnly]);

  // Push active comment anchors into the highlight plugin whenever comments
  // change. Same logic as the legacy LiveEditor — top-level threads only,
  // with rangeStart for occurrence disambiguation.
  useEffect(() => {
    if (!innerEditor || !crepeRef.current) return;
    const anchors = (comments || [])
      .filter((c) => !c.parentId && !c.resolved && c.anchorText)
      .map((c) => ({ text: c.anchorText, id: c.id, rangeStart: c.rangeStart }));
    try {
      crepeRef.current.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.setMeta(commentHighlightKey, { anchors });
        view.dispatch(tr);
      });
    } catch { /* editor not ready */ }
  }, [comments, innerEditor]);

  // Go-to handler — flashes the matched anchor and scrolls it into view.
  const goToComment = useCallback((comment) => {
    const anchorText = typeof comment === 'string' ? comment : comment?.anchorText;
    const hintPos = typeof comment === 'object' && comment ? Number(comment.rangeStart || 0) : 0;
    if (!crepeRef.current || !anchorText) return;
    try {
      crepeRef.current.editor.action((ctx) => {
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

        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          try {
            crepeRef.current?.editor.action((c2) => {
              const v2 = c2.get(editorViewCtx);
              v2.dispatch(v2.state.tr.setMeta(commentHighlightKey, { flash: null }));
            });
          } catch { /* editor torn down */ }
        }, 1800);
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Go to comment failed:', e);
    }
  }, []);

  useEffect(() => {
    if (onGoToReady) onGoToReady(goToComment);
  }, [goToComment, onGoToReady]);

  // Clicking a yellow .comment-highlight in the editor opens the sidebar
  // and flashes the relevant comment card.
  useEffect(() => {
    const el = rootRef.current;
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

  // Paste handler — ported from legacy LiveEditor with the v3.9.1 priority:
  //   1. Images → upload, insert ![](url)
  //   2. Table-row HTML when cursor in table → splice rows into table
  //   3. text/plain that looks like markdown → markdownToSlice (preserves
  //      task list checkbox semantics that the HTML round-trip mangles)
  //   4. Rich text/html → htmlToMarkdown → markdownToSlice
  //   5. Fall through to Crepe's default paste
  useEffect(() => {
    const el = rootRef.current;
    if (!el || readOnly) return;

    const handlePaste = async (e) => {
      const crepe = crepeRef.current;
      if (!crepe) return;
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
              crepe.editor.action(insert(`![image](${filename})`));
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('Upload failed:', err);
            }
          }
          return;
        }
      }

      // 2. Table-row HTML splice
      const html = cb.getData('text/html');
      if (html && /<tr[\s>]/i.test(html)) {
        try {
          const handled = crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;
            const { $from } = state.selection;

            let tableNode = null;
            let tablePos = null;
            let currentRowIndex = 0;
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d);
              if (node.type.name === 'table') {
                tableNode = node;
                tablePos = $from.before(d);
                const cellNode = $from.node(d + 1);
                for (let i = 0; i < node.childCount; i++) {
                  if (node.child(i) === cellNode) { currentRowIndex = i; break; }
                }
                break;
              }
            }
            if (!tableNode) return false;

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const trs = doc.querySelectorAll('tr');
            if (trs.length === 0) return false;

            const pastedRows = [];
            for (const tr of trs) {
              const cells = [];
              for (const cell of tr.querySelectorAll('th, td')) {
                cells.push(cell.textContent.trim());
              }
              if (cells.length > 0) pastedRows.push(cells);
            }
            if (pastedRows.length === 0) return false;

            const colCount = tableNode.child(0).childCount;
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

            let insertPos = tablePos + 1;
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
          // eslint-disable-next-line no-console
          console.error('Table row paste failed:', err);
        }
      }

      // 3/4. Markdown via slice (preserves task-list semantics)
      const pasteMarkdown = (md) => {
        if (!md) return false;
        let inserted = false;
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const slice = markdownToSlice(md)(ctx);
          if (!slice) return;
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          inserted = true;
        });
        return inserted;
      };

      const text = cb.getData('text/plain');
      if (text && looksLikeMarkdown(text)) {
        e.preventDefault();
        pasteMarkdown(text);
        return;
      }

      if (html && hasRichContent(html)) {
        e.preventDefault();
        pasteMarkdown(htmlToMarkdown(html));
        return;
      }
      // 5. otherwise fall through to Crepe's default paste
    };

    el.addEventListener('paste', handlePaste, true);
    return () => el.removeEventListener('paste', handlePaste, true);
  }, [ns, currentPath, readOnly]);

  return (
    <div className="live-editor-pane">
      {readOnly && <div className="editor-readonly-bar">Read-only</div>}
      {!readOnly && <LiveToolbar editor={innerEditor} />}
      <div ref={rootRef} className="live-editor-crepe-root" />
    </div>
  );
}
