# Excalidraw Drawings

mdnest can open `.excalidraw.md` notes in a full [Excalidraw](https://excalidraw.com/)
canvas, so hand-drawn diagrams live next to your notes — **without a database and
without leaving your files**. The markdown note is the single source of truth:
the scene is stored inside the note, and every drawing is a plain file, so it
reuses the same history, restore, comments and search as any other note.

> **Off by default.** The editor is opt-in: set `ENABLE_EXCALIDRAW=true` in
> `mdnest.conf` (then `./mdnest-server reload`) — or `excalidraw.enabled=true` in
> the Helm chart. While it is off, `.excalidraw.md` files open as plain text and
> the (large) Excalidraw bundle is never loaded, so an install that doesn't want
> drawings carries none of it. The bundle is also code-split, so it only
> downloads the first time a drawing is opened, even when the feature is on.

The format is compatible with [Obsidian's Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin),
so drawings created in either tool open in the other.

---

## Creating and editing a drawing

- **New Drawing** — in the sidebar (`+ Drawing`) or the file-tree context menu.
  It creates an empty `.excalidraw.md` (the extension is appended if you omit it)
  and opens it on a blank canvas.
- Any file whose name ends in `.excalidraw.md` (or `.excalidraw`) opens in the
  drawing editor instead of the text editor.
- Changes are auto-saved back to the note (debounced), so history, restore and
  comments work exactly as they do for text notes. Switching to another file
  flushes whatever the canvas has not written yet, so the last strokes before
  you click away are kept *(fixed in v4.2.1; they used to be discarded)*.
- Read-only when you lack write access to the note: the canvas opens in view
  mode.
- **Canvas or source** *(v4.2.1+)* — a drawing is a real markdown file, so the
  toolbar offers **Basic · Drawing**. **Drawing** is the canvas; **Basic** shows
  the markdown behind it, which is useful for inspecting the scene, fixing a
  corrupted file by hand, or copying the mirrored text elements. Live is not
  offered for drawings: the rich editor re-serializes its document model on
  every change and would reformat the scene JSON, the same hazard that forces
  Marp decks to raw editing.
- **Follows the app theme** *(v4.3.0+)* — the canvas matches mdnest rather than
  opening as a white sheet in a dark UI, and repaints as soon as you change the
  app theme. The canvas carried its own light/dark button until v4.3.0, when the
  app gained a theme of its own and that button became a near-duplicate of the
  one in the toolbar. The theme is a viewing preference and is **never written
  into the note**, so the file stays portable (Obsidian reads the same bytes) and
  two people can view the same drawing with different themes.

---

## Embedding a drawing in a note

Reference a drawing from any markdown note with a normal image embed:

```markdown
![Architecture](diagrams/system.excalidraw.md)
```

The referenced drawing renders inline as a **read-only SVG** in the preview. The
path is resolved relative to the embedding note (so `../` and a leading `/` for
the namespace root both work), and the export bundle is loaded lazily — a note
that embeds no drawing never pays for it.

---

## On-disk format

A `.excalidraw.md` note is Markdown. The words in the drawing are mirrored into a
`## Text Elements` section so the drawing stays **searchable and readable** (by
you and by AI agents over the same files), and the whole scene lives in a fenced
JSON block under `## Drawing`:

````markdown
---
excalidraw-plugin: parsed
tags: [excalidraw]
---

# Excalidraw Data

## Text Elements
Frontend ^abc123

Backend ^def456

## Drawing
```json
{ "type": "excalidraw", "version": 2, "elements": [ ... ], "appState": { ... }, "files": { ... } }
```
%%
````

Because it is a plain `.md` file it is indexed by search like any other note.
On save, deleted elements (kept only for in-session undo) and any embedded image
no element still references are pruned, so the file stays small.

---

## Shared shape libraries (operator-configured)

Operators can preload organisation-wide Excalidraw **libraries** (reusable shape
sets) into every drawing — no per-user import needed. Set a comma-separated list
of `.excalidrawlib` URLs:

- **Helm:** `excalidraw.libraries` (a YAML list of URLs).
- **compose / `mdnest.conf`:** `EXCALIDRAW_LIBRARIES=<url>,<url>`.

The URLs must be reachable by the browser (CORS-enabled or same-origin). Both the
v1 (`library`) and v2 (`libraryItems`) `.excalidrawlib` formats are supported; a
library that fails to load is skipped so one bad URL can't blank the picker.
Browse the public set at [libraries.excalidraw.com](https://libraries.excalidraw.com/),
which serves the raw files from GitHub with permissive CORS.

---

## Collaboration

Drawings ride the same per-file WebSocket channel as notes. Concurrent editing
uses **last-write-wins with a conflict warning** (v1): when someone else saves
the drawing you have open, the canvas reloads to their version if you have no
unsaved strokes, and otherwise raises the same conflict banner as text notes so
you can reload before your next stroke rather than silently overwriting theirs.
Live, merge-as-you-draw canvas collaboration is intentionally out of scope for
this version.

---

## Enabling

| Surface | Setting |
| --- | --- |
| Env / `mdnest.conf` / compose | `ENABLE_EXCALIDRAW=true` (+ optional `EXCALIDRAW_LIBRARIES=<urls>`) |
| Helm | `excalidraw.enabled=true` (+ optional `excalidraw.libraries=[...]`) |

Independent of `auth.mode`; works in both single and multi mode.
