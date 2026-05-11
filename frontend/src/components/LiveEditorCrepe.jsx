// LiveEditorCrepe — minimal baseline.
//
// Goal of this revision: get Crepe rendering in our app shell looking
// like the Milkdown playground, with NO customizations. Once this
// renders cleanly (verified visually by the user), we layer features
// back on incrementally — each layer verified before the next.
//
// What this baseline does:
//   - new Crepe({ root, defaultValue }).create()
//   - markdownUpdated → onChange (autosave still works)
//   - crepe.destroy() on unmount
//
// What this baseline does NOT do (intentionally — layers in later):
//   - custom plugins (mermaid, comments, table-cell checkboxes, clearEmptyBlock)
//   - custom paste handler
//   - custom toolbar above the editor
//   - Catppuccin theme override (uses Crepe's frame-dark default for now)
//   - any wrapper class except `.live-editor-pane` (kept so App.jsx layout works)

import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';

// Crepe's frame-dark theme — full styling. Once the baseline is
// verified, we'll keep this for structural CSS and override the
// color variables on `.milkdown` to Catppuccin Mocha values.
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';

export default function LiveEditorCrepe({
  content,
  onChange,
  readOnly,
}) {
  const rootRef = useRef(null);
  const crepeRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const suppressSaveRef = useRef(true);

  useEffect(() => {
    if (!rootRef.current) return;
    if (content === null || content === undefined) return;

    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: content,
    });

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

  return <div ref={rootRef} className="live-editor-crepe-root" />;
}
