import { useRef, useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark, codeBlockSchema } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { replaceAll, callCommand, $view, insert, $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { deleteRow, deleteColumn, deleteTable } from '@milkdown/prose/tables';
import { uploadImage } from '../api.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
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
const commentHighlightKey = new PluginKey('comment-highlight');

function buildCommentDecorations(doc, anchors) {
  if (!anchors || anchors.length === 0) return DecorationSet.empty;
  const decorations = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const text = anchor?.text;
    if (!text || text.length < 2) continue;
    doc.descendants((node, nodePos) => {
      if (!node.isText) return;
      const nodeText = node.text || '';
      let startIdx = 0;
      while (true) {
        const idx = nodeText.indexOf(text, startIdx);
        if (idx < 0) break;
        const from = nodePos + idx;
        const to = from + text.length;
        const key = `${from}-${to}`;
        if (!seen.has(key)) {
          seen.add(key);
          decorations.push(Decoration.inline(from, to, { class: 'comment-highlight' }));
        }
        startIdx = idx + 1;
      }
    });
  }
  return DecorationSet.create(doc, decorations);
}

const commentHighlightPlugin = $prose(() => {
  return new Plugin({
    key: commentHighlightKey,
    state: {
      init() {
        return { anchors: [], decorations: DecorationSet.empty };
      },
      apply(tr, old) {
        const meta = tr.getMeta(commentHighlightKey);
        if (meta && Array.isArray(meta.anchors)) {
          return { anchors: meta.anchors, decorations: buildCommentDecorations(tr.doc, meta.anchors) };
        }
        if (tr.docChanged) {
          return { anchors: old.anchors, decorations: buildCommentDecorations(tr.doc, old.anchors) };
        }
        return old;
      },
    },
    props: {
      decorations(state) {
        const s = this.getState(state);
        return s ? s.decorations : null;
      },
    },
  });
});

// Plugin: auto-convert empty block nodes (heading, blockquote) to paragraph on backspace
const clearEmptyBlockPlugin = $prose((ctx) => {
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

// ProseMirror node view for mermaid code blocks
// Renders MermaidBlock React component in place of the <pre> element
const mermaidNodeView = $view(codeBlockSchema.node, (ctx) => {
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
      .use(commentHighlightPlugin);
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

function LiveEditor({ content, onChange, currentPath, ns, readOnly, onComment, comments, onGoToReady }) {
  const [editor, setEditor] = useState(null);
  const [viewerSvg, setViewerSvg] = useState(null);
  const wrapperRef = useRef(null);
  const [selectionPopup, setSelectionPopup] = useState(null); // {top, left, text, start, end}

  // Track text selection for comment button
  useEffect(() => {
    if (!editor || !onComment) return;
    const checkSelection = () => {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = view.state.selection;
          if (to - from < 3) { setSelectionPopup(null); return; }

          const selectedText = view.state.doc.textBetween(from, to, ' ');
          if (!selectedText.trim()) { setSelectionPopup(null); return; }

          // Get screen coordinates of the selection end
          const coords = view.coordsAtPos(to);
          const wrapper = wrapperRef.current;
          if (!wrapper) { setSelectionPopup(null); return; }
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

      // 3. Rich HTML → convert to markdown then insert as parsed nodes
      if (html && hasRichContent(html)) {
        e.preventDefault();
        const md = htmlToMarkdown(html);
        if (editor) editor.action(insert(md));
        return;
      }

      // 3. Plain text that contains markdown syntax → insert as parsed nodes
      const text = cb.getData('text/plain');
      if (text && editor && /^[\s]*[#\-*>|`\[]/.test(text)) {
        e.preventDefault();
        editor.action(insert(text));
        return;
      }
      // Otherwise: default Milkdown paste
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
    const anchors = (comments || [])
      .filter((c) => !c.parentId && !c.resolved && c.anchorText)
      .map((c) => ({ text: c.anchorText, id: c.id }));
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
  const goToComment = useCallback((comment) => {
    const anchorText = typeof comment === 'string' ? comment : comment?.anchorText;
    const hintPos = typeof comment === 'object' && comment ? Number(comment.rangeStart || 0) : 0;
    if (!editor || !anchorText) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const matches = [];
        view.state.doc.descendants((node, nodePos) => {
          if (!node.isText) return;
          const nodeText = node.text || '';
          let startIdx = 0;
          while (true) {
            const idx = nodeText.indexOf(anchorText, startIdx);
            if (idx < 0) break;
            const from = nodePos + idx;
            matches.push({ from, to: from + anchorText.length });
            startIdx = idx + 1;
          }
        });
        if (matches.length === 0) return;
        let best = matches[0];
        let bestDist = Math.abs(best.from - hintPos);
        for (const m of matches) {
          const d = Math.abs(m.from - hintPos);
          if (d < bestDist) { best = m; bestDist = d; }
        }
        const tr = view.state.tr.setSelection(
          TextSelection.create(view.state.doc, best.from, best.to)
        );
        view.dispatch(tr.scrollIntoView());
        view.focus();
      });
    } catch (e) {
      console.error('Go to comment failed:', e);
    }
  }, [editor]);

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
