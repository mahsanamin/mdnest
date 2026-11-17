# Frontend (React)

Rules for `frontend/`. The full explanation of each rule is in
`docs/dev/frontend.md`. Read the matching section there before changing the
code it names. Per-file traps are in `docs/codemap.md`.

## Shape of the code

- Function components with hooks. State lives in `App.jsx` (`useState`,
  `useCallback`) and goes down as props. No Redux or other state library.
- CSS: `App.css` + `index.css` (+ `TaskBoard.css`, `ChatView.css`,
  `MarpDeck.css`). No CSS modules or styled-components.
- All API calls go through `src/api.js` (JWT, 401 redirect).
- URL state is the hash: `#namespace/path/to/note.md`.
- Two editors: Basic (`Editor.jsx`, textarea) and Live (`LiveEditorCrepe.jsx`,
  Milkdown Crepe, lazy-loaded). Both take the same `content`/`onChange` props.
- Mobile breakpoint 768px; the sidebar becomes an overlay.
- No SSR, no heavy editor libraries beyond what Crepe brings.

## Hard rules

- **Colors only through tokens** in `src/theme.css`, defined in both theme
  blocks. No hex literals in CSS. A new light-mode color must pass the contrast
  test (`__tests__/theme-contrast.test.js`).
- **Every rendered HTML/SVG goes through `src/sanitize.js`**
  (`sanitizeHtml`, `sanitizeSvg`). Note bodies are user-written and shared.
- **marked v15:** register renderers with `new Marked().use({renderer})`, never
  `new marked.Renderer()` or the per-call `renderer` option.
- **Every `React.lazy()`** sits inside `ChunkErrorBoundary` (or
  `EditorErrorBoundary`) and loads through `loadWithRetry`.
- **Navigation flushes a queued autosave, never cancels it**, and the flush runs
  before the next `getNote()`.
- **Wikilinks stay literal `[[...]]`** in the saved bytes; do not add a schema node.
- **A command the UI tells people to run must paste cleanly**: no `<angle
  brackets>`, use stand-ins like `mdnest_yourtoken`.
- **A flex item that must scroll needs `min-width: 0`**; the file toolbar wraps
  and never overflows.
- **Imperatively drawn surfaces** (mermaid, Excalidraw) must list the theme in
  their effect dependencies (`useTheme()`).

## Live editing and shared editing

Autosave, outside-change merging, the Live editor's binding to the shared room,
and the one-websocket-per-visit protocol are subtle and covered by specific
browser specs. Before changing `App.jsx` save paths, `LiveEditorCrepe.jsx`,
`live-editor-plugins.jsx`, `sharedDoc.js`, `sharedText.js`, `collab.js`,
`caret.js` or `tree-refresh.js`, read "Live editing, shared editing and outside
changes" in `docs/dev/frontend.md` in full.

## Testing

`npm test` (vitest) in `frontend/`. UI changes also need a Playwright spec in
`tests/browser/`; see `tests/AGENTS.md`.
