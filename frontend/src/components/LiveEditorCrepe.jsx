// LiveEditorCrepe — v3.10.0 Crepe-based Live editor.
//
// Mounted when import.meta.env.VITE_USE_CREPE === 'true'. Default flag is
// off; the existing <LiveEditor> at LiveEditor.jsx is used otherwise.
//
// Phase 1 status (this revision):
//   - Crepe mount with Catppuccin theming via CSS variables
//   - Save listener → onChange via crepe.on(l => l.markdownUpdated(...))
//   - Custom plugins ported via crepe.editor.use(...) after .create():
//       • mermaidNodeView      — live mermaid diagram editing
//       • clearEmptyBlockPlugin — Backspace on empty heading → paragraph
//       • commentHighlightPlugin — yellow highlights for commented text
//       • tableCellCheckboxPlugin — [ ]/[x] widgets inside table cells
//   - topLevelTaskCheckboxPlugin DELETED (Crepe's list-item feature handles it natively)
//   - Comment-anchor data wired via setMeta dispatch on prop change
//   - Mermaid fullscreen event listener bridges to MermaidViewer modal
//
// Phase 2 (next): paste handler with v3.9.1 priority + collab content sync
// Phase 3: surface our <LiveToolbar> on top of Crepe

import { useEffect, useRef, useState } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/core';
import { TextSelection } from '@milkdown/prose/state';
import MermaidViewer from './MermaidViewer.jsx';
import {
  commentHighlightKey,
  commentHighlightPlugin,
  clearEmptyBlockPlugin,
  tableCellCheckboxPlugin,
  mermaidNodeView,
  findAnchorMatches,
} from './LiveEditor.jsx';

// Common base CSS for each Crepe feature. We import layout/structure
// only — no color theme — so our Catppuccin variables on .milkdown
// (defined in App.css) are the sole palette source.
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/image-block.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/latex.css';

export default function LiveEditorCrepe({
  content,
  onChange,
  readOnly,
  comments,
  onHighlightClick,
  onGoToReady,
}) {
  const rootRef = useRef(null);
  const crepeRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mirror MilkdownEditor's suppressSave pattern: starts true so Crepe's
  // initial markdownUpdated firing (right after parsing defaultValue)
  // doesn't trigger a redundant autosave. Cleared on first real user
  // input.
  const suppressSaveRef = useRef(true);

  // Mermaid fullscreen: the node view dispatches a custom event up the
  // DOM tree when the user clicks the fullscreen button on a diagram.
  // We catch it at the editor pane and render a MermaidViewer modal.
  const [fullscreenSvg, setFullscreenSvg] = useState(null);

  // Flash timer for go-to-comment highlights.
  const flashTimerRef = useRef(null);

  useEffect(() => {
    if (!rootRef.current) return;
    if (content === null || content === undefined) return;

    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: content,
      features: {
        // Disable Crepe's floating selection toolbar — we keep our own
        // top toolbar (Phase 3).
        toolbar: false,
      },
    });

    // Register the change listener BEFORE create() so it's installed
    // during editor configuration.
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
      if (readOnly) crepe.setReadonly(true);

      // Port our four custom plugins onto Crepe's underlying editor.
      // After .create() resolves the editor is fully constructed, and
      // crepe.editor.use(plugin) attaches the plugin to that instance.
      // Order matches LiveEditor.jsx's existing chain for parity.
      try {
        crepe.editor
          .use(mermaidNodeView)
          .use(clearEmptyBlockPlugin)
          .use(commentHighlightPlugin)
          .use(tableCellCheckboxPlugin);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('LiveEditorCrepe: failed to attach custom plugins:', err);
      }
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Crepe init failed:', err);
    });

    // Unsuppress on first real user interaction (keydown/mousedown
    // anywhere in the editor area). Same pattern as MilkdownEditor.
    const unsuppress = (e) => {
      if (!rootRef.current?.contains(e.target)) return;
      suppressSaveRef.current = false;
    };
    document.addEventListener('keydown', unsuppress, true);
    document.addEventListener('mousedown', unsuppress, true);

    // Bridge: the mermaidNodeView dispatches `mermaid-fullscreen`
    // events with the rendered SVG as detail. Catch at the root and
    // open the MermaidViewer modal.
    const onFs = (e) => setFullscreenSvg(e.detail || null);
    rootRef.current.addEventListener('mermaid-fullscreen', onFs);

    // Click-on-highlight handler — opens the comment sidebar on the
    // clicked thread. Pulled in from LiveEditor.jsx semantics.
    let onClick;
    if (onHighlightClick) {
      onClick = (e) => {
        const target = e.target.closest && e.target.closest('.comment-highlight');
        if (!target) return;
        const ids = (target.getAttribute('data-comment-ids') || '').split(',').filter(Boolean);
        if (ids.length === 0) return;
        onHighlightClick(ids[0]);
      };
      rootRef.current.addEventListener('click', onClick);
    }

    return () => {
      document.removeEventListener('keydown', unsuppress, true);
      document.removeEventListener('mousedown', unsuppress, true);
      if (rootRef.current) {
        rootRef.current.removeEventListener('mermaid-fullscreen', onFs);
        if (onClick) rootRef.current.removeEventListener('click', onClick);
      }
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      try {
        crepe.destroy();
      } catch {
        // best-effort cleanup
      }
      crepeRef.current = null;
    };
    // Crepe is constructed ONCE per mount with defaultValue=content;
    // content changes after that come from collab broadcasts and are
    // handled by remounting the component (key={ns/path} on parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Readonly toggle without remount.
  useEffect(() => {
    if (crepeRef.current) {
      crepeRef.current.setReadonly(!!readOnly);
    }
  }, [readOnly]);

  // Comments → plugin meta dispatch. Same shape as LiveEditor.jsx's
  // useEffect that filters top-level unresolved comments with anchor
  // text and dispatches them via setMeta on the plugin's key.
  useEffect(() => {
    const crepe = crepeRef.current;
    if (!crepe) return;
    const anchors = (comments || [])
      .filter((c) => !c.parentId && !c.resolved && c.anchorText)
      .map((c) => ({ text: c.anchorText, id: c.id, rangeStart: c.rangeStart }));
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setMeta(commentHighlightKey, { anchors }));
      });
    } catch {
      // editor may not be fully ready yet on the first mount tick;
      // the next render cycle will retry.
    }
  }, [comments]);

  // Expose a go-to-comment handler to the parent so the comment sidebar
  // can scroll the editor to a specific anchor and flash it.
  useEffect(() => {
    if (!onGoToReady) return;
    const goToComment = (comment) => {
      const crepe = crepeRef.current;
      if (!crepe) return;
      const anchorText = typeof comment === 'string' ? comment : comment?.anchorText;
      const hintPos = typeof comment === 'object' && comment ? Number(comment.rangeStart || 0) : 0;
      if (!anchorText) return;
      try {
        crepe.editor.action((ctx) => {
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
              crepe.editor.action((c2) => {
                const v2 = c2.get(editorViewCtx);
                v2.dispatch(v2.state.tr.setMeta(commentHighlightKey, { flash: null }));
              });
            } catch { /* ignore */ }
          }, 1800);
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Go to comment failed:', e);
      }
    };
    onGoToReady(goToComment);
  }, [onGoToReady]);

  return (
    <div className="live-editor-pane live-editor-crepe">
      <div ref={rootRef} className="live-editor-content" />
      {fullscreenSvg && (
        <MermaidViewer svg={fullscreenSvg} onClose={() => setFullscreenSvg(null)} />
      )}
    </div>
  );
}
