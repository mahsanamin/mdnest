// LiveEditorCrepe — Crepe-based Live editor for v3.10.0.
//
// Layered on top of @milkdown/crepe (the editor that Milkdown's playground
// uses) so we inherit the block-edit / slash menu / drag handle / native
// task-list checkboxes / CodeMirror code blocks / KaTeX math / image upload UI.
//
// Customizations on top:
//   - Mermaid: via Crepe's CodeMirror `renderPreview` hook (NOT a separate
//     $view nodeView) — mermaid blocks toggle between source-in-CodeMirror
//     and live-rendered SVG using the same affordance other code blocks get.
//   - Catppuccin Mocha palette: variable overrides on `.editor-wrapper .milkdown`
//     in App.css; we don't import any of Crepe's color themes (nord, frame, …).
//   - Comments: ported `commentHighlightPlugin` for yellow highlights on
//     anchored text + click-to-open-sidebar + goToComment(c) flash-and-scroll.
//   - `clearEmptyBlockPlugin`: Backspace on an empty heading/blockquote
//     converts it to a paragraph.
//   - `tableCellCheckboxPlugin`: literal `[ ]` / `[x]` inside table cells
//     render as interactive checkboxes (decoration-based; markdown bytes
//     unchanged on serialize).
//   - Paste handler with v3.9.1 priority — images upload first, then
//     table-row HTML splices into existing tables, then text/plain that
//     looks like markdown wins over text/html (so Obsidian's `- [ ] Foo`
//     stays a task item instead of getting flattened by the HTML round trip).
//   - `<LiveToolbar>` above the editor (Crepe's floating selection toolbar
//     is disabled via `features: { toolbar: false }`).
//
// What we DELIBERATELY drop versus the legacy LiveEditor:
//   - `topLevelTaskCheckboxPlugin` — Crepe's `list-item` feature renders
//     native SVG task checkboxes for top-level task items, which is exactly
//     what the hand-rolled plugin was trying (and visually failing) to do.
//   - The standalone `mermaidNodeView` $view — replaced by `renderPreview`.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Crepe } from '@milkdown/crepe';
import { imageSchema } from '@milkdown/preset-commonmark';
import { imageBlockSchema } from '@milkdown/components/image-block';
import { editorViewCtx, nodeViewCtx, parserCtx, serializerCtx, SchemaReady } from '@milkdown/core';
import { TextSelection, Plugin, PluginKey } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';
import { Fragment } from '@milkdown/prose/model';
import { insert, markdownToSlice, replaceAll } from '@milkdown/utils';
import { blockConfig } from '@milkdown/plugin-block';
import { uploadConfig } from '@milkdown/plugin-upload';
import { findParent } from '@milkdown/prose';
import { uploadImage } from '../api.js';
import { withDefaultImageTitle } from '../image-title-default.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
import { looksLikeMarkdown } from '../markdown-utils.js';
import { parseWikiLink, resolveWikiLink, restoreWikilinks } from '../wikilink.js';
import { splitFrontMatter, joinFrontMatter } from '../frontMatter.js';
import MermaidBlock from './MermaidBlock.jsx';
import MermaidViewer from './MermaidViewer.jsx';
import {
  commentHighlightPlugin,
  commentHighlightKey,
  findAnchorMatches,
  clearEmptyBlockPlugin,
  tableCellCheckboxPlugin,
  wikilinkDecorationPlugin,
  LiveToolbar,
} from './live-editor-plugins.jsx';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
import { markNoGrammarAssist } from '../noGrammarAssist.js';

// Detect plain text that looks like mermaid diagram source. Strict on
// purpose:
//   - The WHOLE pasted text (after stripping leading blank lines) must
//     start with a mermaid diagram-type declaration. No /m flag — a doc
//     that just happens to contain words like "pie", "journey", "gantt",
//     or "timeline" at a line start in the middle of prose should NOT
//     be wrapped in a mermaid fence.
//   - Diagram-type tokens that are also common English words ("pie",
//     "journey", "gantt", "timeline", "mindmap") additionally require
//     either end-of-line / end-of-string OR mermaid-specific syntax
//     immediately after, so "pie chart shows…" or "user journey through
//     the funnel" don't trigger.
//   - Multi-block diagrams (anything with markdown-style headings) bail
//     out — if the text also looks like markdown, treat it as markdown.
const MERMAID_PREFIX_RE = /^[\s\n]*(graph\s+(TD|LR|BT|RL|TB)\b|flowchart\s+(TD|LR|BT|RL|TB)\b|sequenceDiagram\b|classDiagram\b|stateDiagram(-v2)?\b|erDiagram\b|requirementDiagram\b|gitGraph\b|quadrantChart\b|xychart-beta\b|sankey-beta\b|block-beta\b|C4(Context|Container|Component|Dynamic|Deployment)\b|(gantt|pie|journey|mindmap|timeline)(\s+title\b|\s*$|\s*\n))/;
const MARKDOWN_HEADING_OR_TABLE_RE = /^\s*(#{1,6}\s|\|.*\|)/m;
function looksLikeMermaid(text) {
  if (!text) return false;
  // If the paste also contains markdown headings or table rows, it's not
  // a mermaid source paste — it's a document that happens to have
  // mermaid-keyword English words in it.
  if (MARKDOWN_HEADING_OR_TABLE_RE.test(text)) return false;
  return MERMAID_PREFIX_RE.test(text);
}

// Build the MermaidBlock-React node view for a single `code_block` node.
function makeMermaidNodeView(node, view, getPos) {
  const dom = document.createElement('div');
  dom.className = 'mermaid-live-container';
  dom.contentEditable = 'false';

  const root = createRoot(dom);
  let currentSource = node.textContent;

  const render = (source) => {
    root.render(
      <MermaidBlock
        source={source}
        readOnly={!view.editable}
        onChange={(newSource) => {
          const pos = getPos();
          if (pos == null) return;
          const tr = view.state.tr;
          const nodeAt = view.state.doc.nodeAt(pos);
          if (!nodeAt) return;
          tr.replaceWith(
            pos + 1,
            pos + 1 + nodeAt.content.size,
            newSource ? view.state.schema.text(newSource) : view.state.schema.text(''),
          );
          view.dispatch(tr);
        }}
        onFullscreen={(svg) => {
          dom.dispatchEvent(new CustomEvent('mermaid-fullscreen', { detail: svg, bubbles: true }));
        }}
      />,
    );
  };

  render(currentSource);

  return {
    dom,
    stopEvent: () => true,
    ignoreMutation: () => true,
    update: (updatedNode) => {
      if (updatedNode.type.name !== 'code_block') return false;
      if ((updatedNode.attrs.language || '') !== 'mermaid') return false;
      const newSource = updatedNode.textContent;
      if (newSource !== currentSource) {
        currentSource = newSource;
        render(newSource);
      }
      return true;
    },
    destroy: () => {
      try { root.unmount(); } catch { /* best-effort */ }
    },
  };
}

// Composing plugin: replaces the existing `code_block` nodeView in
// nodeViewCtx with one that delegates to MermaidBlock for language=mermaid
// and falls through to whatever Crepe registered (the CodeMirror nodeView)
// for everything else. Runs after SchemaReady so Crepe's $view has already
// written its entry — we read it, wrap it, write a new entry that supersedes
// it (Object.fromEntries uses last-wins for duplicate keys).
const composedMermaidPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady);
  const entries = ctx.get(nodeViewCtx);
  // Find the existing factory (Crepe's CodeMirror code-block view)
  let crepeFactory = null;
  for (const [id, factory] of entries) {
    if (id === 'code_block') crepeFactory = factory;
  }
  const composedFactory = (node, view, getPos, decorations) => {
    const lang = node.attrs.language || '';
    if (lang === 'mermaid') return makeMermaidNodeView(node, view, getPos);
    if (crepeFactory) return crepeFactory(node, view, getPos, decorations);
    return {};
  };
  ctx.update(nodeViewCtx, (ps) => [...ps, ['code_block', composedFactory]]);
  return () => {
    ctx.update(nodeViewCtx, (ps) => ps.filter(([, f]) => f !== composedFactory));
  };
};

// Wrap Crepe's `table` nodeView to skip its "first-click selects the
// cell" behavior. Crepe's TableNodeView.stopEvent calls handleClick
// on every mousedown/pointerdown inside a th/td, which creates a
// NodeSelection on the cell content the first time you click — so the
// caret only appears on the SECOND click. We override stopEvent to let
// plain text clicks (anywhere inside a cell that isn't a button) fall
// through to ProseMirror's normal text-cursor placement, while keeping
// the original behavior for buttons (column/row controls) and for the
// drag/drop branch.
const tableClickFixPlugin = (ctx) => async () => {
  await ctx.wait(SchemaReady);
  const entries = ctx.get(nodeViewCtx);
  let crepeTableFactory = null;
  for (const [id, factory] of entries) {
    if (id === 'table') crepeTableFactory = factory;
  }
  if (!crepeTableFactory) return () => {};

  const wrappedFactory = (node, view, getPos, decorations) => {
    const desc = crepeTableFactory(node, view, getPos, decorations);
    if (!desc) return desc;
    const origStopEvent = typeof desc.stopEvent === 'function'
      ? desc.stopEvent.bind(desc)
      : null;
    desc.stopEvent = (e) => {
      if (e.type === 'mousedown' || e.type === 'pointerdown') {
        const target = e.target;
        // Buttons inside the table (column / row controls, drag handles)
        // still need their click handlers — defer to the original.
        if (target instanceof Element && target.closest('button')) {
          return origStopEvent ? origStopEvent(e) : false;
        }
        // Plain click in a th/td: don't stop the event so ProseMirror
        // places the text caret directly instead of node-selecting the
        // whole cell content first.
        if (target instanceof HTMLElement && (target.closest('th') || target.closest('td'))) {
          return false;
        }
      }
      return origStopEvent ? origStopEvent(e) : false;
    };
    return desc;
  };

  ctx.update(nodeViewCtx, (ps) => [...ps, ['table', wrappedFactory]]);
  return () => {
    ctx.update(nodeViewCtx, (ps) => ps.filter(([, f]) => f !== wrappedFactory));
  };
};

// A block as JSON without the heading ids a plugin adds after load: a freshly
// parsed heading has id "", the live one does not, and compared as-is every
// heading looked changed.
function stripBlockIds(j) {
  let o = j;
  if (o.attrs && Object.prototype.hasOwnProperty.call(o.attrs, 'id')) o = { ...o, attrs: { ...o.attrs, id: '' } };
  if (o.content) o = { ...o, content: o.content.map(stripBlockIds) };
  return o;
}

export default function LiveEditorCrepe({
  content,
  onChange,
  readOnly,
  ns,
  currentPath,
  comments,
  onComment,
  onGoToReady,
  onHighlightClick,
  onWikiLink,
  wikiIndex,
  // The collab plugin (from the shared editing chunk) when this note can be
  // edited together. Fixed for the life of the editor: it must be registered
  // before create(). With it the editor holds the body only; front matter is
  // kept beside it and put back in front of every change it reports.
  collabPlugin,
  // The SharedSession (sharedDoc.js) for this note. It may arrive after the
  // editor is up and binds to the editor as it is then; until it is bound
  // (sharedBound) the editor saves the normal way, through onChange.
  shared,
  sharedBound,
  // Registers a function the app calls to put an outside change (the CLI, an
  // agent) into this editor: fn(base, theirs, merge) returns the text now
  // shown. The merge runs here, against the document as it is at this
  // moment, because markdownUpdated reaches the app a little late: merging
  // the app's copy dropped the newest keystrokes and moved the caret.
  registerOutsideMerge,
  // Registers a function the app calls before it navigates away
  // (flushPendingSave): it reports an edit the listener has not reported
  // yet, so the app can save it.
  registerFlush,
}) {
  const rootRef = useRef(null);
  const sharedRef = useRef(shared || null);
  sharedRef.current = shared || null;
  const isBound = () => !!(sharedRef.current && sharedRef.current.bound);
  // Body only, with the front matter kept here (see collabPlugin).
  const bodyOnlyRef = useRef(!!collabPlugin);
  const fmRef = useRef(collabPlugin ? splitFrontMatter(content || '').frontMatter : '');
  const toFull = (body) => (bodyOnlyRef.current ? joinFrontMatter(fmRef.current, body) : body);
  const paneRef = useRef(null);
  const crepeRef = useRef(null);
  // Milkdown reports a change 200 ms after the last keystroke. Switching
  // note inside that window used to drop the edit: the app's flush had no
  // save queued, and the editor's unmount cancelled the report. pendingEdit
  // marks an edit the listener has not reported yet; report is the
  // listener's own handler, so a flush runs every check it does.
  const pendingEditRef = useRef(false);
  const reportRef = useRef(null);
  const lastReportedRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWikiLinkRef = useRef(onWikiLink);
  onWikiLinkRef.current = onWikiLink;
  const wikiIndexRef = useRef(wikiIndex);
  wikiIndexRef.current = wikiIndex;
  const flashTimerRef = useRef(null);
  // LiveToolbar needs the underlying Milkdown Editor instance. Track it in
  // state so the toolbar re-renders once crepe.create() resolves.
  const [innerEditor, setInnerEditor] = useState(null);

  const suppressSaveRef = useRef(true);
  // The content value the parent last handed us. Crepe is created with
  // `defaultValue: content`, and markdownUpdated then stores the *serialized*
  // form in lastLocalContentRef — which differs from the file whenever the
  // serializer normalizes anything (`-` bullets become `*`). Comparing the
  // incoming prop against that serialized form therefore looks like a change
  // on every open and fires a redundant replaceAll, which re-arms
  // suppressSaveRef without necessarily producing another markdownUpdated to
  // consume it — and the next real edit gets swallowed. Compare against what
  // the parent actually gave us instead.
  const lastPropContentRef = useRef(null);
  // Last markdown we serialized OUT of the editor. Used to skip the
  // content-prop sync effect for our own saves (avoid replaceAll loops).
  const lastLocalContentRef = useRef(content);
  // The serialized form of the last document we injected (a remote update,
  // a restore). Milkdown's listener reports changes DEBOUNCED, so the report
  // for an injection arrives after suppressSaveRef is already disarmed and
  // looked like the user typing: the idle side of a shared note broadcast
  // live "content" (others saw it as typing) and autosaved with a stale
  // etag (a 409, the false conflict banner). A report that equals exactly
  // this text is that echo and is dropped; anything the user types differs.
  const injectedEchoRef = useRef(null);
  // Floating "💬 Comment" button shown when the user selects text inside
  // the editor. Position is in pixels relative to the wrapper.
  const [selectionPopup, setSelectionPopup] = useState(null);
  // Fullscreen mermaid viewer modal — opened when the MermaidBlock expand
  // button dispatches the `mermaid-fullscreen` custom event from the node view.
  const [viewerSvg, setViewerSvg] = useState(null);

  // Block-handle gutter toggle. Crepe reserves an ~88px left gutter for the
  // hover drag/`+` handles, which wastes a lot of width on mobile. When
  // hidden we collapse the gutter to full width via the `.handles-hidden`
  // class (the slash `/` menu is a separate widget, so it keeps working).
  // Persisted per-browser; defaults to hidden on touch devices.
  const [handlesHidden, setHandlesHidden] = useState(() => {
    try {
      const saved = localStorage.getItem('mdnest_live_handles_hidden');
      if (saved !== null) return saved === '1';
    } catch { /* ignore */ }
    // Default by capability, not width: touch devices can't hover the drag
    // handle and benefit most from full width, so hide it there by default.
    try { return window.matchMedia('(hover: none), (pointer: coarse)').matches; } catch { return false; }
  });
  const toggleHandles = useCallback(() => {
    setHandlesHidden((prev) => {
      const next = !prev;
      try { localStorage.setItem('mdnest_live_handles_hidden', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!rootRef.current) return;
    if (content === null || content === undefined) return;

    // Image upload — mdnest stores uploads next to the note. The markdown
    // bytes hold just the filename (e.g. `![](photo.png)`); the rendered
    // <img src=> is resolved to the absolute `/api/files/<ns>/<dir>/<file>`
    // URL via proxyDomURL below.
    const uploadHandler = async (file) => {
      if (!ns || !currentPath) return '';
      try {
        const data = await uploadImage(ns, currentPath, file);
        return (data.url || file.name).split('/').pop();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Image upload failed:', err);
        return '';
      }
    };
    const proxyDomURL = (url) => {
      if (!url) return url;
      if (/^(https?:|data:|blob:|\/)/i.test(url)) return url;
      const dir = currentPath ? currentPath.split('/').slice(0, -1).join('/') : '';
      const prefix = dir ? `${ns}/${dir}` : ns;
      // Append the JWT as a query param so the browser's <img src=> GET
      // (which can't set an Authorization header) authenticates against
      // /api/files. The auth middleware accepts ?token= as a fallback.
      let resolved = `/api/files/${prefix}/${url}`;
      try {
        const tok = localStorage.getItem('mdnest_token');
        if (tok) resolved += `?token=${encodeURIComponent(tok)}`;
      } catch { /* localStorage unavailable */ }
      return resolved;
    };

    lastPropContentRef.current = content;
    const crepe = new Crepe({
      root: rootRef.current,
      // Body only when the note can be edited together (front matter is
      // kept out of the editor, see collabPlugin).
      defaultValue: bodyOnlyRef.current ? splitFrontMatter(content).body : content,
      features: {
        // Disable Crepe's floating selection toolbar — we render our own
        // persistent <LiveToolbar> above the editor.
        toolbar: false,
        // KEEP `code-mirror` enabled: Crepe's `latex` feature hard-depends
        // on it (throws "You need to enable CodeMirror to use LaTeX feature"
        // at create() time otherwise). We instead override the code_block
        // nodeView for mermaid blocks specifically — see mermaidNodeView
        // below, which is registered AFTER Crepe so its $view writes the
        // last entry to nodeViewCtx → Object.fromEntries() keeps OURS.
        // Mermaid blocks render as MermaidBlock; other code blocks still
        // use Crepe's CodeMirror UI (so we keep CodeMirror UX for code,
        // and LaTeX continues to work).
      },
      featureConfigs: {
        'image-block': {
          onUpload: uploadHandler,
          blockOnUpload: uploadHandler,
          inlineOnUpload: uploadHandler,
          proxyDomURL,
        },
      },
    });

    crepe.editor.config((ctx) => {
      ctx.update(imageSchema.key, withDefaultImageTitle);
      ctx.update(imageBlockSchema.key, withDefaultImageTitle);
    });

    // Allow Crepe's upload plugin to handle pasted images even when the
    // clipboard also has text/html (which it usually does — screenshot
    // tools and browsers attach an <img> HTML representation alongside
    // the binary). Default `enableHtmlFileUploader: false` short-circuits
    // and skips the upload, which is why our previous custom paste path
    // had to do the upload manually (and ended up creating inline
    // images that bypassed proxyDomURL → broken src). With this enabled
    // and our custom image branch removed below, pasted images go
    // through Crepe's image-block schema → proxyDomURL → rendered img.
    try {
      crepe.editor.config((ctx) => {
        ctx.update(uploadConfig.key, (cfg) => ({
          ...cfg,
          enableHtmlFileUploader: true,
        }));
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Crepe] failed to override uploadConfig:', err);
    }

    // Override Crepe's block-edit filter so the drag handle anchors to the
    // table itself (not the row inside it). Crepe's default filterNodes
    // rejects any node whose ancestor is a table, which made the handle
    // skip tables entirely — visually it appeared next to the table but
    // clicking it did nothing because the BlockService had no `active`
    // node to drag. We accept the table itself and reject anything that's
    // *inside* a table (paragraph-in-cell, cell, row), so the walk-up loop
    // in select-node-by-dom climbs out of cells/rows and STOPS at the
    // outer `table` — making the whole table the drag/selection target.
    // (Previous version rejected only table_row/table_cell/table_header,
    // which still let the walk stop on the paragraph inside the cell —
    // so clicking the handle selected just the header content, not the
    // table.)
    try {
      crepe.editor.config((ctx) => {
        ctx.update(blockConfig.key, (cfg) => ({
          ...cfg,
          filterNodes: ($pos, node) => {
            if (node?.type?.name === 'table') return true;
            if (findParent((n) => n.type.name === 'table')($pos)) return false;
            return true;
          },
        }));
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Crepe] failed to override blockConfig.filterNodes:', err);
    }

    // Custom plugins layered onto the underlying Milkdown editor. Wrap each
    // .use() in its own try/catch so a single misbehaving plugin doesn't
    // poison the chain (and the editor) — the previous attempt to chain
    // every .use() together collapsed the entire editor when one of them
    // failed to register at the SchemaReady boundary.
    const tryUse = (plugin, name) => {
      try {
        crepe.editor.use(plugin);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[Crepe] failed to register ${name}:`, err);
      }
    };
    tryUse(commentHighlightPlugin, 'commentHighlightPlugin');
    tryUse(clearEmptyBlockPlugin, 'clearEmptyBlockPlugin');
    tryUse(tableCellCheckboxPlugin, 'tableCellCheckboxPlugin');
    tryUse(wikilinkDecorationPlugin, 'wikilinkDecorationPlugin');
    tryUse(composedMermaidPlugin, 'composedMermaidPlugin');
    tryUse(tableClickFixPlugin, 'tableClickFixPlugin');
    if (collabPlugin) tryUse(collabPlugin, 'collab');
    // The same transactions the listener counts (it skips addToHistory:
    // false, which our own outside merges use).
    tryUse($prose(() => new Plugin({
      key: new PluginKey('mdnest-pending-edit'),
      state: {
        init: () => null,
        apply: (tr) => {
          if ((tr.docChanged || tr.storedMarksSet) && tr.getMeta('addToHistory') !== false) pendingEditRef.current = true;
          return null;
        },
      },
    })), 'pendingEditPlugin');

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, reported, prev) => {
        pendingEditRef.current = false;
        lastReportedRef.current = reported;
        reportRef.current?.(reported, prev);
      });
      reportRef.current = (reported, prev) => {
        // The listener serializes the document of the last USER transaction
        // and skips ours (an outside change is applied with addToHistory:
        // false). When one landed in its 200 ms window, `reported` is the
        // text from before it, and saving that wrote the outside change out
        // of the file again (live-outside-merge-debounce.spec.js). Report
        // what the editor holds now instead.
        let markdown = reported;
        try { markdown = crepe.getMarkdown(); } catch { /* not ready: use the report */ }
        // Milkdown's serializer escapes [[...]] to \[\[...]] in plain
        // text. Restore wikilink spans so documents containing them
        // round-trip byte-identical through the Live editor.
        const body = restoreWikilinks(markdown);
        if (isBound()) {
          // Shared: saving is the session's job, decided by comparing with
          // the last saved text, so every change (ours or someone else's) is
          // simply reported (the body) for the preview, outline and comments.
          const s = sharedRef.current;
          fmRef.current = s.fm.toString();
          lastLocalContentRef.current = s.withFrontMatter(body);
          if (markdown !== prev && onChangeRef.current) onChangeRef.current(body);
          return;
        }
        const restored = toFull(body);
        lastLocalContentRef.current = restored;
        // suppressSaveRef is armed only for the duration of a document
        // injection (Crepe's initial render and each replaceAll), because
        // re-serializing what we just put in would PUT the file back — and the
        // serializer normalizes as it goes, so that write also rewrites the
        // user's bullet style on open. It is disarmed the moment the injection
        // finishes, NOT when an echo arrives: an injection whose serialization
        // is byte-identical fires no markdownUpdated at all, which would leave
        // the flag armed and silently eat the next real edit.
        //
        // The previous gate stayed armed until a keydown or mousedown landed
        // inside the editor, which ticking a task checkbox never produces —
        // ProseMirror handles it internally — so every checkbox edit in a
        // freshly opened note was silently dropped.
        if (suppressSaveRef.current) return;
        if (markdown === prev) return;
        if ((injectedEchoRef.current !== null && restored === injectedEchoRef.current)
          || restored === lastPropContentRef.current) {
          // The injected document coming back (as the editor serialized it,
          // or exactly as the parent handed it over): not a user edit.
          injectedEchoRef.current = null;
          return;
        }
        injectedEchoRef.current = null;
        const cb = onChangeRef.current;
        if (cb) cb(restored);
      };
    });

    crepe.create().then(() => {
      crepeRef.current = crepe;
      // Keep grammar-checking extensions off the editor (noGrammarAssist.js).
      try { crepe.editor.action((ctx) => markNoGrammarAssist(ctx.get(editorViewCtx).dom)); } catch { /* not ready */ }
      // The initial document is in; anything after this is a user edit.
      suppressSaveRef.current = false;
      setInnerEditor(crepe.editor);
      if (readOnly) crepe.setReadonly(true);
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Crepe init failed:', err);
    });

    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      setInnerEditor(null);
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

  // Apply a document that arrived from outside (a collaborator's typing or
  // save, a reload, a restore) by changing ONLY the part that differs.
  // replaceAll swapped the whole document, which threw the caret to the end
  // and scrolled there: "my cursor jumps to the end while someone else
  // types". The standard ProseMirror diff (findDiffStart/findDiffEnd) yields
  // the smallest changed range; ProseMirror then maps the selection through
  // it, so the caret and scroll stay put (shifted only if text above them
  // changed). Not added to undo history: Cmd+Z undoes your edits, not theirs.
  const applyExternalDoc = useCallback((markdown) => (ctx) => {
    const view = ctx.get(editorViewCtx);
    let next = ctx.get(parserCtx)(markdown);
    if (!next || typeof next === 'string') throw new Error('parse failed');
    const cur = view.state.doc;
    // Markdown drops the trailing space of a paragraph, so the incoming text
    // never has the space the person just typed at the end of the paragraph
    // they are in, and replacing that paragraph glued their next word to the
    // last one ("backB0backB1"). When the caret is at the end of a top-level
    // paragraph that ends in whitespace, and the incoming paragraph ends with
    // the same words without it, the whitespace is kept.
    const head = view.state.selection.head;
    const $h = cur.resolve(head);
    if ($h.depth === 1 && $h.parent.isTextblock && head === $h.end()) {
      const idx = $h.index(0);
      const cb = cur.child(idx);
      const ws = /\s+$/.exec(cb.textContent);
      if (ws && idx < next.childCount) {
        const nb = next.child(idx);
        // The words just before the caret, on the paragraph's last line only
        // (an outside change may have touched an earlier line of it).
        const tail = cb.textContent.slice(0, -ws[0].length);
        const stem = tail.slice(tail.lastIndexOf('\n') + 1).slice(-24);
        if (nb.type === cb.type && !/\s$/.test(nb.textContent) && stem && nb.textContent.endsWith(stem)) {
          next = next.copy(next.content.replaceChild(idx, nb.copy(nb.content.append(Fragment.from(view.state.schema.text(ws[0]))))));
        }
      }
    }
    // Compare blocks ignoring generated heading ids: the live document's
    // headings carry an id a plugin adds after load ("cursor"), a freshly
    // parsed one has "". Compared as-is, the first heading always differed,
    // the "changed range" began at 0, and the caret was swept to the end.
    const key = (n) => JSON.stringify(stripBlockIds(n.toJSON()));
    // Changed ranges, as [fromA, toA, fromB, toB]. With the same number of
    // blocks (the usual case: people edit inside paragraphs) each changed
    // block is its own range, so an edit above the caret and another below
    // it leave the caret's block untouched. Otherwise one range from the
    // first to the last changed block.
    const ranges = [];
    if (cur.childCount === next.childCount) {
      let posA = 0;
      let posB = 0;
      for (let i = 0; i < cur.childCount; i += 1) {
        const ca = cur.child(i);
        const nb = next.child(i);
        if (key(ca) !== key(nb)) ranges.push([posA, posA + ca.nodeSize, posB, posB + nb.nodeSize]);
        posA += ca.nodeSize;
        posB += nb.nodeSize;
      }
    } else {
      const min = Math.min(cur.childCount, next.childCount);
      let pre = 0;
      while (pre < min && key(cur.child(pre)) === key(next.child(pre))) pre += 1;
      let suf = 0;
      while (suf < min - pre && key(cur.child(cur.childCount - 1 - suf)) === key(next.child(next.childCount - 1 - suf))) suf += 1;
      let fromA = 0;
      let fromB = 0;
      for (let i = 0; i < pre; i += 1) { fromA += cur.child(i).nodeSize; fromB += next.child(i).nodeSize; }
      let toA = cur.content.size;
      let toB = next.content.size;
      for (let i = 0; i < suf; i += 1) { toA -= cur.child(cur.childCount - 1 - i).nodeSize; toB -= next.child(next.childCount - 1 - i).nodeSize; }
      ranges.push([fromA, toA, fromB, toB]);
    }
    if (ranges.length === 0) return; // identical apart from generated ids
    const tr = view.state.tr;
    // Last range first, so earlier positions stay valid.
    for (const [fromA, toA, fromB, toB] of ranges.reverse()) {
      // Narrow to the exact change inside the range (ProseMirror's diff), so
      // a caret in the same paragraph as the edit keeps its place too.
      const a = cur.slice(fromA, toA).content;
      const b = next.slice(fromB, toB).content;
      const sd = a.findDiffStart(b);
      let start = fromA;
      let endA = toA;
      let endB = toB;
      if (sd != null) {
        const e = a.findDiffEnd(b);
        if (e) {
          let ea = e.a;
          let eb = e.b;
          const overlap = sd - Math.min(ea, eb);
          if (overlap > 0) { ea += overlap; eb += overlap; }
          start = fromA + sd;
          endA = fromA + ea;
          endB = fromB + eb;
        }
      }
      tr.replace(start, endA, next.slice(start - fromA + fromB, endB));
    }
    view.dispatch(tr.setMeta('addToHistory', false));
  }, []);

  // External content sync (live-collab broadcast, history restore). When the
  // `content` prop drifts from what we last serialized, replace the editor's
  // doc — same pattern as the legacy MilkdownEditor. Suppress saves through
  // the next user keystroke so the replaceAll → markdownUpdated round trip
  // doesn't fire a redundant PUT that races the incoming update.
  useEffect(() => {
    if (!innerEditor || !crepeRef.current) return;
    if (content == null) return;
    // Shared: the document arrives through Yjs, and `content` is only the
    // parent echoing what this editor reported.
    if (isBound()) return;
    if (content === lastPropContentRef.current) return;
    if (content === lastLocalContentRef.current) return;
    lastPropContentRef.current = content;
    suppressSaveRef.current = true;
    try {
      let body = content;
      if (bodyOnlyRef.current) {
        const split = splitFrontMatter(content);
        fmRef.current = split.frontMatter;
        body = split.body;
      }
      try {
        crepeRef.current.editor.action(applyExternalDoc(body));
      } catch {
        // Anything the diff path cannot handle falls back to a full replace.
        crepeRef.current.editor.action(replaceAll(body));
      }
      lastLocalContentRef.current = content;
      try { injectedEchoRef.current = toFull(restoreWikilinks(crepeRef.current.getMarkdown())); } catch { injectedEchoRef.current = null; }
    } catch { /* editor not ready or replaceAll failed */ } finally {
      suppressSaveRef.current = false;
    }
  }, [content, innerEditor, applyExternalDoc]);

  useEffect(() => {
    if (!registerOutsideMerge || !innerEditor) return undefined;
    registerOutsideMerge((fullBase, fullTheirs, merge) => {
      const crepe = crepeRef.current;
      // A bound note's outside changes are the room saver's to merge.
      if (!crepe || isBound()) return null;
      let base = fullBase;
      let theirs = fullTheirs;
      if (bodyOnlyRef.current) {
        const b = splitFrontMatter(fullBase);
        const t = splitFrontMatter(fullTheirs);
        if (t.frontMatter !== b.frontMatter) {
          fmRef.current = fmRef.current === b.frontMatter ? t.frontMatter : merge(b.frontMatter, fmRef.current, t.frontMatter);
        }
        base = b.body;
        theirs = t.body;
      }
      // First choice: apply only the outside change, as whole blocks, to the
      // document as it is now. The blocks that differ between base and
      // theirs are found by parsing both (one parser, so no serialization
      // differences), and replaced in the live document only if the person
      // has not touched them. The paragraph being typed in is never
      // rewritten, so the caret and an unreported keystroke (or a trailing
      // space markdown would drop) stay exactly as they are.
      let applied = false;
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const parse = ctx.get(parserCtx);
          const A = parse(base);
          const B = parse(theirs);
          const C = view.state.doc;
          if (!A || !B || typeof A === 'string' || typeof B === 'string') return;
          const key = (n) => JSON.stringify(stripBlockIds(n.toJSON()));
          const min = Math.min(A.childCount, B.childCount);
          let pre = 0;
          while (pre < min && key(A.child(pre)) === key(B.child(pre))) pre += 1;
          let suf = 0;
          while (suf < min - pre && key(A.child(A.childCount - 1 - suf)) === key(B.child(B.childCount - 1 - suf))) suf += 1;
          const aEnd = A.childCount - suf;
          const cEnd = C.childCount - suf;
          if (cEnd < pre || cEnd - pre !== aEnd - pre) return;
          for (let i = pre; i < aEnd; i += 1) if (key(A.child(i)) !== key(C.child(i))) return;
          for (let i = 0; i < suf; i += 1) {
            if (key(A.child(A.childCount - 1 - i)) !== key(C.child(C.childCount - 1 - i))) return;
          }
          let from = 0;
          for (let i = 0; i < pre; i += 1) from += C.child(i).nodeSize;
          let to = from;
          for (let i = pre; i < cEnd; i += 1) to += C.child(i).nodeSize;
          const blocks = [];
          for (let i = pre; i < B.childCount - suf; i += 1) blocks.push(B.child(i));
          view.dispatch(view.state.tr.replaceWith(from, to, blocks));
          applied = true;
        });
      } catch { applied = false; }
      if (!applied) {
        // The person edited a block the outside change also touched: merge
        // the text and replace what differs (the caret may move here).
        const now = restoreWikilinks(crepe.getMarkdown());
        const target = merge(base, now, theirs);
        if (target !== now) {
          try {
            crepe.editor.action(applyExternalDoc(target));
          } catch {
            crepe.editor.action(replaceAll(target));
          }
        }
      }
      const shown = toFull(restoreWikilinks(crepe.getMarkdown()));
      // The app sets this as its content next; it is what the editor holds.
      lastPropContentRef.current = shown;
      lastLocalContentRef.current = shown;
      return shown;
    });
    return () => registerOutsideMerge(null);
  }, [registerOutsideMerge, innerEditor, applyExternalDoc]);

  // Before the app navigates away: report the edit the listener is still
  // holding back (see pendingEditRef). Nothing pending, nothing reported, so
  // opening a note and leaving it still writes nothing.
  useEffect(() => {
    if (!registerFlush) return undefined;
    registerFlush(() => {
      if (!pendingEditRef.current || !crepeRef.current || !reportRef.current) return;
      pendingEditRef.current = false;
      let md;
      try { md = crepeRef.current.getMarkdown(); } catch { return; }
      reportRef.current(md, lastReportedRef.current);
      lastReportedRef.current = md;
    });
    return () => registerFlush(null);
  }, [registerFlush]);

  // Hand the editor to the shared session when there is one. It binds when
  // the room is ready, to the document as it is then, and unbinds if the
  // connection goes; the editor stays mounted and editable throughout.
  useEffect(() => {
    const crepe = crepeRef.current;
    if (!shared || !innerEditor || !crepe) return undefined;
    const withView = (fn) => {
      let out;
      crepe.editor.action((ctx) => { out = fn(ctx.get(editorViewCtx), ctx); });
      return out;
    };
    shared.attachEditor({
      editor: crepe.editor,
      frontMatter: () => fmRef.current,
      serialize: () => restoreWikilinks(crepe.getMarkdown()),
      schema: () => withView((view) => view.state.schema),
      serializeNode: (node) => withView((_view, ctx) => restoreWikilinks(ctx.get(serializerCtx)(node))),
      // A text as this editor would write it back, so "unchanged" can be
      // told apart from the serializer's own normalizing.
      normalize: (full) => {
        const { frontMatter, body } = splitFrontMatter(full || '');
        let out = body;
        try {
          withView((_view, ctx) => {
            const doc = ctx.get(parserCtx)(body);
            if (doc && typeof doc !== 'string') out = restoreWikilinks(ctx.get(serializerCtx)(doc));
          });
        } catch { /* keep the text as it is */ }
        return joinFrontMatter(frontMatter, out);
      },
      // The document to seed an empty room with, without what only this
      // editor adds (generated heading ids): the room holds the note.
      seedDoc: () => withView((view) => view.state.schema.nodeFromJSON(stripBlockIds(view.state.doc.toJSON()))),
      // A body parsed the way this editor would show it (for the saver
      // joining with a merged text, see sharedDoc _saverJoin).
      parseDoc: (body) => withView((view, ctx) => {
        const doc = ctx.get(parserCtx)(body);
        return doc && typeof doc !== 'string' ? view.state.schema.nodeFromJSON(stripBlockIds(doc.toJSON())) : null;
      }),
      // The caret, and whether the person is typing here: joining the room
      // re-renders the whole document, which drops keyboard focus, and
      // whatever they type next would go nowhere.
      getSelection: () => withView((view) => ({ anchor: view.state.selection.anchor, head: view.state.selection.head, focused: view.hasFocus() })),
      setSelection: (sel) => {
        if (!sel) return;
        try {
          withView((view) => {
            const max = view.state.doc.content.size;
            const clamp = (n) => Math.max(0, Math.min(n, max));
            const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, clamp(sel.anchor), clamp(sel.head)));
            view.dispatch(tr.setMeta('addToHistory', false));
          });
        } catch { /* a position that is no longer text: leave the caret */ }
        if (sel.focused) {
          try { withView((view) => { if (!view.hasFocus()) view.focus(); }); } catch { /* editor gone */ }
        }
      },
      applyBody: (md) => {
        try {
          crepe.editor.action(applyExternalDoc(md));
        } catch {
          crepe.editor.action(replaceAll(md));
        }
      },
    });
    return () => shared.detachEditor();
  }, [shared, innerEditor, applyExternalDoc]);

  // Push active comment anchors into the highlight plugin whenever comments
  // change. Same logic as the legacy LiveEditor — top-level threads only,
  // with rangeStart for occurrence disambiguation.
  useEffect(() => {
    if (!innerEditor || !crepeRef.current) return;
    const anchors = (comments || [])
      .filter((c) => !c.parentId && !c.resolved && c.anchorText)
      .map((c) => ({ text: c.anchorText, id: c.id, rangeStart: c.rangeStart }));
    try {
      crepeRef.current.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.setMeta(commentHighlightKey, { anchors });
        view.dispatch(tr);
      });
    } catch { /* editor not ready */ }
  }, [comments, innerEditor]);

  // Go-to handler — flashes the matched anchor and scrolls it into view.
  const goToComment = useCallback((comment) => {
    const anchorText = typeof comment === 'string' ? comment : comment?.anchorText;
    const hintPos = typeof comment === 'object' && comment ? Number(comment.rangeStart || 0) : 0;
    if (!crepeRef.current || !anchorText) return;
    try {
      crepeRef.current.editor.action((ctx) => {
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
            crepeRef.current?.editor.action((c2) => {
              const v2 = c2.get(editorViewCtx);
              v2.dispatch(v2.state.tr.setMeta(commentHighlightKey, { flash: null }));
            });
          } catch { /* editor torn down */ }
        }, 1800);
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Go to comment failed:', e);
    }
  }, []);

  useEffect(() => {
    if (onGoToReady) onGoToReady(goToComment);
  }, [goToComment, onGoToReady]);

  // Floating Comment button: appears when the user selects text inside the
  // editor pane. Mirrors the legacy LiveEditor — only triggers on a
  // selection gesture that originated inside the editor, otherwise a
  // sidebar click that programmatically sets a selection would pop the
  // button at random positions.
  // Position: the button is absolutely placed in .live-editor-wrapper, which
  // does NOT scroll; the Crepe root inside it does. So the offset is the
  // selection's on-screen position relative to the wrapper, with no scrollTop
  // added. Adding the root's scrollTop (as this once did) put the button
  // thousands of px down in a scrolled note: the wrapper overflowed, grew a
  // scrollbar, the editor lost its width and every line rewrapped, then
  // snapped back when the button went away (the selection "flicker"). The
  // button is kept inside the wrapper, and re-placed as the editor scrolls.
  const popupPosition = useCallback((view, end) => {
    const root = rootRef.current;
    const wrapper = root?.parentElement;
    if (!root || !wrapper) return null;
    const coords = view.coordsAtPos(end);
    const wr = wrapper.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    if (coords.bottom < rr.top || coords.top > rr.bottom) return { hidden: true, top: 0, left: 0 };
    const BTN_H = 32;
    const top = Math.max(0, Math.min(coords.top - wr.top + 20, wrapper.clientHeight - BTN_H));
    const left = Math.max(0, Math.min(coords.left - wr.left, wrapper.clientWidth - 120));
    return { hidden: false, top, left };
  }, []);

  useEffect(() => {
    if (!innerEditor || !onComment) return undefined;
    const checkSelection = (e) => {
      const root = rootRef.current;
      if (!root) return;
      if (e && e.target && !root.contains(e.target)) return;
      try {
        innerEditor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = view.state.selection;
          if (to - from < 3) { setSelectionPopup(null); return; }
          const selectedText = view.state.doc.textBetween(from, to, ' ');
          if (!selectedText.trim()) { setSelectionPopup(null); return; }
          const pos = popupPosition(view, to);
          if (!pos) return;
          setSelectionPopup({ ...pos, text: selectedText, start: from, end: to });
        });
      } catch { /* not ready */ }
    };
    // Keep the button beside its text while the editor scrolls.
    const onScroll = () => {
      setSelectionPopup((cur) => {
        if (!cur) return cur;
        let next = cur;
        try {
          innerEditor.action((ctx) => {
            const pos = popupPosition(ctx.get(editorViewCtx), cur.end);
            if (pos) next = { ...cur, ...pos };
          });
        } catch { /* editor torn down */ }
        return next;
      });
    };
    const root = rootRef.current;
    document.addEventListener('mouseup', checkSelection);
    document.addEventListener('keyup', checkSelection);
    root?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('mouseup', checkSelection);
      document.removeEventListener('keyup', checkSelection);
      root?.removeEventListener('scroll', onScroll);
    };
  }, [innerEditor, onComment, popupPosition]);

  // Hide the block handle while a mouse selection is being dragged. Crepe
  // animates the handle (`transition: all 0.2s`) to whichever block is under
  // the pointer, so during a drag it glides up and down beside the text being
  // selected, which reads as the text itself jumping. A press that starts ON
  // the handle is a block drag or a `+` click and is left alone. Toggled on
  // the DOM, not in state, so a drag causes no React re-render.
  useEffect(() => {
    const root = rootRef.current;
    const pane = paneRef.current;
    if (!root || !pane) return;
    const onDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.milkdown-block-handle')) return;
      pane.classList.add('selecting');
    };
    const onUp = () => pane.classList.remove('selecting');
    root.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      root.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, []);

  // Listen for the `mermaid-fullscreen` custom event the MermaidBlock node
  // view dispatches when the user clicks the expand button — open the
  // viewer modal with the SVG payload.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (e) => setViewerSvg(e.detail);
    el.addEventListener('mermaid-fullscreen', handler);
    return () => el.removeEventListener('mermaid-fullscreen', handler);
  }, []);

  // Clicking a yellow .comment-highlight in the editor opens the sidebar
  // and flashes the relevant comment card.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHighlightClick) return;
    const onClick = (e) => {
      const target = e.target.closest && e.target.closest('.comment-highlight');
      if (!target) return;
      const ids = (target.getAttribute('data-comment-ids') || '').split(',').filter(Boolean);
      if (ids.length === 0) return;
      onHighlightClick(ids[0]);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [onHighlightClick]);

  // Ctrl/Cmd+Click on a decorated [[wikilink]] navigates to the target
  // note. Plain click keeps its editing meaning (place the caret), so the
  // modifier is the navigation affordance, mirroring how editors treat
  // links in editable text.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onClick = (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const target = e.target.closest && e.target.closest('.wikilink-live');
      if (!target) return;
      const inner = target.getAttribute('data-wikilink') || '';
      const { page, heading } = parseWikiLink(inner);
      const path = page ? resolveWikiLink(page, wikiIndexRef.current, currentPath) : currentPath;
      // A link to this same note only does something when it names a heading.
      if (!path || (path === currentPath && !heading)) return;
      e.preventDefault();
      e.stopPropagation();
      const cb = onWikiLinkRef.current;
      if (cb) cb(path, heading);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [currentPath]);

  // Paste handler — ported from legacy LiveEditor with the v3.9.1 priority:
  //   1. Images → upload, insert ![](url)
  //   2. Table-row HTML when cursor in table → splice rows into table
  //   3. text/plain that looks like markdown → markdownToSlice (preserves
  //      task list checkbox semantics that the HTML round-trip mangles)
  //   4. Rich text/html → htmlToMarkdown → markdownToSlice
  //   5. Fall through to Crepe's default paste
  useEffect(() => {
    const el = rootRef.current;
    if (!el || readOnly) return;

    const handlePaste = async (e) => {
      const crepe = crepeRef.current;
      if (!crepe) return;
      const cb = e.clipboardData;
      if (!cb) return;

      // 0. Inside a code block / code-mark: let the default paste win.
      // Milkdown's own clipboard plugin makes the same check — markdown
      // structure has no meaning inside a code fence, and routing a
      // multi-line paste through markdownToSlice turns each line into a
      // separate paragraph (so only the first line lands inside the
      // code block and the rest break out below it, matching the bug
      // the user hit pasting SQL into a `sql code block).
      try {
        const inCode = crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const $from = view.state.selection.$from;
          if ($from.parent.type.spec.code) return true;
          // Inline code mark wraps the cursor too — be defensive.
          const codeMark = view.state.schema.marks.code_inline || view.state.schema.marks.code;
          if (codeMark && codeMark.isInSet($from.marks())) return true;
          return false;
        });
        if (inCode) return; // don't preventDefault → browser pastes as text
      } catch { /* editor not ready — fall through */ }

      // 1. Image paste: handled by Crepe's `@milkdown/plugin-upload`
      // (with `enableHtmlFileUploader: true` configured above). That plugin
      // creates an image-block node whose nodeView calls proxyDomURL on
      // the src so the rendered <img> resolves to /api/files/<ns>/<dir>/file.
      // We deliberately DO NOT preventDefault for image pastes here — if
      // we did, the upload plugin's `handlePaste` hook wouldn't fire.

      // 1b. ProseMirror-to-ProseMirror paste: if the clipboard HTML carries
      // the `data-pm-slice` marker that ProseMirror's clipboard serializer
      // writes, let Milkdown's native clipboard plugin handle the paste.
      // Its parseDOM-based path preserves table cells with inline marks
      // (bold-inside-cell), link attributes, fenced-code language tags,
      // and other schema details that the htmlToMarkdown / markdownToSlice
      // round trip flattens. This is what the legacy editor relied on for
      // "copy from one mdnest tab, paste into another" fidelity.
      const html = cb.getData('text/html');
      if (html && /data-pm-slice/i.test(html)) {
        return;
      }

      // 2. Table-row HTML splice
      if (html && /<tr[\s>]/i.test(html)) {
        try {
          const handled = crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;
            const { $from } = state.selection;

            let tableNode = null;
            let tablePos = null;
            let currentRowIndex = 0;
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d);
              if (node.type.name === 'table') {
                tableNode = node;
                tablePos = $from.before(d);
                const cellNode = $from.node(d + 1);
                for (let i = 0; i < node.childCount; i++) {
                  if (node.child(i) === cellNode) { currentRowIndex = i; break; }
                }
                break;
              }
            }
            if (!tableNode) return false;

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const trs = doc.querySelectorAll('tr');
            if (trs.length === 0) return false;

            const pastedRows = [];
            for (const tr of trs) {
              const cells = [];
              for (const cell of tr.querySelectorAll('th, td')) {
                cells.push(cell.textContent.trim());
              }
              if (cells.length > 0) pastedRows.push(cells);
            }
            if (pastedRows.length === 0) return false;

            const colCount = tableNode.child(0).childCount;
            const schema = state.schema;
            const cellType = schema.nodes.table_cell;
            const rowType = schema.nodes.table_row;
            if (!cellType || !rowType) return false;

            const newRows = pastedRows.map((cells) => {
              const pmCells = [];
              for (let c = 0; c < colCount; c++) {
                const text = cells[c] || '';
                const content = text ? schema.text(text) : null;
                const para = schema.nodes.paragraph.create(null, content ? [content] : []);
                pmCells.push(cellType.create(null, [para]));
              }
              return rowType.create(null, pmCells);
            });

            let insertPos = tablePos + 1;
            for (let i = 0; i <= currentRowIndex; i++) {
              insertPos += tableNode.child(i).nodeSize;
            }
            const tr = state.tr;
            for (let i = newRows.length - 1; i >= 0; i--) {
              tr.insert(insertPos, newRows[i]);
            }
            view.dispatch(tr);
            return true;
          });

          if (handled) {
            e.preventDefault();
            return;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('Table row paste failed:', err);
        }
      }

      // 3/4. Markdown via slice (preserves task-list semantics)
      const pasteMarkdown = (md) => {
        if (!md) return false;
        let inserted = false;
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const slice = markdownToSlice(md)(ctx);
          if (!slice) return;
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          inserted = true;
        });
        return inserted;
      };

      const text = cb.getData('text/plain');

      // 2b. Mermaid source detected in plain text — wrap in a ```mermaid
      // fence before pasting. Without this the source lands as a plain
      // paragraph and the user has to wrap it manually (which broke a
      // workflow we had in the legacy editor where copy-pasting a graph
      // from anywhere "just worked").
      if (text && looksLikeMermaid(text)) {
        e.preventDefault();
        pasteMarkdown('```mermaid\n' + text.replace(/\s+$/, '') + '\n```\n');
        return;
      }

      if (text && looksLikeMarkdown(text)) {
        e.preventDefault();
        pasteMarkdown(text);
        return;
      }

      if (html && hasRichContent(html)) {
        e.preventDefault();
        pasteMarkdown(htmlToMarkdown(html));
        return;
      }
      // 5. otherwise fall through to Crepe's default paste
    };

    el.addEventListener('paste', handlePaste, true);
    return () => el.removeEventListener('paste', handlePaste, true);
  }, [ns, currentPath, readOnly]);

  return (
    <div ref={paneRef} className={`live-editor-pane${handlesHidden ? ' handles-hidden' : ''}`}>
      {readOnly && <div className="editor-readonly-bar">Read-only</div>}
      {!readOnly && <LiveToolbar editor={innerEditor} handlesHidden={handlesHidden} onToggleHandles={toggleHandles} undoRedo={shared && sharedBound ? { undo: shared.undo, redo: shared.redo } : null} />}
      <div className="live-editor-wrapper" style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div ref={rootRef} className="live-editor-crepe-root" />
        {selectionPopup && !selectionPopup.hidden && onComment && (
          <button
            className="comment-selection-btn"
            style={{ top: selectionPopup.top, left: selectionPopup.left }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onComment({
                rangeStart: selectionPopup.start,
                rangeEnd: selectionPopup.end,
                anchorText: selectionPopup.text,
              });
              setSelectionPopup(null);
            }}
          >
            💬 Comment
          </button>
        )}
      </div>
      {viewerSvg && (
        <MermaidViewer svgContent={viewerSvg} onClose={() => setViewerSvg(null)} />
      )}
    </div>
  );
}
