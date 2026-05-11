// LiveEditorCrepe — Phase 0 spike of the v3.10.0 Crepe migration.
//
// Mounted ONLY when import.meta.env.VITE_USE_CREPE === 'true'. Default
// flag is off, so production users see the existing <LiveEditor> at
// LiveEditor.jsx untouched. This component is a side-by-side
// implementation so we can dogfood the new editor without risking the
// existing flow.
//
// Phase 0 scope (this file, today):
//   - Mount a Crepe instance with the user's content as defaultValue.
//   - Wire markdownUpdated → onChange so autosave still fires.
//   - Cleanup via crepe.destroy() on unmount.
//   - Disable Crepe's toolbar feature (we keep our own <LiveToolbar>).
//   - NO custom plugins yet — phases 1-3 add comment/mermaid/etc.
//
// Per-note re-mount: App.jsx already passes key={ns/path} to whichever
// editor component is rendered, so React unmounts + remounts on note
// switch. We don't have to handle prop changes manually inside this
// component — the key prop guarantees a fresh Crepe instance per note,
// which is the simpler integration (Crepe's internals are Vue-based;
// we treat the whole mount as opaque from React's perspective).

import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
// Common base CSS for each Crepe feature. We import the layout/structure
// stylesheets but NOT a color theme (frame.css / nord.css / etc.) — the
// color variables get defined under .milkdown in App.css with our
// Catppuccin Mocha palette so the editor blends with the rest of mdnest.
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
}) {
  const rootRef = useRef(null);
  const crepeRef = useRef(null);
  // onChange in a ref so the Crepe listener (captured once at create
  // time) always calls the latest version. Same trick the existing
  // MilkdownEditor uses to avoid stale closures.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // suppressSave starts true so the initial markdownUpdated event
  // (which fires right after Crepe parses defaultValue) doesn't trigger
  // a redundant autosave / collab broadcast. Cleared on first real user
  // interaction. Same pattern as the legacy editor.
  const suppressSaveRef = useRef(true);

  useEffect(() => {
    if (!rootRef.current) return;
    // null content means "no note loaded" — App.jsx gates this via the
    // currentPath check, but defensively skip mount.
    if (content === null || content === undefined) return;

    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: content,
      // Keep our own toolbar surface and the Catppuccin-themed top bar.
      // Crepe's `toolbar` is a floating selection bar that would compete
      // with our <LiveToolbar>; disable it for now and revisit in a
      // later phase if we want to migrate.
      features: {
        toolbar: false,
      },
    });

    // Register the change listener BEFORE create() so it's installed
    // during editor configuration (the on() implementation falls
    // through to runtime registration after create, but pre-registering
    // is the documented path).
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
      // Don't let a Crepe init error tear down the React tree; surface
      // to console so devs can see it during the spike, but keep going.
      // The legacy <LiveEditor> remains as the fallback for users not
      // on the feature flag.
      // eslint-disable-next-line no-console
      console.error('Crepe init failed:', err);
    });

    // Unsuppress on first real user interaction. Mirrors MilkdownEditor's
    // approach — keydown/mousedown anywhere in the editor area means the
    // user typed; markdownUpdated from that point on is "real" and
    // should fire onChange.
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
        // best-effort cleanup; if Crepe is mid-init we may get a benign
        // throw, which we swallow rather than surface to the user.
      }
      crepeRef.current = null;
    };
    // We deliberately exclude `content` from deps. Crepe is constructed
    // ONCE per mount with defaultValue=content; subsequent content
    // changes from collab / external sources are handled by remounting
    // the component (via App.jsx's `key={ns/path}` prop on note switch,
    // and via setContent(null) → setContent(newText) on collab
    // 'content' messages which trigger React to re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Readonly toggle if the prop flips without a remount.
  useEffect(() => {
    if (crepeRef.current) {
      crepeRef.current.setReadonly(!!readOnly);
    }
  }, [readOnly]);

  return (
    <div className="live-editor-pane live-editor-crepe">
      <div ref={rootRef} className="live-editor-content" />
    </div>
  );
}
