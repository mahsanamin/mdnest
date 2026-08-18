import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { parseExcalidraw, serializeExcalidraw } from '../excalidraw';

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

  return (
    <div className="excalidraw-host">
      <Excalidraw
        initialData={initialData}
        viewModeEnabled={!!readOnly}
        onChange={readOnly ? undefined : handleChange}
      />
    </div>
  );
}
