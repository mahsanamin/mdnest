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
import { createRoot } from 'react-dom/client';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, nodeViewCtx, SchemaReady } from '@milkdown/core';
import { TextSelection } from '@milkdown/prose/state';
import { insert, markdownToSlice, replaceAll } from '@milkdown/utils';
import { uploadImage } from '../api.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
import { looksLikeMarkdown } from '../markdown-utils.js';
import MermaidBlock from './MermaidBlock.jsx';
import MermaidViewer from './MermaidViewer.jsx';
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

// Detect plain text that looks like mermaid diagram source. Strict on
// purpose:
//   - The WHOLE pasted text (after stripping leading blank lines) must
//     start with a mermaid diagram-type declaration. No /m flag — a doc
//     that just happens to contain words like "pie", "journey", "gantt",
//     or "timeline" at a line start in the middle of prose should NOT
//     be wrapped in a mermaid fence.
//   - Diagram-type tokens that are also common English words ("pie",
//     "journey", "gantt", "timeline", "mindmap") additionally require
//     either end-of-line / end-of-string OR mermaid-specific syntax
//     immediately after, so "pie chart shows…" or "user journey through
//     the funnel" don't trigger.
//   - Multi-block diagrams (anything with markdown-style headings) bail
//     out — if the text also looks like markdown, treat it as markdown.
const MERMAID_PREFIX_RE = /^[\s\n]*(graph\s+(TD|LR|BT|RL|TB)\b|flowchart\s+(TD|LR|BT|RL|TB)\b|sequenceDiagram\b|classDiagram\b|stateDiagram(-v2)?\b|erDiagram\b|requirementDiagram\b|gitGraph\b|quadrantChart\b|xychart-beta\b|sankey-beta\b|block-beta\b|C4(Context|Container|Component|Dynamic|Deployment)\b|(gantt|pie|journey|mindmap|timeline)(\s+title\b|\s*$|\s*\n))/;
const MARKDOWN_HEADING_OR_TABLE_RE = /^\s*(#{1,6}\s|\|.*\|)/m;
function looksLikeMermaid(text) {
  if (!text) return false;
  // If the paste also contains markdown headings or table rows, it's not
  // a mermaid source paste — it's a document that happens to have
  // mermaid-keyword English words in it.
  if (MARKDOWN_HEADING_OR_TABLE_RE.test(text)) return false;
  return MERMAID_PREFIX_RE.test(text);
}

// Build the MermaidBlock-React node view for a single `code_block` node.
function makeMermaidNodeView(node, view, getPos) {
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
          const pos = getPos();
          if (pos == null) return;
          const tr = view.state.tr;
          const nodeAt = view.state.doc.nodeAt(pos);
          if (!nodeAt) return;
          tr.replaceWith(
            pos + 1,
            pos + 1 + nodeAt.content.size,
            newSource ? view.state.schema.text(newSource) : view.state.schema.text(''),
          );
          view.dispatch(tr);
        }}
        onFullscreen={(svg) => {
          dom.dispatchEvent(new CustomEvent('mermaid-fullscreen', { detail: svg, bubbles: true }));
        }}
      />,
    );
  };

  render(currentSource);

  return {
    dom,
    stopEvent: () => true,
    ignoreMutation: () => true,
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
      try { root.unmount(); } catch { /* best-effort */ }
    },
  };
}

// Composing plugin: replaces the existing `code_block` nodeView in
// nodeViewCtx with one that delegates to MermaidBlock for language=mermaid
// and falls through to whatever Crepe registered (the CodeMirror nodeView)
// for everything else. Runs after SchemaReady so Crepe's $view has already
// written its entry — we read it, wrap it, write a new entry that supersedes
// it (Object.fromEntries uses last-wins for duplicate keys).
const composedMermaidPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady);
  const entries = ctx.get(nodeViewCtx);
  // Find the existing factory (Crepe's CodeMirror code-block view)
  let crepeFactory = null;
  for (const [id, factory] of entries) {
    if (id === 'code_block') crepeFactory = factory;
  }
  const composedFactory = (node, view, getPos, decorations) => {
    const lang = node.attrs.language || '';
    if (lang === 'mermaid') return makeMermaidNodeView(node, view, getPos);
    if (crepeFactory) return crepeFactory(node, view, getPos, decorations);
    return {};
  };
  ctx.update(nodeViewCtx, (ps) => [...ps, ['code_block', composedFactory]]);
  return () => {
    ctx.update(nodeViewCtx, (ps) => ps.filter(([, f]) => f !== composedFactory));
  };
};

export default function LiveEditorCrepe({
  content,
  onChange,
  readOnly,
  ns,
  currentPath,
  comments,
  onComment,
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
  // Last markdown we serialized OUT of the editor. Used to skip the
  // content-prop sync effect for our own saves (avoid replaceAll loops).
  const lastLocalContentRef = useRef(content);
  // Floating "💬 Comment" button shown when the user selects text inside
  // the editor. Position is in pixels relative to the wrapper.
  const [selectionPopup, setSelectionPopup] = useState(null);
  // Fullscreen mermaid viewer modal — opened when the MermaidBlock expand
  // button dispatches the `mermaid-fullscreen` custom event from the node view.
  const [viewerSvg, setViewerSvg] = useState(null);

  useEffect(() => {
    if (!rootRef.current) return;
    if (content === null || content === undefined) return;

    // Image upload — mdnest stores uploads next to the note. The markdown
    // bytes hold just the filename (e.g. `![](photo.png)`); the rendered
    // <img src=> is resolved to the absolute `/api/files/<ns>/<dir>/<file>`
    // URL via proxyDomURL below.
    const uploadHandler = async (file) => {
      if (!ns || !currentPath) return '';
      try {
        const data = await uploadImage(ns, currentPath, file);
        return (data.url || file.name).split('/').pop();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Image upload failed:', err);
        return '';
      }
    };
    const proxyDomURL = (url) => {
      if (!url) return url;
      if (/^(https?:|data:|blob:|\/)/i.test(url)) return url;
      const dir = currentPath ? currentPath.split('/').slice(0, -1).join('/') : '';
      const prefix = dir ? `${ns}/${dir}` : ns;
      return `/api/files/${prefix}/${url}`;
    };

    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: content,
      features: {
        // Disable Crepe's floating selection toolbar — we render our own
        // persistent <LiveToolbar> above the editor.
        toolbar: false,
        // KEEP `code-mirror` enabled: Crepe's `latex` feature hard-depends
        // on it (throws "You need to enable CodeMirror to use LaTeX feature"
        // at create() time otherwise). We instead override the code_block
        // nodeView for mermaid blocks specifically — see mermaidNodeView
        // below, which is registered AFTER Crepe so its $view writes the
        // last entry to nodeViewCtx → Object.fromEntries() keeps OURS.
        // Mermaid blocks render as MermaidBlock; other code blocks still
        // use Crepe's CodeMirror UI (so we keep CodeMirror UX for code,
        // and LaTeX continues to work).
      },
      featureConfigs: {
        'image-block': {
          onUpload: uploadHandler,
          blockOnUpload: uploadHandler,
          inlineOnUpload: uploadHandler,
          proxyDomURL,
        },
      },
    });

    // Custom plugins layered onto the underlying Milkdown editor. Wrap each
    // .use() in its own try/catch so a single misbehaving plugin doesn't
    // poison the chain (and the editor) — the previous attempt to chain
    // every .use() together collapsed the entire editor when one of them
    // failed to register at the SchemaReady boundary.
    const tryUse = (plugin, name) => {
      try {
        crepe.editor.use(plugin);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[Crepe] failed to register ${name}:`, err);
      }
    };
    tryUse(commentHighlightPlugin, 'commentHighlightPlugin');
    tryUse(clearEmptyBlockPlugin, 'clearEmptyBlockPlugin');
    tryUse(tableCellCheckboxPlugin, 'tableCellCheckboxPlugin');
    tryUse(composedMermaidPlugin, 'composedMermaidPlugin');

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prev) => {
        lastLocalContentRef.current = markdown;
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

  // External content sync (live-collab broadcast, history restore). When the
  // `content` prop drifts from what we last serialized, replace the editor's
  // doc — same pattern as the legacy MilkdownEditor. Suppress saves through
  // the next user keystroke so the replaceAll → markdownUpdated round trip
  // doesn't fire a redundant PUT that races the incoming update.
  useEffect(() => {
    if (!innerEditor || !crepeRef.current) return;
    if (content == null) return;
    if (content === lastLocalContentRef.current) return;
    suppressSaveRef.current = true;
    try {
      crepeRef.current.editor.action(replaceAll(content));
      lastLocalContentRef.current = content;
    } catch { /* editor not ready or replaceAll failed */ }
  }, [content, innerEditor]);

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

  // Floating Comment button: appears when the user selects text inside the
  // editor pane. Mirrors the legacy LiveEditor — only triggers on a
  // selection gesture that originated inside the editor, otherwise a
  // sidebar click that programmatically sets a selection would pop the
  // button at random positions.
  useEffect(() => {
    if (!innerEditor || !onComment) return;
    const checkSelection = (e) => {
      const wrapper = rootRef.current;
      if (!wrapper) return;
      if (e && e.target && !wrapper.contains(e.target)) return;
      try {
        innerEditor.action((ctx) => {
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
      } catch { /* not ready */ }
    };
    document.addEventListener('mouseup', checkSelection);
    document.addEventListener('keyup', checkSelection);
    return () => {
      document.removeEventListener('mouseup', checkSelection);
      document.removeEventListener('keyup', checkSelection);
    };
  }, [innerEditor, onComment]);

  // Listen for the `mermaid-fullscreen` custom event the MermaidBlock node
  // view dispatches when the user clicks the expand button — open the
  // viewer modal with the SVG payload.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (e) => setViewerSvg(e.detail);
    el.addEventListener('mermaid-fullscreen', handler);
    return () => el.removeEventListener('mermaid-fullscreen', handler);
  }, []);

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

      // 2b. Mermaid source detected in plain text — wrap in a ```mermaid
      // fence before pasting. Without this the source lands as a plain
      // paragraph and the user has to wrap it manually (which broke a
      // workflow we had in the legacy editor where copy-pasting a graph
      // from anywhere "just worked").
      if (text && looksLikeMermaid(text)) {
        e.preventDefault();
        pasteMarkdown('```mermaid\n' + text.replace(/\s+$/, '') + '\n```\n');
        return;
      }

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
      <div className="live-editor-wrapper" style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div ref={rootRef} className="live-editor-crepe-root" />
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
