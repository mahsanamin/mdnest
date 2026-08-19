import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, Footer } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { parseExcalidraw, serializeExcalidraw } from '../excalidraw';
import { useTheme } from '../useTheme.js';


// loadLibraries fetches operator-configured .excalidrawlib URLs and flattens
// them into Excalidraw library items (supporting both the v2 `libraryItems`
// shape and the v1 `library` array-of-element-arrays). A bad URL is skipped so
// one broken library can't blank the picker.
async function loadLibraries(urls) {
  const items = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data.libraryItems)) {
        items.push(...data.libraryItems);
      } else if (Array.isArray(data.library)) {
        data.library.forEach((elements, i) => {
          items.push({ status: 'published', id: `${url}#${i}`, created: Date.now(), elements });
        });
      }
    } catch {
      // skip an unreachable / malformed library
    }
  }
  return items;
}

// ExcalidrawEditor edits a `.excalidraw.md` note as a drawing. The note content
// is the source of truth: it is parsed once for the initial scene (the file is
// remounted per note via a key upstream), and scene changes are debounced and
// serialized back to the same markdown, so save/history/comments all reuse the
// normal note machinery. `libraries` are operator-provided default library URLs.
export default function ExcalidrawEditor({ content, onChange, readOnly, docPath, libraries, registerFlush }) {
  const initialData = useMemo(() => {
    const libraryItems = libraries && libraries.length ? loadLibraries(libraries) : undefined;
    const scene = parseExcalidraw(content);
    if (!scene) return { appState: { viewModeEnabled: !!readOnly }, libraryItems };
    return {
      elements: scene.elements,
      appState: { ...scene.appState, viewModeEnabled: !!readOnly },
      files: scene.files,
      libraryItems,
      scrollToContent: true,
    };
    // content is initial-only (parent remounts per note); ignore later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath]);

  const timer = useRef(null);
  // The most recent scene the debounce has not yet handed to onChange. Kept so
  // the parent can drain it before navigating away.
  const pending = useRef(null);

  const handleChange = useCallback((elements, appState, files) => {
    if (!onChange) return;
    pending.current = { elements, appState, files };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const scene = pending.current;
      pending.current = null;
      if (scene) onChange(serializeExcalidraw(scene));
    }, 500);
  }, [onChange]);

  // Hand the debounced-but-unsaved scene to the parent on demand.
  //
  // Switching notes used to lose the last strokes: this component debounces
  // for 500ms before calling onChange, and the app dropped the file's queued
  // save on navigation — so a click on another file within that window threw
  // the work away. A new drawing could stay 0 bytes on disk.
  //
  // The parent calls this BEFORE it changes currentPath. Flushing from the
  // unmount cleanup instead would be actively harmful: by then the app has
  // moved on, and this scene's markdown would be applied to the next file.
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const scene = pending.current;
    pending.current = null;
    if (scene && onChange) onChange(serializeExcalidraw(scene));
  }, [onChange]);

  useEffect(() => {
    if (!registerFlush) return undefined;
    registerFlush(flush);
    return () => registerFlush(null);
  }, [registerFlush, flush]);

  // Drop a still-pending debounce on unmount. Without this the stray timer
  // fires after the app has opened another note and pushes this drawing's
  // content at it.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // A drawing opens in the app's theme, so it does not arrive as a white sheet
  // in the middle of a dark UI (or the reverse). This is a *viewing*
  // preference and is deliberately not written into the note: the file stays
  // portable (Obsidian reads the same bytes) and two people can view one
  // drawing with different themes. Excalidraw paints the canvas from this
  // prop; the stored viewBackgroundColor is untouched.
  //
  // The per-drawing override still exists — a dark diagram is sometimes worth
  // reading light — but it is now an override OF the app theme rather than an
  // independent setting, and it is not persisted. Before there was an app
  // theme this had to remember its own choice; keeping that would mean a
  // switch to light mode left drawings stuck dark with no obvious cause.
  const appTheme = useTheme();
  const [override, setOverride] = useState(null);
  const theme = override || appTheme;

  // Following the app again after it changes is the expected behaviour: the
  // override is "show me this one differently", not "stop following".
  useEffect(() => { setOverride(null); }, [appTheme]);

  const toggleTheme = useCallback(() => {
    setOverride(theme === 'dark' ? 'light' : 'dark');
  }, [theme]);

  return (
    <div className="excalidraw-host">
      <Excalidraw
        initialData={initialData}
        viewModeEnabled={!!readOnly}
        theme={theme}
        onChange={readOnly ? undefined : handleChange}
      >
        {/* Render inside Excalidraw's own Footer slot rather than floating a
            button over the canvas. An absolutely-positioned control has to
            guess at free space and gets it wrong: the first attempt sat on top
            of their help button in the bottom-right corner. The slot is laid
            out by Excalidraw next to the zoom controls, so it cannot collide,
            and it keeps working if they rearrange their chrome. Excalidraw's
            own menu has no theme item, so this control has to exist. */}
        <Footer>
          <button
            type="button"
            className="excalidraw-theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch this drawing to light mode' : 'Switch this drawing to dark mode'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
            )}
          </button>
        </Footer>
      </Excalidraw>
    </div>
  );
}
