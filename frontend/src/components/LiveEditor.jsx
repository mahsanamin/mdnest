import { useRef, useEffect, useCallback } from 'react';
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/core';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { replaceAll, getMarkdown } from '@milkdown/utils';

function MilkdownEditor({ content, onChange, readOnly, onReady }) {
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

        // Listen for content changes
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

  // Store editor reference
  useEffect(() => {
    if (get) {
      const editor = get();
      if (editor) {
        editorRef.current = editor;
        if (onReady) onReady(editor);
      }
    }
  }, [get, onReady]);

  // Sync external content changes into the editor
  useEffect(() => {
    if (!editorRef.current) return;
    if (content === lastLocalContent.current) return;

    // External change — update editor without triggering onChange loop
    isUpdatingRef.current = true;
    try {
      editorRef.current.action(replaceAll(content || ''));
      lastLocalContent.current = content;
    } catch (e) {
      // Editor may not be ready yet
    }
    isUpdatingRef.current = false;
  }, [content]);

  return <Milkdown />;
}

function LiveEditor({ content, onChange, currentPath, ns, readOnly }) {
  return (
    <div className="live-editor-pane">
      {readOnly && <div className="editor-readonly-bar">Read-only</div>}
      <div className="live-editor-wrapper">
        <MilkdownProvider>
          <MilkdownEditor
            content={content}
            onChange={onChange}
            readOnly={readOnly}
          />
        </MilkdownProvider>
      </div>
    </div>
  );
}

export default LiveEditor;
