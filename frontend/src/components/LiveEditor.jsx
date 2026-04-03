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
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { deleteRow, deleteColumn, deleteTable } from '@milkdown/prose/tables';
import { uploadImage } from '../api.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
import MermaidBlock from './MermaidBlock.jsx';
import MermaidViewer from './MermaidViewer.jsx';
import {
  insertTableCommand,
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
  deleteSelectedCellsCommand,
} from '@milkdown/preset-gfm';

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
  const isUpdatingRef = useRef(false);

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
          if (isUpdatingRef.current) return;
          if (markdown !== prevMarkdown) {
            lastLocalContent.current = markdown;
            if (onChange) onChange(markdown);
          }
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(history)
      .use(clipboard)
      .use(mermaidNodeView)
      .use(clearEmptyBlockPlugin);
  }, [readOnly]);

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
    isUpdatingRef.current = true;
    try {
      editorRef.current.action(replaceAll(content || ''));
      lastLocalContent.current = content;
    } catch (e) { /* editor not ready */ }
    isUpdatingRef.current = false;
  }, [content]);

  return <Milkdown />;
}

function TableToolbar({ editor }) {
  if (!editor) return null;
  const cmd = (command, payload) => {
    try { editor.action(callCommand(command.key, payload)); } catch (e) {}
  };
  // Direct ProseMirror command via editor view
  const proseCmd = (pmCommand) => {
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        pmCommand(view.state, view.dispatch);
      });
    } catch (e) {}
  };
  return (
    <div className="table-toolbar">
      <button onClick={() => cmd(insertTableCommand, { row: 3, col: 3 })} title="Insert table">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
      </button>
      <span className="table-toolbar-sep" />
      <button onClick={() => cmd(addRowBeforeCommand)} title="Add row above">&#8593; Row</button>
      <button onClick={() => cmd(addRowAfterCommand)} title="Add row below">&#8595; Row</button>
      <button onClick={() => cmd(addColBeforeCommand)} title="Add column left">&#8592; Col</button>
      <button onClick={() => cmd(addColAfterCommand)} title="Add column right">&#8594; Col</button>
      <span className="table-toolbar-sep" />
      <button className="danger" onClick={() => proseCmd(deleteRow)} title="Delete current row">Del Row</button>
      <button className="danger" onClick={() => proseCmd(deleteColumn)} title="Delete current column">Del Col</button>
      <button className="danger" onClick={() => proseCmd(deleteTable)} title="Delete entire table">Del Table</button>
    </div>
  );
}

function LiveEditor({ content, onChange, currentPath, ns, readOnly }) {
  const [editor, setEditor] = useState(null);
  const [viewerSvg, setViewerSvg] = useState(null);
  const wrapperRef = useRef(null);

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

      // 2. Rich HTML → convert to markdown then insert as parsed nodes
      const html = cb.getData('text/html');
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

  return (
    <div className="live-editor-pane">
      {readOnly && <div className="editor-readonly-bar">Read-only</div>}
      {!readOnly && <TableToolbar editor={editor} />}
      <div className="live-editor-wrapper" ref={wrapperRef}>
        <MilkdownProvider>
          <MilkdownEditor
            content={content}
            onChange={onChange}
            readOnly={readOnly}
            onEditorReady={setEditor}
          />
        </MilkdownProvider>
      </div>
      {viewerSvg && (
        <MermaidViewer svgContent={viewerSvg} onClose={() => setViewerSvg(null)} />
      )}
    </div>
  );
}

export default LiveEditor;
