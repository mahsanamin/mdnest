import { useCallback, useMemo, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { parseExcalidraw, serializeExcalidraw } from '../excalidraw';

// ExcalidrawEditor edits a `.excalidraw.md` note as a drawing. The note content
// is the source of truth: it is parsed once for the initial scene (the file is
// remounted per note via a key upstream), and scene changes are debounced and
// serialized back to the same markdown, so save/history/comments all reuse the
// normal note machinery.
export default function ExcalidrawEditor({ content, onChange, readOnly, docPath }) {
  const initialData = useMemo(() => {
    const scene = parseExcalidraw(content);
    if (!scene) return { appState: { viewModeEnabled: !!readOnly } };
    return {
      elements: scene.elements,
      appState: { ...scene.appState, viewModeEnabled: !!readOnly },
      files: scene.files,
      scrollToContent: true,
    };
    // content is initial-only (parent remounts per note); ignore later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath]);

  const timer = useRef(null);
  const handleChange = useCallback((elements, appState, files) => {
    if (!onChange) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onChange(serializeExcalidraw({ elements, appState, files }));
    }, 500);
  }, [onChange]);

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
