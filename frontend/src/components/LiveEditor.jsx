import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { uploadImage } from '../api.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
import MermaidBlock from './MermaidBlock.jsx';
import MermaidViewer from './MermaidViewer.jsx';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { replaceAll } from '@milkdown/utils';
import { callCommand } from '@milkdown/utils';
import {
  insertTableCommand,
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
  deleteSelectedCellsCommand,
} from '@milkdown/preset-gfm';

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
      .use(clipboard);
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
    try {
      editor.action(callCommand(command.key, payload));
    } catch (e) { /* command may not be available */ }
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
      <button className="danger" onClick={() => cmd(deleteSelectedCellsCommand)} title="Delete selected cells">Delete</button>
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
      const clipboard = e.clipboardData;
      if (!clipboard) return;

      // Check for images
      for (const item of clipboard.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file && ns && currentPath) {
            try {
              const data = await uploadImage(ns, currentPath, file);
              const filename = (data.url || file.name).split('/').pop();
              // Insert image markdown — the editor will re-serialize
              if (editor) {
                const md = `![image](${filename})`;
                document.execCommand('insertText', false, md);
              }
            } catch (err) { console.error('Upload failed:', err); }
          }
          return;
        }
      }

      // Check for rich HTML
      const html = clipboard.getData('text/html');
      if (html && hasRichContent(html)) {
        e.preventDefault();
        const md = htmlToMarkdown(html);
        document.execCommand('insertText', false, md);
      }
    };

    el.addEventListener('paste', handlePaste, true);
    return () => el.removeEventListener('paste', handlePaste, true);
  }, [editor, ns, currentPath, readOnly]);

  // Render mermaid blocks separately below the editor
  // Instead of injecting into Milkdown's DOM (which gets wiped on re-render),
  // extract mermaid sources from the content and render them as standalone blocks.
  const mermaidBlocks = useMemo(() => {
    if (!content) return [];
    const blocks = [];
    const regex = /```mermaid\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      blocks.push({ source: match[1].trim(), index: match.index });
    }
    return blocks;
  }, [content]);

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
        {mermaidBlocks.length > 0 && (
          <div className="live-mermaid-blocks">
            {mermaidBlocks.map((block, i) => (
              <MermaidBlock
                key={`${block.index}-${i}`}
                source={block.source}
                readOnly={readOnly}
                onChange={(newSource) => {
                  if (!onChange) return;
                  // Replace the mermaid block in the content
                  const newContent = content.replace(
                    `\`\`\`mermaid\n${block.source}\n\`\`\``,
                    `\`\`\`mermaid\n${newSource}\n\`\`\``
                  );
                  if (newContent !== content) onChange(newContent);
                }}
                onFullscreen={setViewerSvg}
              />
            ))}
          </div>
        )}
      </div>
      {viewerSvg && (
        <MermaidViewer svgContent={viewerSvg} onClose={() => setViewerSvg(null)} />
      )}
    </div>
  );
}

export default LiveEditor;
