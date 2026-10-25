# mdnest - AI Context

Self-hosted Markdown knowledge base for teams and their AI agents. Plain files on disk, Docker-based. Supports single-user (no database) and multi-user (PostgreSQL) modes.

## Quick Orientation

- **Backend**: Go (net/http + golang-jwt + lib/pq), lives in `backend/`
- **Frontend**: React + Vite + Milkdown (live editor), lives in `frontend/`
- **Docker**: multi-stage builds, nginx proxy, optional git-sync sidecar
- **MCP Server**: Node.js, lives in `mcp-server/` — wraps REST API for AI assistants
- **Config**: `mdnest.conf` -> `setup.sh` generates `docker-compose.yml` and `.env`

## Skills — which to invoke, and when (read this first)

This repo ships slash-command skills (in `.claude/skills/`, `md-*` prefix) that
encode the *full, correct* multi-step process for the recurring workflows. **When
a request matches one of these workflows, invoke the skill — whether the user
typed the slash command or asked in their own words ("fix these bugs", "add this
feature", "ship it").** The skill is the source of truth for the steps (branch
strategy, verification gate, no-per-bug-PR rule, clean-commit / no-attribution
rule, `-dev` version scheme, delete-the-bug-file-when-fixed, release recipe). Do
not improvise an ad-hoc version that skips steps — an ad-hoc bug fix must still
follow `md-fix-bugs`.

| If the user wants to… | Invoke | It covers |
|---|---|---|
| Fix bug(s) — from the brain `Bugs/` folder **or** an ad-hoc bug they describe | **`md-fix-bugs`** | Read/triage the backlog, verify it's really a bug (some are already fixed), fix each on its own branch from `develop`, verify (smoke test + a regression check), merge **straight into `develop`** (no per-bug PR), **delete the bug's file from the brain** so it isn't re-picked, then one clean release PR on top of `main`. |
| Add a feature / improvement — from the brain `Features/` folder or described ad-hoc | **`md-add-improvement`** | Same disciplined flow for the features backlog. |
| Ship / release / "update the docs + website + rebuild" after code changes | **`md-ship`** | CHANGELOG, three-file version bump, docs, website sync, rebuild the dev stack, publish the GitHub Release (tags ≠ Releases — the in-app banner needs a Release). |
| Handle a **GitHub issue** someone filed — "take care of issue 87", "here's the issue \<url\>", "someone reported X, deal with it" | **`md-issue-process`** | The whole arc for one issue: read it (including the screenshot — one report is often two bugs), split it into symptoms, decide which are even ours, reproduce the *mechanism* without owning the reporter's machine (PATH shims, containers), fix each per `md-fix-bugs`, add the test that would have caught it, release via `md-ship`, then reply to the reporter (owner's go-ahead first — it's public and under his name), close, and record the lessons in the brain. |
| Review PR(s) from an outside contributor — "what should we merge?", "check this PR", "is this safe?" | **`md-review-collab`** | Three gates in order: **legit** (does it do what it claims — verify by running, don't read), **safe** (no weakened path/permission check, no exploit), **direction** (doesn't trade away git-as-storage, mount-defined namespaces, or the lean core). Then merge order (simulate conflicts first), a review that only says what must be said, and merge into `develop` with owner sign-off on anything touching direction. |

If unsure which applies, prefer the skill over an ad-hoc approach and say which one
you're running. The `md-*` family is authoritative; the summaries here are just a
router. See also the **Release Process** section below (the skills implement it).

## Project Structure

The file-by-file map, with the traps worth knowing about each file, is in [`docs/codemap.md`](docs/codemap.md). Read the entries for the files you are about to change before you change them, and update the map when you add, move or remove a file.

- `backend/`: Go server (`main.go`, `routes.go`, `handlers/`, `middleware/`, `storage/`, `store/`, `collab/`, `relpath/`, `gitproc/`, `secrets/`, `sso/`, `firebase/`, `updates/`)
- `frontend/`: React app (`src/App.jsx`, `src/api.js`, pure modules in `src/*.js`, components in `src/components/`)
- `mcp-server/`: Node MCP server
- `deploy/`: plain compose example and the Helm chart
- `tests/`: shell, e2e and Playwright suites (see Testing below)
- `mdnest` (client CLI), `mdnest-server` (server CLI), `setup.sh`, `mdnest.conf.sample`

## Public wording (README, docs, website, release notes)

mdnest is pitched as **"Your team and your AI agents, working from the same notes."**: a self-hosted Markdown knowledge base for developer teams who work with coding agents. A single developer can try it alone first, but teams are the main readers. The owner sets the audience and the pitch, so do not change either on your own.

Every public sentence (this repo's `README.md`, the user-facing `docs/`, CHANGELOG entries, GitHub release notes, and the website) follows the writing standard in the website repo: `../mdnest-website/WRITING.md` ([on GitHub](https://github.com/mahsanamin/mdnest-website/blob/main/WRITING.md)). In short:

- Plain English: short common words, one idea per sentence, no metaphors, no em or en dashes, no marketing words.
- Say what the user gets, then the fact that proves it.
- Promise only what the **released** code does. No time claims ("3 minutes"), no "one command", no "nothing leaves your server", no "built-in AI". `WRITING.md` has the full list and the wording to use instead.
- Label features the basic install does not turn on: "Optional" (for example the task board, drawings, MCP) or "Needs team setup" (comments, presence, per-person access, groups, private chats).

When a change here alters one of those defaults or what the server sends out, update the facts in `WRITING.md` in the same release. `md-ship` step 7 covers this.

## Key Conventions

### Backend (Go)
- Standard library only, no web framework — just net/http with ServeMux
- External dependencies: golang-jwt/jwt/v5, **jackc/pgx/v5** (Postgres driver), golang.org/x/crypto (bcrypt)
- **The Postgres driver is pgx, not lib/pq** (v4.2.1+). lib/pq is in maintenance mode and carries seven advisories that will never be fixed (GO-2026-6166/6168/6170–6173, all `Fixed in: N/A`), and `Backend (govulncheck)` is a required check on `main` with no bypass actors — so it blocked *every* release, not just the one that hit it. Three things follow: open the pool with `sql.Open("pgx", dsn)` (the keyword/value DSN is unchanged); test for a unique violation with `pgconn.PgError` + SQLSTATE `23505`, never `pq.Error`; and pass a Go slice **directly** for an array parameter (`= ANY($n)`) — pgx maps it to a Postgres array natively, so there is no `pq.Array` equivalent to reach for.
- Two auth modes: `AUTH_MODE=single` (file-based, no DB) or `AUTH_MODE=multi` (Postgres)
- Three identity providers (multi-mode only): `USER_PROVIDER=local` (default, username/password), `USER_PROVIDER=firebase` (Firebase Auth + Firestore TOTP), `USER_PROVIDER=sso` (generic OIDC). Exclusive; chosen at startup. In `sso` mode 2FA is skipped entirely (IdP owns MFA) and local password endpoints are unused. See `docs/sso-setup.md` and `docs/firebase-setup.md`.
- **Three role values** (v3.5.0+): `superadmin` (global), `admin` (namespace-scoped via the `namespace_admins` table), `collaborator` (per-grant only). Pre-v3.5.0 `admin` is migrated to `superadmin` by migration 007. `ADMIN_EMAILS` auto-promotes to `superadmin`. Permission checks go through `middleware.PermissionChecker.hasAdminScope(uc, ns)` — admin only for `namespace_admins` rows; everyone else falls through to grants. **A superadmin has NO implicit access to note content** (v3.12.0, PR #53): it manages every namespace (users, grants, admins) but reads and writes notes only through grants, like anyone else, and can self-grant (the empty page's "Give me access to all namespaces" button does that). Admin-only content actions (deleting someone else's chat) check `uc.Role == "superadmin"` separately, on top of the grant the route already required. API tokens follow the same precedence chain (no admin bypass for tokens).
- **The superadmin keeps full management control by default.** It can always see and revoke every API token, disable or delete users, reset 2FA and manage grants, groups and namespace admins, so the owner can act alone when someone leaves or a token leaks. A change may move or clarify one of these powers but not remove it; a narrower superadmin is a config option, off by default (`md-review-collab`, "Admin power stays with the owner").
- **Access Groups are a second grant source, unioned in** (v4.2.0+): effective access = own grants ∪ every group's grants. Consulted only after direct grants fail, and a nil `groupStore` disables the layer (single mode / no DB). The two member kinds have *different revocation latency* and that asymmetry is deliberate but must stay documented: a `user_id` member resolves live per request, while an `oidc_group` member is matched against the `groups` claim snapshotted into the JWT at login. That is why SSO sessions use `ssoJWTTTL` (12h) instead of the year-long remember-me TTL — it bounds how long a stale IdP snapshot outlives a change. Note `uc.Role` is read from the token too, so role changes are equally deferred; that is pre-existing, not new.
- **An access filter passed as a function must be required, not optional.** `/api/tasks/all` is access-controlled *solely* by its namespace filter and deliberately skips `RequireNsAccess` (it isn't scoped to one namespace). The filter is a mandatory `NewTaskHandler` argument, and `HandleGlobalTasks` treats nil as deny-all — so forgetting to wire it is a compile error, and if one ever slips through the endpoint serves nothing instead of every namespace. When a test pins a guard, mutate the *call site* too: a nil-means-permissive default is invisible to a predicate test.
- **SSO identity rules live in one pure function, `checkIdentity`** (`backend/sso/client.go`, v4.5.4+), so they are unit-tested without an IdP. Any IdP-specific rule must be keyed on the issuer and leave every other IdP untouched — mdnest is generic OIDC, and Clerk, Okta, Entra, Keycloak and Auth0 all go through the same path. The Google `hd` rule is the example: it requires `hd` to be *present*, not *listed*, because `hd` is the org's primary domain (a secondary-domain user carries the primary), and it exempts `gmail.com`, whose accounts never have `hd`. The first draft required membership and would have locked out both. `email_verified` decodes as `flexBool` because some IdPs send the string `"true"`, and a strict `bool` failed the whole claim decode.
- In single mode, the store/ package is not initialized — zero DB dependency
- All handlers take `notesDir` (absolute path) in constructor
- All file APIs require `ns` query param (namespace = top-level dir under NOTES_DIR)
- Path safety: `SafePath()` in `path.go` prevents traversal — always use it
- `RequireNamespace()` validates and resolves namespace to directory — use for all ns-scoped endpoints
- Handler pattern: struct with notesDir field, constructor `NewXHandler()`, method handlers
- Method dispatch: single route per resource, switch on r.Method inside Handle()
- Response format: JSON for structured data, raw text/markdown for note content
- Errors: JSON `{"error":"message"}` with appropriate HTTP status

### Frontend (React)
- Functional components with hooks, no class components
- State management: useState/useCallback in App.jsx, passed as props
- No state library (Redux etc.) — props and callbacks only
- CSS: single App.css + index.css, no CSS modules, no styled-components
- Theme: Catppuccin Mocha (bg #1e1e2e, sidebar #181825, accent #89b4fa, text #cdd6f4)
- Mobile: responsive at 768px breakpoint, sidebar becomes slide-over overlay
- URL state: hash-based routing (#namespace/path/to/note.md)
- API calls: all go through api.js which handles JWT and 401 redirects
- marked v15: use plain renderer object (NOT `new marked.Renderer()`), method signature is `({ text, lang })` for code blocks. **Register the renderer via `new Marked().use({renderer: {...}})`, NOT via the per-call `marked(src, {renderer})` option** — the per-call form replaces the default renderer entirely (no fallback), so any token type you don't override crashes with `this.renderer.X is not a function`. Also: never call `this.parser.parseInline(token.tokens)` from a custom `listitem`; task items with nested blocks will blow up with `Token with "list" type was not found`. Rely on marked's built-in GFM task rendering and re-wire the checkboxes in the DOM post-pass.
- Mermaid: rendered post-DOM-insert by querying `.mermaid-source` divs
- Two editor modes: Basic (textarea, Editor.jsx) and Live (Crepe, LiveEditorCrepe.jsx)
- Live editor: lazy-loaded via React.lazy(), only downloads when user switches to Live mode. The chunk is ~1.1 MB (~340 KB gzipped) — Crepe + Vue runtime + CodeMirror + KaTeX.
- Crepe (v3.10.0+): `@milkdown/crepe` is the same editor Milkdown's playground uses. Provides block-edit (drag handle + slash menu), native task-list checkboxes, KaTeX math, polished tables, image-block upload UI, link tooltip. Built on `@milkdown/kit/preset/{commonmark,gfm}` under the hood — same schema as pre-v3.10's hand-rolled Milkdown stack.
- Custom plugins (in `live-editor-plugins.jsx`): `commentHighlightPlugin` (yellow highlight on commented text, anchor disambiguation via `rangeStart`), `clearEmptyBlockPlugin` (backspace empty heading → paragraph), `tableCellCheckboxPlugin` (literal `[ ]`/`[x]` in cells render as interactive checkboxes via decorations; markdown bytes unchanged on serialize), `wikilinkDecorationPlugin` (v3.11.5+ — `[[wikilink]]` spans get a link-coloured highlight + `data-wikilink`; decoration-only so bytes stay literal `[[...]]`, Ctrl/Cmd+Click navigation wired in `LiveEditorCrepe.jsx`), `LiveToolbar` (Undo / Redo / format / insert / table commands).
- **An outside change to an open, non-shared note is merged, never a banner** (v4.8.13). With live collaboration off nothing pushes a CLI or agent change, so App checks the open note every `NOTE_POLL_MS` (5 s) with `If-None-Match`. An idle tab takes the new text; a tab with unsaved typing keeps its OLD etag, so its autosave is refused (409) and `mergeAndSave` three-way merges (`sharedText.mergeThreeWay`, lazy-imported to keep diff-match-patch out of the entry) and saves again. The Live editor merges through `registerOutsideMerge`, against its own document at that moment: `markdownUpdated` reaches App late, and merging App's copy dropped keystrokes. Worse, Milkdown's listener serializes the document of the last USER transaction (it skips `addToHistory: false`, which our outside merges use), so a report 200 ms after a keystroke could carry the text from before a merge that landed meanwhile; the handler therefore ignores the listener's markdown and serializes `crepe.getMarkdown()` (`live-outside-merge-debounce.spec.js` holds the note poll to land a merge inside that window); and it inserts only the changed blocks, because re-serializing the paragraph being typed in drops a trailing space and swept the caret to the end. The Basic textarea keeps its caret with `caret.mapCaret`. `cli-default-install.spec.js` pins all of it in `tests/e2e-browser.sh` (single mode, where live collaboration is always off: the backend enables it only in multi mode, so that harness's `ENABLE_LIVE_COLLAB=true` does nothing). `shared-unavailable.spec.js` breaks the websocket with `page.routeWebSocket` and runs in `tests/e2e-collab-multi.sh`.
- **A Live note never waits for the room, and never shows the connection beyond one dot** (v4.8.13, LIVE-1). The editor mounts once per note (key without the session), with the collab plugin registered at creation (`sharedMod`, the sharedDoc chunk preloaded when the server says shared editing is on) and holding the BODY only (front matter in the editor's `fmRef`, put back in front of every change it reports). Until `SharedSession.bound` the note is on the normal path (autosave, 409 merge, `registerOutsideMerge`); the session binds to the editor AS IT IS when the room is ready: an empty room is seeded from the editor's own ProseMirror doc (`prosemirrorToYXmlFragment` of `seedDoc()`, heading ids stripped), so the screen and the caret do not change; a room with text is joined at once only if this tab has nothing of its own (clean against the app's saved text in the editor's normalized form, `normalize()`, and still on the base the session started from, `startBase`); otherwise the tab keeps saving the normal way and binds once the room's serialized text EQUALS the editor's (`_waitForRoom`, checked every 400 ms). Do not three-way merge at bind: when the room had not yet taken in the tab's last normal save, the same line differed on both sides and diff3 kept it twice (`live-never-blocks.spec.js` (f), under `MDNEST_E2E_CPU=4`). Binding re-renders the whole document, which drops keyboard focus: `getSelection`/`setSelection` carry the caret AND focus across bind and unbind, or the rest of a word typed at that moment goes nowhere. `.editor-wrapper[data-shared=bound|apart]` says which, for specs. A tab that is apart AND the room's saver (everyone left, it came back first: the server gives the role to the first writer) would wait forever, since nobody else merges the file: `_saverJoin` saves its text the normal way (`saveNow`), and at the first moment it is all saved, GETs the file, three-way merges room and file, writes the result into the Y fragment WITHOUT the editor (`updateYFragment`; the editor's own doc when the merge equals the screen) and only then binds, so nothing on screen goes away (spec (h) samples every 50 ms). `mergeThreeWay` takes the longer side of a conflicting hunk only when BOTH sides are the base plus insertions and the longer contains the shorter (deleted whitespace does not count: the editor reports a trailing space mid-typing and drops it on write-back): the same typing reaches the file through the room and through a dropped tab's handover save, and diff3 kept the shared words twice. Never loosen it to "one side contains the other": that brings back a line the other side deleted. `handleFileChanged` merges an idle tab's reload through `showOutside` like the poll: a plain `setContent` dropped keystrokes typed just after a save, since "no local edits" is judged from App's late copy. "Clean" is decided by the editor against `savedContentRef`, never by App's `contentRef`, which lags (`markdownUpdated` is debounced). On bind App drops its queued autosave; `doSave` and its 409 merge stop when bound (the room saver merges the file, merging twice duplicates). When the socket goes, the session unbinds (`collabService.disconnect()`, ProseMirror history put back), hands App `{base, etag, text}` from the room's meta, and starts the next join from a FRESH Y.Doc: reusing the old one replays ops the saver has meanwhile merged from the file, which duplicates text (`live-never-blocks.spec.js` (f) checks every word once). Every awaited step of the session (the saver's file check, the room save's bookkeeping after its PUT, the saver's join) records `gen` before the await and stops if it moved (`_socketGone` bumps it), and `_applyFull` writes only into a bound editor: a file check that returned after the socket dropped applied the old file over the person's typing, and every later merge then kept a line twice (spec (i) holds that GET with `page.route`; either guard alone passes it, neither fails it). A session sends document updates only while bound or binding, and the saver confirms `yjs-saved` before unbinding or leaving, or a quick open-and-leave leaves the server holding "unsaved updates" (spec (g)). Room errors (full, too big) go back to the normal path with a console warning; only a lost write permission is read-only. `whyUnbound()` is logged to the console after 5 s, nothing more.
- **One websocket per visit** (v4.8.13). `/api/ws?token=` serves the whole visit; `collab.js` sends `{type:"join", ns, path, seq}` per note and drops every note message until the `joined` for the latest seq (server sends it before the note's presence), so nothing from the left note leaks in. The server (`collab/connection.go`) runs EVERY join through `Conn.Authorize`, the same check as the handshake (`WSHandler.authorize`); a refused join also leaves the old note; joins are rate limited (burst 20, 20/s); a join after the session token's expiry is refused and the socket closes at expiry. Losing access while in a note (`DropUsers`, or `access-changed` → `RecheckAccess`, also from the Redis backplane) takes a visit socket out of that note only (`note-left`, the client asks again); `DropUsers` then rechecks through `Authorize` under each conn's lock, so a join checked against the old list cannot stay. The per-note URL (`?ns=&path=`) still works for tabs from before, and a per-note socket that loses access is still CLOSED, since that client only rechecks by reconnecting. Client fallback for an older backend: no `joined` ever confirmed when the socket closes, or none within 2 s of a join, means per-note mode for the visit. The toolbar dot is "Live" only once the server answers (a proxy can open a socket and pass nothing) and "Not live" after `LIVE_DOWN_AFTER_MS` (2 s) down; no dot with live collaboration off.
- **A queued autosave is flushed on navigation, never cancelled** (v4.2.1+). `openNote` / `openNoteDirect` / `handleSelectNs` used to `clearTimeout` the previous file's pending save, which silently discarded every edit made inside the debounce window. They now `await flushPendingSave()`, and the order is load-bearing: it must run **before** `getNote()`, because `etagRef` is shared, so a save that ran afterwards would send the *new* file's etag with the *old* file's content. An editor that debounces internally registers its pending state through `registerFlush` so it can be drained at the same point — the drawing canvas does this. Do **not** flush from an unmount cleanup: by then the app has moved on and the content would be applied to the next note.
- **`<Suspense>` is not error handling** (v4.2.1+). It covers a *pending* dynamic import; a *rejected* one throws to React's root and unmounts the whole app — blank page, no sidebar, no way out. Every `React.lazy()` surface must sit inside `ChunkErrorBoundary` (or `EditorErrorBoundary`, which flips Live to Basic), and its factory must go through `loadWithRetry`. `/assets/` also 404s on a miss rather than falling back to `index.html`, so a stale tab gets a clean failure instead of HTML parsed as a module.
- **A flex item that must scroll needs `min-width: 0`** (v4.2.1+). The task board's columns were unreachable with no scrollbar: `.tb-panel` is a flex item of `.split-view` (a flex row with `overflow: hidden`) and defaulted to `min-width: auto`, so it refused to shrink below the intrinsic width of N fixed columns, grew past the viewport, and was clipped. `overflow-x: auto` on the inner element can never fire while its parent is sized by its own content.
- **A command the UI tells you to RUN must be pasteable** (v4.3.3+). `<your-token>` is a shell **redirection**, so `mdnest login https://x <your-token>` fails with `no such file or directory: your-token` the moment it is pasted — and every `CodeBlock` in Settings has a Copy button that reproduces the text verbatim, so the instruction meant to unblock someone is the next thing that breaks. Use literal stand-ins (`mdnest_yourtoken`, `notes`, `@myserver`). Bracket notation stays fine in prose, in `Usage:` synopses, and in JSON config blocks, which are pasted into a *file*. This is the same rule the CLI adopted in v4.1.3; the lesson worth keeping is that the convention was written down and tested for **CLI output only**, so the surface that needed it most sat outside the test's reach for two years. `__tests__/pasteable-commands.test.js` closes it — and was itself verified against the pre-fix file, both that it flags all nine and that it does not flag the JSON block.
- **Colour goes through a token, never a literal** (v4.3.0+, `theme.css`). App.css / index.css / TaskBoard.css contain no hex; a literal is a colour that silently will not switch theme, and it fails invisibly for whoever is not on the theme the author was using. The layering is load-bearing rather than tidy: a *semantic* token (`--border`, `--surface-2`) may point at a different primitive per theme, which is the only reason light mode works. In Mocha a border and a raised panel can share a value because both read as "lighter than the page"; in Latte a border must be *darker* than what it encloses. `#313244` was a background 78 times and a border 102 times, so mapping by value would have flattened every light-mode border. The sharper case: `#1e1e2e` was also a *text* colour 33 times (a label on a filled accent button) — by value the page background, by role `--text-inverse`, which stays light when the page turns light. `__tests__/theme-tokens.test.js` pins that no literal creeps back, that every bare `var()` resolves, and that nothing reaches past the semantic layer to a `--ctp-*` primitive. Adding a colour means adding the semantic token to BOTH blocks in `theme.css`.
- **A new light-mode colour must be measured, not chosen** (v4.3.0+). `__tests__/theme-contrast.test.js` resolves every var() chain and asserts WCAG AA. Catppuccin Latte is a good palette that tunes its accents to sit on white *as accents* — icons, fills, large type — while mdnest uses them as body text, so stock Latte yellow measures 2.31:1 and green 2.96:1 against a 4.5:1 floor. Five hues are deliberately darker than upstream for that reason; don't "fix" them back. Dark mode's `--text-muted` is under AA and always has been (3.36:1) — that is pinned at its current level rather than asserted at AA, so it cannot silently get worse, and raising it is a deliberate design decision about 71 call sites, not a side effect.
- **A surface that draws imperatively will not re-theme on its own** (v4.3.0+). mermaid SVG and the Excalidraw canvas are written into the DOM outside React's control, so a theme change redraws nothing unless the theme is in the effect's dependency array — that is what `useTheme()` is for. mermaid additionally needs `applyMermaidTheme()` called at the top of the render effect, because its config is global and applies at *render* time; relying on a subscription elsewhere having fired first makes correctness depend on observer registration order.
- **Sanitization (v3.11.7+, `sanitize.js`): every path that puts rendered markup into the DOM goes through it.** `innerHTML` / `dangerouslySetInnerHTML` with `marked()` output, GitHub release notes, or mermaid SVG must call `sanitizeHtml` / `sanitizeSvg` — note bodies are user-authored and shared between users, and marked passes raw HTML through by design. If you add a new render target, route it through the same module rather than sanitizing inline. Two traps, both load-bearing: `sanitizeSvg` needs `ADD_TAGS: ['foreignObject']` because mermaid puts flowchart labels inside one and DOMPurify's svg profile excludes it (without it, diagrams render as blank shapes — nothing throws); and do **not** additionally allow `div`/`span`, because once allowed they fail DOMPurify's namespace check instead of being unwrapped and the labels vanish again. `sanitizeHtml` deliberately keeps `class`, `data-*`, and task checkboxes — the Preview's post-passes depend on them.
- Wikilinks (v3.11.5+, `wikilink.js`): resolution runs against the current namespace tree only (built via `buildPathIndex(tree)` and memoized in `App.jsx`, shared by `Preview.jsx` and the Live editor). Round-trip fidelity is the hard requirement — the Live editor stores literal `[[...]]`, but Milkdown's serializer escapes `[[`→`\[\[` in plain text, so `markdownUpdated` routes every serialized doc through `restoreWikilinks()` before `onChange`. Don't add a wikilink node to the schema — the decoration + serializer-unescape approach is deliberate so bytes never change.
- **A label's background is the shape that PAINTS it, not the first shape you find** (v4.3.1+, `mermaid-config.js`). `fixMermaidTextColors` picks each label's ink from the brightness behind it, and it got that wrong twice, in ways worth remembering because neither throws. (1) Mermaid nests an empty `<rect></rect>` spacer inside every flowchart node's `g.label`; it paints nothing but inherits the themed `mainBkg`, so the walk read `#313244` for a `#cfe4ff` node and inked it light-on-light. Candidates are now measured with `getBBox()` and zero-area shapes are skipped. (2) An **edge** label has no shape at all — mermaid paints it with a CSS `background-color` on the HTML inside the `foreignObject` — so an HTML label's own background now wins over any shape behind it. Brightness is composited over the diagram ground (`PALETTES[theme].background`) because that chip is half-transparent; the previous canvas parse returned `NaN` for any `rgba()` and only reached the right ink by accident. An unresolvable fill falls back to the theme's ordinary ink, never the light one — white on a pale canvas is the same invisibility.
- **`--text-inverse` is the ink for the ACCENT, not for anything coloured** (v4.3.1+). It resolves to `#1e1e2e` in dark and `#ffffff` in light, which is right on a filled accent button and wrong on anything that is bright in *both* themes. `--highlight` (the comment/search yellow) is exactly that, and inking it with `--text-inverse` put white on yellow at 1.32:1 in light mode. Marker text uses `--highlight-ink`. The palette assertions alone cannot catch a relapse — no ratio is wrong until you know which token the rule reached for — so `theme-contrast.test.js` also reads App.css and requires every rule filled with `--highlight` to set `--highlight-ink`.
- **The file toolbar wraps; it must never overflow** (v4.3.1+). It is one flex row whose groups are all `flex-shrink: 0`, so the only elastic item is `.toolbar-path` in the middle. When it was `flex: 1` with no `overflow` it grew to fill the row and then spilled its own children — the filename over the comment button, Rename over the settings icon — on any narrow editor (a 13" laptop, or any window with the comment panel open). It is `flex: 0 1 auto` with `margin-right: auto` now, the filename ellipsizes, and `.toolbar` sets `flex-wrap: wrap`. `tests/browser/toolbar-fit.spec.js` pins it at 1440 and 1024. Two things that test has to do and a naive one would not: skip nested pairs (Rename and Delete are *inside* `.toolbar-path`, and a parent enclosing its children is not a collision), and hit-test the intersection rather than trusting rectangles, because a control clipped by an `overflow: hidden` ancestor still reports its full box while painting nothing.
- Mermaid: `LiveEditorCrepe.jsx` defines an inline `mermaidNodeView` that renders the `MermaidBlock` React component for `code_block` nodes where `language === 'mermaid'`. The compose-mermaid plugin runs after `SchemaReady`, reads Crepe's existing `code_block` factory from `nodeViewCtx`, and writes a wrapper that delegates to it for non-mermaid blocks — so Crepe's CodeMirror UI still works for other code languages AND mermaid renders via our React component.
- Image upload: Crepe's `image-block` `onUpload` calls `uploadImage()` in `api.js`. `proxyDomURL` resolves the bare-filename markdown src (e.g. `![](photo.png)`) into `/api/files/<ns>/<dir>/<file>?token=<jwt>` for rendering — the `?token=` query param is the auth-fallback the middleware accepts for `<img>` GETs that can't carry an `Authorization` header.
- **The tree must refresh for writes that never touched the API** (v4.1.3+, `tree-refresh.js`). `tree-changed` is broadcast from the mutating-HTTP wrapper in `main.go`, so it fires *only* for changes that came through the API — git-sync pulling another machine's commits, a host-side editor, or a restored backup produce nothing. Do not gate the poll on `appConfig.liveCollab`: a connected websocket is not evidence the tree is current, and that gate meant installs running both collab and git-sync got no automatic update at all. Automatic refreshes pass `{ soft: true }` so they skip `treeLoading` — the sidebar draws an indicator bar whenever that's set, which is right for a user-initiated Refresh and pure noise on a timer.
- **The tree's drop target and create target are whatever the gesture implies** (v4.2.1+). Three rules that were each wrong once: an expanded folder's *contents area* is a drop target for that folder (otherwise a drop there bubbles to `.sidebar-tree`, which means "move to the namespace root" — so aiming inside a folder moved the file out of it); a **file** row must bail out of its drop handler *before* `preventDefault`/`stopPropagation`, so the event keeps bubbling to the containing folder instead of being swallowed; and the namespace root is a real row (`.tree-root-row`), because selecting a folder aims `+ Note`/`+ Drawing`/`+ Folder` at it and there would otherwise be no way back to the top level and no visible root drop target. The create destination is shown in each button's tooltip — it is invisible otherwise, which is what made "+ Note" landing somewhere unexpected feel arbitrary.
- Per-namespace last-file memory: `localStorage` key `mdnest_last_path:<ns>` records the path of whichever note was last opened in each namespace. Restored on namespace switch and on initial load when there's no URL hash. URL hashes still win for explicit navigation. Per-file scroll position lives in `mdnest_file_prefs:<ns>/<path>.scrollPct` (existing pre-v3.10 mechanism).
- Crepe nodeView composition: when overriding a node view that Crepe registers (e.g. `code_block` for mermaid, `table` for the click-to-cursor fix), the pattern is to wait for `SchemaReady`, read the existing entry from `nodeViewCtx`, then append a new entry with the same node-type id. `Object.fromEntries(nodeViewCtx)` keeps the last entry for duplicate keys, so ours wins; we keep a reference to the original factory and delegate to it for cases we don't want to override.
- Both editor implementations share the same onChange/content props — Crepe is now the only Live editor, but `App.jsx` keeps its lazy import named `LiveEditor` so the JSX call site stays editor-agnostic.

### Namespace Model
- Namespaces are NOT created at runtime — they are host directories mounted via Docker volumes
- Configured in `mdnest.conf` as `MOUNT_<name>=<host_path>`
- `setup.sh` generates docker-compose.yml volume mounts from these
- Backend sees them as subdirectories under NOTES_DIR
- GET /api/namespaces lists them (reads top-level dirs)
- **App-managed data that is NOT user notes needs its own declared volume.** `/data/notes` is not itself a volume — `setup.sh` bind-mounts each `MOUNT_` namespace *individually* — so anything the backend creates under `NOTES_DIR` at runtime lands in the container's writable layer and is destroyed by `./mdnest-server rebuild` (`compose up --force-recreate`). v4.2.0's Marp theme catalog hit exactly this in review: `.marp-themes` is a reserved system namespace created at runtime and deliberately never mirrored to a git remote, so a rebuild would have wiped every custom theme with no copy anywhere. The fix is the pattern `mdnest-secrets` already uses — `setup.sh` emits a **named volume** (`mdnest-marp-themes:/data/notes/.marp-themes`) when the feature is on, and `tests/setup-marp-themes.sh` pins that the generated compose both mounts *and declares* it. The Helm chart is unaffected: it mounts all of `/data/notes` as a PVC. If you add another system namespace, add its volume in the same change.

### Client CLI (`mdnest`, bash)
- Runs under `set -e` — a helper used as a bare statement must `return 0` on its success path or it aborts the script. (This also leaks into anything that *sources* the CLI: `tests/cli-unit.sh` does `set +e` right after the `MDNEST_LIB=1 source` for exactly this reason.)
- **Under `set -e`, a PLAIN assignment from a command substitution is a silent script-killer** (v4.3.2+). `x=$(cmd)` takes the substitution's exit status, so the script dies on that line and everything below it — *including the error handling written for exactly that failure* — never runs. This is not a hypothetical: it shipped in `api()` in v1.0 and survived 47 releases. `mdnest servers` printed the table header, exited with curl's `28`, and never reached the `unreachable (DNS|refused|timeout|TLS)` labels or the "works in your browser?" hint; because the server list is globbed alphabetically, one dead server also hid every healthy server sorting after it. Write `x=$(cmd) || x=""` — always — and do **not** follow it with `rc=$?`, which overwrites the real status with the now-successful assignment's `0` and reports `unreachable (curl 0)`. `run_errexit_lint` in `tests/cli-unit.sh` fails the build on a new unguarded site; it proves itself against a probe file, because a lint that cannot fail is worse than none. Two exemptions, both verified rather than assumed: `local x=$(...)` is safe (`local` is a builtin, so the status is the builtin's own — which is why the CLI is full of them), and a substitution ending `|| true)` is already guarded from the inside.
- **The same class also hides in a trailing `&&` list, and the lint cannot see it.** `[ -n "$x" ] && do_thing` as the *last statement of a function* makes a false test the function's return value, which `set -e` then treats as a failure. This was reintroduced *inside* the fix for it, and the behavioural test (`run_unreachable_suite`, "servers: unreachable server still exits 0") caught it, not the lint. Conditions inside an `if` are exempt from errexit; a trailing `&&` list is not. Prefer `if`.
- **The CLI is pull-only, so a fix does not reach anyone until they run `mdnest update`** (v4.3.2+). Nothing pushes, and the in-app banner tracks the *server*, not the CLI. Before v4.3.2 the only version check was a MAJOR mismatch at login, which is how a bug present since v1.0 stayed invisible to every client running it. `version_gt()` + `cli_update_notice()` now print one line — naming both versions and the exact command — in `mdnest servers`, `mdnest whoami`, and `mdnest login`. Deliberately **not** on every command (there is no update cache, and a per-read check would be its own bug), and deliberately compared against the **server's** version rather than GitHub's latest: no extra network call, no new failure mode, and CLI + server ship from the same repo at the same number. Known limitation, stated rather than hidden: a client whose server is *also* stale hears nothing. `version_gt` is pure bash — no python3, no jq, and no `sort -V` (busybox sort has none) — and is pre-release aware the same way `isVersionNewer` in `App.jsx` is, so a `-dev` build never nags about the release it is a candidate for.
- **A read-modify-write must carry the version it read.** `mdnest edit`
  (v4.4.0+) exists because the only way to change one line used to be `read` +
  rebuild + `write`, and a plain `PUT` overwrites whatever the web UI,
  git-sync, or another agent saved in between while printing
  `{"status":"ok"}`. The PUT sends `If-Match` with the ETag from its own read,
  so the backend answers 409 instead. Two things this needed and a naive
  version would miss: `api()` had to grow an optional response-header dump
  (`-D`) because the ETag is only in the headers — do **not** recompute it
  client-side from the content, that duplicates `canonicalForETag` in a second
  language and silently rots; and the splice is **pure bash parameter
  expansion**, not sed/awk, because a note is arbitrary markdown — a regex tool
  reads `.`/`*`/`[` in the needle and expands `&`/`\1` in the replacement,
  corrupting exactly the code fences people keep in notes. Quoting the pattern
  inside `${...}` forces literal matching and needs no python3/jq/awk tier at
  all.
- **`$( )` strips trailing newlines, so every capture of note content needs a
  sentinel.** `x=$(cmd)` silently deletes the note's final newline, which turns
  "leave the rest of the file alone" into a lie. `cmd_edit` captures as
  `$(... ; printf 'X')` and strips the `X`. This bit twice in one change — once
  on the read and again on the splice result — and the second one survived the
  first fix. Note the read uses `&&` before the `printf`, not `;`: with `;` the
  status is printf's `0` and a failed `api()` sails straight past its error
  handling.
- **Body content goes to curl as `--data-raw`, never `-d`.** `-d @foo` makes
  curl read a *file* called `foo`, so a note whose content merely STARTS with
  `@` (`@mention …`) could not be created, written, appended or prepended —
  it failed with curl's exit 26, surfaced as "couldn't reach the server".
  Shipped in v1.0, fixed in v4.4.0. `--data-raw` is `-d` without that case.
- **Every python3 call goes through `py()`** (v4.1.2+), never `python3` directly. It passes `-S` (skip site initialisation, so a user's broken site-packages/`.pth` can't print a traceback into our output — issue #87) and `-E` (ignore `PYTHON*` env), drops python's stderr, and returns its exit status. **Gate on the result, not on presence:** `have python3` passing does not mean python3 *works*, so every call site must fall through to its pure-bash/awk tier when `py` fails. A present-but-broken interpreter is the failure mode that bit us, not a missing one.
- Dependency tiers, in order: python3 (`py`) → jq → pure bash/awk. The awk tier is not a token gesture; it is the tier that runs on a fresh machine, and `tests/e2e-docker.sh` proves it in a bare alpine container with neither python3 nor jq.
- **Human-facing output is rendered in awk only** — `format_tree` / `format_namespaces` for `mdnest list` have deliberately no python3/jq tier, so a listing is byte-identical on every machine and a broken python can't garble it. Verified on gawk, mawk and busybox awk. Raw API JSON stays available behind `--json` / `MDNEST_JSON=1` for scripts; don't make raw JSON the default output of a command again.
- Adding a command means three edits: the `case` dispatch, the help **Commands** list, and the help **Examples** block (`grep -c '<cmd>' mdnest` ≥ 3).
- **A download never trusts the server with where it lands** (issue #114). `mdnest download` writes to a temp file in the target folder and renames it only after a non-error status, so a refusal (413/403) leaves nothing behind; it never overwrites an existing local file; and `disposition_filename` reduces the server-chosen name to a bare file name (no folder part, decoded `%2F` included, no leading dots). The move/copy request body is built with `json_str`, pure bash, so a quote or backslash in a path cannot break the JSON on the no-python3 tier.
- **The frontend image serves the repo-root CLI at `/cli/mdnest`** (v4.8.5+), with `frontend/public/cli/install.sh` beside it. The script is outside the `frontend/` build context, so it comes in as a named build context `cli` (repo root): `additional_contexts` in the compose file `setup.sh` writes (needs Compose 2.17+, which `setup.sh` checks and names), `build-contexts: cli=.` in `release.yml` and `ci.yml`, and `--build-context cli=.` for a hand `docker build`. Without it `COPY --from=cli` fails the build on purpose. Never commit a second copy of the script. `tests/setup-cli-context.sh --build` does a real compose build from the generated file; `tests/e2e-browser.sh` checks `/cli/mdnest` is byte-identical and runs the tab's Install command, then its Connect command on a pty. The installer only installs: installing and connecting are separate steps in the tab on purpose. nginx's `/cli/` location 404s on a miss, never the SPA's index.html.
- **`mdnest login <url>` with no token prompts on `/dev/tty`, never stdin** (v4.8.5+): under `curl ... | bash` stdin is the pipe. No terminal means exactly the old usage + exit 1, so scripts are unchanged. A pty test must wait for the terminal's ECHO flag to go off before typing the token (`tests/pty-drive.py`), or the kernel echoes it and the "not echoed" check is a race. `MDNEST_TTY` is the test hook for "no terminal".
- `mdnest update --server @alias` (v4.8.5+) fetches only that server's `/cli/mdnest`, never GitHub, since the point is to match the server.
- `mdnest update` self-updates from `raw.githubusercontent.com/.../main` — so a CLI fix reaches users when it lands on `main`, independent of the tag/Release (those drive the in-app *server* update banner). Corollary: the CLI installed on this machine lags `develop`, so test with `./mdnest`, not `mdnest`.
- **Never print `<angle brackets>` inside a command you tell the user to RUN** (v4.1.3+). `<name>` is a shell redirection, so a hint like `mdnest login @<name> ...` errors in zsh and bash the moment it's pasted — the recovery instruction became a second error. Use literal placeholder words (`@myserver`, `mdnest_yourtoken`) whenever real values are being substituted in. Bracket notation is still fine in `Usage:`/`--help` *synopses*, which nobody pastes. `tests/cli-unit.sh` asserts no suggested command contains a bracket.
- **Validate before you conclude, and before you persist.** Two failures of the same shape shipped together in `login`: reporting "this server has no SERVER_ALIAS configured" for a host we never reached (the curl exit code was thrown away, so "couldn't connect" and "connected, no alias" were one empty string), and saving a non-URL to disk — where it became the *default* server. Keep curl's exit status when the reason matters (`fetch_server_config` + `curl_reason`), and never write config you haven't validated.

### Docker
- Backend: golang:1.24-alpine build, alpine runtime. **tini is PID 1** (v4.8.6+, #133): `ENTRYPOINT ["/sbin/tini", "--"]`. With mdnest as PID 1, git helpers orphaned by a timeout were never reaped and piled up as zombies until the pod hit its PID limit. Do not override the backend container's command/entrypoint in Helm or compose without keeping tini. `tests/backend-image-init.sh` (pre-push Docker tier) pins it.
- Frontend: node:20-alpine build, nginx:alpine serve
- Nginx proxies /api/ to backend service
- SPA fallback: try_files -> /index.html
- git-sync: optional (auto-enabled when keys in git-sync/keys/), alpine/git with cron-style loop
- postgres: optional (auto-added by setup.sh when AUTH_MODE=multi), postgres:16-alpine with healthcheck

### MCP Server (Node.js)
- Uses @modelcontextprotocol/sdk with StdioServerTransport
- Config via env vars: MDNEST_URL, MDNEST_USER, MDNEST_PASSWORD
- Authenticates on startup, stores JWT, auto-refreshes on 401
- Tools: list_namespaces, list_tree, read_note, write_note, create_note, create_folder, delete_item, move_item, search_notes
- Resources: notes://{namespace}, notes://{namespace}/{path}
- search_notes reads tree, fetches each .md, case-insensitive match, max 20 results
- Uses native fetch (Node 18+), no extra HTTP deps

## Release Process

**Ship carefully: other teams run mdnest in production.** Before any release,
`md-ship` Step 0 (the ship gate) must hold, and it is blocking:

- every change soaked on the dev stack (features at least a day), and at most
  one release a day unless it fixes a security hole or data loss;
- `develop` is green on the commit being released, and the audits were re-run
  that day;
- `bash tests/release-gate.sh` passed on the release commit itself. It runs the
  pre-push release tier, Go tests against a real Redis, shellcheck and the
  end-to-end suites the changed files call for, and records the tree it tested.
  The pre-push hook accepts a push to `release/*` or `main` only for that tree;
- every topology the change touches was run (single, multi, HA), and an upgrade
  from the last release was tried when anything stored changed;
- nothing users rely on is removed without the owner's sign-off (#135), and no
  change narrows what a superadmin can do in the default configuration;
- every required check on the release PR is green. `main` requires the CI jobs
  as well as the Security Audit ones (`scripts/apply-main-branch-protection.sh`).

A regression in a released version is fixed with a test shown failing on that
tag (`MDNEST_BUILD_ROOT=<checkout of the tag>`).

- **One PR per release.** Bundle all the work for a release into a single branch (`feat/<name>` or `release/v3.X.Y`) and open **one** PR against `main`. Don't open intermediate / sibling PRs for sub-features during the same release cycle — they cause merge conflicts on shared files (`CHANGELOG.md`, the three version files, `App.jsx`, docs) when one lands while another is still open. Hotfix exception: a true emergency (security CVE, prod crash) can ship as its own PR ahead of the release, but flag it before opening. v3.10.0 hit exactly this — PR #10 (v3.9.1) merged while PR #11 (v3.10.0) was open and produced six-file conflicts; resolve by merging `main` into the release branch and keeping the higher version + the deletion of any files the cutover removed.
- **Version scheme — `develop` carries `X.Y.Z-dev`, releases drop the suffix.** `develop` always holds the in-flight version with a `-dev` pre-release suffix (e.g. `3.11.3-dev`), so a develop/staging box reads `v3.11.3-dev` ("candidate, still validating") and production reads the plain `v3.11.3`. The **release branch sets the plain `X.Y.Z`** (drops `-dev`); after the release merges, bump `develop` to the *next* `X.Y.(Z+1)-dev`. `isVersionNewer` (App.jsx) is pre-release-aware so a `-dev` build shows no false "update available" against the last release but does see the final release as newer once it ships.
- Set the version in four files — on the release branch use the plain `X.Y.Z`; on `develop` use `X.Y.Z-dev`:
  - `backend/handlers/config.go` — `"version": "3.X.Y"`
  - `frontend/package.json` — `"version": "3.X.Y"`
  - `mdnest` CLI script — `MDNEST_CLI_VERSION="3.X.Y"`
  - `deploy/helm/mdnest/Chart.yaml` — `appVersion: "3.X.Y"` (v3.11.7+, the Helm chart's default image tag). Note `version:` in the same file is the **chart's own** SemVer and moves independently — bump it when the chart's templates change, not on every app release. The release workflow passes `--app-version` when packaging, so a *published* chart is stamped from the tag either way; this file only governs `helm install ./deploy/helm/mdnest` from a source checkout.
- Update `CHANGELOG.md` with the new version section
- Merge to `main`, tag as `v3.X.Y`, push with `--tags`
- **Publish a GitHub Release for the tag** — `gh release create vX.Y.Z --title "..." --notes-file <file>` with the CHANGELOG entry as the notes. Tags ≠ Releases on GitHub: `git push --tags` only creates the git ref, but the in-app "update available" banner polls `https://api.github.com/repos/<owner>/<repo>/releases/latest` which returns **404** when zero Releases have been published — so without this step, no running mdnest install will ever notice a new version. The frontend's banner (`appConfig.latestRelease.name` + `.notes` preview) is also designed around Release metadata, not bare tag names. The clean recipe:
  ```bash
  # after tag + push --tags
  awk '/^## v3.X.Y —/{found=1} found{print} /^## v[0-9]/ && NR>1 && !/^## v3.X.Y —/{exit}' CHANGELOG.md > /tmp/rel-notes.md
  gh release create vX.Y.Z --title "vX.Y.Z — <headline>" --notes-file /tmp/rel-notes.md
  ```
- Run `/md-ship` skill after code changes to update docs, website, and test instance. (mdnest skills use the `md-*` prefix: `md-fix-bugs` clears the Bugs backlog, `md-add-improvement` the Features backlog, `md-ship` does the post-change docs/website/release chores.)
- Pre-push hook (`.githooks/pre-push`) verifies builds, security, lock files, version consistency
- New developers run `./mdnest-server dev-setup` to activate hooks

### The merge-to-main security gate (required status checks)

**Nothing merges to `main` until the Security Audit passes — this is enforced server-side, not by trust.** The `Security Audit` workflow (`.github/workflows/security-audit.yml`) runs four jobs on every PR to `main` — `Frontend (npm audit)`, `MCP Server (npm audit)`, `Backend (govulncheck)`, `Shell scripts (shellcheck)` — and those four are **required status checks** on the `main-branch` repository ruleset. A red or pending check blocks the merge (`gh pr merge` refuses; the PR sits at `mergeStateStatus=BLOCKED`). The `main-branch` ruleset has **no bypass actors** (`current_user_can_bypass: never`), so the gate binds even the repo owner — the separate `mahsan_bypass` ruleset only exempts the *pull-request-required* rule on non-default branches (that's how `develop` takes direct pushes), it does **not** exempt `main`'s status checks.

- **Why it exists / the failure it prevents:** *running* a check is not *requiring* it. Before this gate, the audit ran but wasn't required, so a PR merged at `mergeStateStatus=UNSTABLE` with a failing check — that's how the `crypto/tls` stdlib vuln **GO-2026-5856** landed on `main` via the v3.11.5 release (CI caught it only on the *post-merge* push). Bumping Go `1.26.4 → 1.26.5` (go.mod `go` directive + `backend/Dockerfile` builder image) fixed the vuln.
- **Read the threshold the gate actually sets before "fixing" what an audit
  prints.** Both npm audit jobs run `--audit-level=high`, so a moderate
  advisory is below the gate on purpose (`security-audit.yml` says as much:
  "Bump severity here when those are cleaned up"). A bare local `npm audit`
  lists every severity, and reading that as the gate is how v4.4.0-dev grew an
  `overrides` entry for a MODERATE advisory that was never blocking anything —
  and the override then made the tree invalid to npm's legacy quick-audit
  endpoint (`400 … Invalid package tree`), which refuses the whole audit. One
  moderate advisory traded for no audit signal at all. Local runs passed
  because local npm reached the working bulk endpoint while CI fell back to
  the legacy one — **verifying in one environment verified one environment**,
  which is the durable half of this lesson: CI pins Node 20 (npm 10.x) and a
  dev box on Node 24 (npm 11.x) is a different audit client, so test a
  dependency change in `node:20` before believing it.

  **Updated in v4.5.1: that `@xmldom/xmldom` override is now in place and
  required.** The advisory was re-rated **high**, which put it above the gate
  and blocked every merge to `main` — the exact condition the old note said to
  revisit on. `speech-rule-engine@4.1.4` still pins `0.9.10` exactly and
  `marp-core`/`mathjax-full` are both already at their latest, so an
  `overrides` entry forcing `^0.9.12` is the only route, and re-testing under
  `node:20`/npm 10.8.2 shows it no longer breaks the audit the way it did in
  v4.4.0-dev. Two things made it safe to take: `xmldom` and
  `speech-rule-engine` are **tree-shaken out of every shipped chunk** (grep
  `frontend/dist/assets/*.js` — zero hits), so nothing about the browser
  bundle changes; and Marp still renders, verified by rendering a real deck
  with front-matter, pagination and math through `marp-core` in Node rather
  than by trusting the unit tests, which cover our own `isMarpDoc` and not
  marpit's YAML parsing.
- **"Could not check" is not "found something", and the hook got this wrong.**
  `npm audit` exits non-zero for a real advisory AND for a failure to reach the
  advisories endpoint. The hook discarded stderr and reported every non-zero
  exit as `VULNERABILITIES FOUND`, so an npm outage (503s on
  `/-/npm/v1/security/advisories/bulk`) blocked pushes while naming the wrong
  cause — and `npm audit fix` exited 0 having applied nothing, which is how the
  same outage looks from the other side. `npm_audit_check` now separates them:
  an unreachable endpoint SKIPs with the reason printed (matching how the hook
  already treats a missing Go toolchain or shellcheck), a real finding still
  blocks. `tests/pre-push-audit.sh` drives the helper against fake `npm`s
  covering all seven outcomes, and the load-bearing one is "REAL vulnerability
  still exits non-zero" — a fix here that reclassified too much would silently
  disarm the check. Same rule as `curl_reason` in the CLI: keep the reason when
  the reason is what the reader has to act on.
- **The local pre-push hook is defense-in-depth, not the gate.** It runs `govulncheck` too, but **silently skips it when `go` isn't installed on the host** (e.g. this dev machine) and can be `--no-verify`'d — and it doesn't run at all on a GitHub-side PR merge. Treat CI required checks as the authoritative gate; never assume a green local push means the security scan ran.
- **Managing the gate as code:** `scripts/apply-main-branch-protection.sh` (idempotent) adds/updates the required-status-check rule on the `main-branch` ruleset. It needs a token with repo **Administration: write** (a contents/PR-scoped fine-grained PAT gets HTTP 403 on the ruleset PUT). The check-context strings in that script must match the workflow job `name:` values **exactly** — a typo becomes an "Expected" check that never reports and blocks `main` permanently.

### The `develop` gate (contributors gated, owner bypasses)

`develop` is the integration branch: every contributor PR lands there first and soaks for a few days before the release PR to `main`. Its ruleset is `develop-branch`, managed by `scripts/apply-develop-branch-protection.sh` (idempotent — creates if absent, else replaces the rules).

- **What it enforces:** `deletion` + `non_fast_forward` protection, **1 required approval**, and **9 required status checks** — the five `CI` jobs (`ci.yml`) plus the same four `Security Audit` jobs `main` requires.
- **The owner (admin role) is a bypass actor, deliberately.** Required status checks gate *ref updates*, not just merges, so without the bypass the `md-fix-bugs` / `md-add-improvement` flow — merge each verified branch straight into `develop` locally, then push — would start getting rejected. So `develop-branch` gates *contributors*; the local `.githooks/pre-push` remains the owner's gate. Because that hook silently skips `govulncheck` without a host Go toolchain, `security-audit.yml` also runs on **pushes** to `develop`, so the branch tip is scanned even when the hook couldn't.
- **Why 1 approval and not 0:** outside contributors work from forks and have **no write access to the base repo**, so they cannot merge anything today regardless of rulesets — merging requires write on the base. But `mahsan_bypass` (`~ALL`) only requires *that a PR exist*, with `required_approving_review_count: 0`. The moment anyone is granted write, they could self-merge into `develop`. An author cannot approve their own PR, so requiring 1 routes any future collaborator through the owner. Set in advance rather than after.
- **`require_code_owner_review` is left off on `develop`, and is inert on `main`** — there is no `CODEOWNERS` file in the repo. Adding one would be actively harmful while the owner is sole maintainer: `main-branch` has no bypass actors, and GitHub forbids self-approval, so a `CODEOWNERS` entry would hard-block the owner's own release PRs.
- **Check-context strings must match what Actions *reports*, not the job `name:`.** For a **matrix** job the reported context appends the matrix values — `ci.yml`'s `images` job carries both `name` and `context` keys, so it reports as `Docker images (build only) (backend, backend)`. Always verify against a real run before editing the list, or the branch blocks forever on an "Expected" check that never arrives:
  ```bash
  gh api "repos/<owner>/<repo>/commits/$(git rev-parse origin/develop)/check-runs" \
    --jq '.check_runs[].name' | sort -u
  ```
- **Repository-role bypass ids are asserted, not looked up** — a user-owned (non-org) repo has no roles listing endpoint. `5` is the admin role; the script verifies by asserting `current_user_can_bypass == "always"` after writing and exits non-zero if not, since a wrong id silently breaks the owner's direct pushes to `develop`.

### Where contributor PRs should target

`main` is still the default branch, so GitHub prefills `main` as the base for fork PRs and contributors have to retarget by hand. This is a known, accepted rough edge — the trunk-based model (PRs into `main`, release branches cut off it) is the ecosystem norm that contributors expect, whereas mdnest uses git-flow because it ships explicit versioned self-hosted releases with an in-app update banner keyed to GitHub Releases. Two ways to close it if the friction becomes real: make `develop` the default branch (**repoint `main-branch`'s condition from `~DEFAULT_BRANCH` to literal `refs/heads/main` first**, or the whole security gate silently follows the default onto `develop`), and/or add a required check on `main` that fails when a PR's head isn't `develop` / `release/*` / `hotfix/*`. Neither is in place yet.

## Debugging Practice

- **Read the error message literally** — "expected 12 not 11" means count your Scan args, don't blame Docker cache
- **Never assume the problem is external** (cache, stale code, old binary) without evidence — check YOUR code first
- When adding a column to a SQL query, grep ALL Scan() calls for that table and update every one
- When a fix doesn't work after 2 attempts, **stop guessing and look at the actual data**
- Read `mdnest.conf` and `.env` for ports, credentials, and config — never hardcode or guess
- Use the running server's API to fetch real content: `curl -s http://<BIND_ADDRESS>:<BACKEND_PORT>/api/note?ns=...`
- Use `python3 -c "print(repr(chunk))"` to see exact bytes (escapes, `<br/>` vs `\n`, whitespace)
- Check the live Docker containers: `docker ps | grep mdnest` — know which port serves what
- When the dev machine runs the same server the user tests against, use it directly instead of asking the user for logs

## What NOT to Do

- Do not add a database dependency in single mode — files are the source of truth for notes; Postgres is only for user/permission management in multi mode
- Do not add runtime namespace/workspace creation — namespaces come from mounts
- Do not use `new marked.Renderer()` — use plain object for marked v15
- Do not hardcode paths or credentials — everything from env/config
- Do not add SSR — frontend is fully static
- Do not add heavy editor libraries (CodeMirror, Monaco) — plain textarea
- Do not break single-mode behavior — multi-user features must be fully conditional

## Scope discipline

- **Solve only the problem that's ours to solve; do our best but don't over-engineer.** Fix what mdnest itself produces (e.g. *guarantee* readable mermaid contrast in our render layer), but don't try to police or re-educate the world outside our box — don't edit users' `CLAUDE.md` at install, lecture authors about their color choices, or build elaborate guidance systems for mistakes that originate upstream. The render-layer guarantee is ours; the author's input is theirs. Prefer the smallest change that genuinely fixes the user-visible problem.

- **The core stays lean; new capability arrives off-by-default behind a flag.** mdnest's promise is a single-box deployment anyone can stand up with `setup.sh` and reason about end to end, with plain files as the source of truth. Features that add real value are welcome — but an operator who doesn't need one must carry none of its weight or risk: no extra dependency, no new env var to understand, no new failure mode. Measure this, don't assert it. When judging whether a change kept the promise, check the numbers that matter: new entries in `go.mod` / `package.json`, gzipped bundle delta, and whether `setup.sh`, `mdnest.conf.sample`, `docker-compose.yml`, the Dockerfiles, `mdnest-server` and `nginx.conf` moved at all. v3.11.7 added ~3,180 lines but only 100 of runtime code, zero Go deps, +368 B gzipped, and left every file in that list untouched — that shape is fine. A feature that grows the default install is not.

- **A configuration surface must never outrun the code behind it.** The backend silently ignores env it doesn't read, so a knob whose implementation isn't merged doesn't fail — it lies. v3.11.7 shipped a Helm chart offering `storage.backend=s3`, `collab.redis.*` and `mcp.enabled` before any of that code existed: `s3` would have written notes to the PVC while looking configured for a bucket, and a multi-replica deploy would have split collaboration state per pod, both while reporting `Ready`. Guard the option (`mdnest.validateSupported` in `deploy/helm/mdnest/templates/_helpers.tpl`) so it fails at install time naming what's missing, assert both directions in CI (the supported config renders; the unsupported ones are rejected), and **delete a guard in the same change that lands the capability behind it.** (The `collab.redis` and `mcp.enabled` guards have since been removed as the Redis backplane and the streamable-HTTP MCP transport landed; `storage.backend=git` added a git-sync coexistence guard of its own; and the `s3` surface was removed outright — it was never implemented, so `mdnest.validateSupported` now simply rejects any `storage.backend` other than `local` or `git`.)

- **Changing what mdnest *is* is a conversation, not a diff.** Adding an option is ordinary work. Trading away a founding property — files as the source of truth, namespaces from mounts, no DB in single mode — is a maintainer decision to make before the code is reviewed, however good the code is. When an incoming change does both, ask for it split so the mechanical part can land while the contentious part is decided.

## Testing

**Three test levels: run the one that fits the step, not everything every
time.** The entry point is `bash tests/check.sh --level <level>` (default
`develop`). Balance accuracy and speed: no hour-long verification below ship.

| Level | When | What runs | Target |
|---|---|---|---|
| `iterate` | while working on a branch | only what the change touches: `go vet` + `go test -race` for the changed backend packages, `npm test` if `frontend/` changed, `cli-unit.sh` if the CLI changed, and the feature's browser specs named in `MDNEST_E2E_SPECS` (add `MDNEST_E2E_HARNESS=collab` for two-user specs). Each once, no full suites | under 5 min |
| `develop` | before merging a branch into develop | the pre-push fast tier, `go vet` + `go test -race` on the whole backend with Redis, shellcheck, and the e2e suites the files changed since `origin/develop` call for, each once, sharded. A spec whose flake was just fixed gets `MDNEST_E2E_ARGS="--repeat-each 3"`, not 10 | about 15 to 20 min |
| `ship` | `md-ship`: a `release/*` or `main` push | the full gate, the only level that runs everything: every suite, compared with `origin/main`, recorded in `.git/mdnest-release-gate` for the hook. `bash tests/release-gate.sh` is the same thing. Upgrade checks when stored data changed stay a manual `md-ship` step | as long as it takes |

At `develop` and `ship` the images are built once and the browser suites run
in one lane beside everything else. The `@budget` timing tests run last,
alone: always at `ship`, where a failure blocks; at `develop` only when the
diff touches a `@budget` spec or the code it times (`BUDGET_CODE_PAT` in
`tests/check.sh`), and there a failure is a warning that prints the machine's
load, because those budgets react to load from other projects on the box. The pre-push hook is unchanged: it still refuses a `release/*` or
`main` push of a tree the ship level did not pass.

**Tiered, fully-local test strategy — no CI/remote needed.** All of it runs on the
host via Docker; the pre-push hook (`.githooks/pre-push`) wires it into the
release flow so nothing broken reaches `main`. Fast checks run on every push; the
heavier end-to-end suites run only when pushing toward `main` (a `release/*` or
`main` ref — detected from the refs git feeds the hook on stdin). Emergency
override: `MDNEST_SKIP_E2E=1`.

- **Fast tier (every push):**
  - `tests/cli-unit.sh` — instant pure-function checks of the CLI helpers
    (`urlencode`/`urldecode`/`json_top_string`) plus the `list` renderers
    (`format_tree`/`format_namespaces`), run across **four** parser
    environments: real `python3`; a **noisy** python3 (a PATH shim that prints a
    `.pth` traceback to stderr on every start — the issue #87 repro); a
    **broken** python3 (exits non-zero); and `python3`/`jq` force-disabled. This
    is the cheap guard for the class of bug where the CLI breaks — or leaks
    someone else's traceback — because of the machine's python rather than ours.
    The rendering checks run in the with- and without-parser passes and must
    agree, which is what keeps a python3/jq tier from creeping back into output.
    Also carries, as of v4.3.2, an **unreachable-servers suite** (runs the
    real CLI against a throwaway `HOME` pointed at two closed loopback ports —
    instant, no network — pinning that `mdnest servers` exits 0, prints one row
    per registered server, labels the dead one, and that `api()` reports why;
    ten of its eleven checks fail against the pre-fix CLI, and the eleventh
    catches the *partial* fix that leaves a stray `curl_rc=$?` behind), a
    **version-comparison suite** for `version_gt`/`cli_update_notice`, and
    **`run_errexit_lint`** (see the CLI conventions above). Plus a
    **login argument-handling suite** (v4.1.3+) that runs the real
    CLI as a subprocess against a throwaway `HOME`: it pins the exit status, that
    a rejected login leaves *nothing* on disk, that the unreachable path never
    mentions `SERVER_ALIAS`, and that no suggested command contains an angle
    bracket. (Run those via `login_run`, never inside `$(…)` — a command
    substitution is a subshell, so the `HOME` and status it sets are lost and the
    assertions pass vacuously.)
  - `tests/pre-push-audit.sh` — **new in v4.4.0.** Drives the hook's own
    `npm_audit_check` against fake `npm` shims for all eleven outcomes, with no
    network. It exists because the hook conflated "npm audit found advisories"
    with "npm audit could not reach the endpoint" (see the gate section above),
    and the danger in fixing that is over-classifying: the load-bearing check is
    **"a real vulnerability still exits non-zero"**, not the skip cases. Verified
    by mutation — 8 of its 11 checks fail against the pre-fix hook, and the three
    that pass in both are exactly the ok/block cases that must not change. The
    helper is `sed`-extracted from the shipped hook so the test cannot drift from
    the code it pins.
  - `tests/cli-edit-etag.sh` — **new in v4.4.0.** Drives the real CLI against a
    throwaway-`HOME` and a fake backend that reports the request it received,
    pinning that `mdnest edit`'s PUT actually carries `If-Match` and that a save
    landing inside the read-modify-write window is refused rather than
    overwritten. It is separate from `cli-unit.sh` on purpose: the unit tier can
    only prove the splice helpers are correct, and **helpers that work while
    nothing consults them are exactly how this bug comes back** — deleting the
    `If-Match` line from `cmd_edit` leaves every unit check green. Verified by
    mutation: that deletion fails 7 of its 9 checks, including "the concurrent
    save survived". The fake backend mutates the note *when it serves the GET*,
    so the race is deterministic and there is nothing to flake. Needs python3
    for the fake backend only and SKIPs without it; the CLI's own no-python3
    tier stays covered by `cli-unit.sh` and `e2e-docker.sh`.
  - `tests/cli-approval.sh`: **new in v4.8.5.** Drives the real
    `mdnest approval request` / `done` / `notify` (and the keepalive
    stopped notice) against a fake backend, also with
    python3 and jq broken. The hook has two allowed outcomes, the server's
    answer byte for byte or NOTHING with exit 0 (the agent's terminal prompt
    then answers), and the test pins both, plus that no policy file, a tool
    not in TOOLS or a NEVER_REMOTE match sends nothing at all.
    `tests/setup-agent-approvals.sh` pins the ENABLE_AGENT_APPROVALS plumbing,
    and `tests/browser/approvals.spec.js` the card (the browser harness turns
    the switch on).
  - `tests/server-unit.sh` — **new in v4.1.3.** Pure-function checks of
    `mdnest-server`, loaded through its `MDNEST_SERVER_LIB=1 source` hook (the
    mirror of the client CLI's `MDNEST_LIB`). Currently covers namespace-drift
    reporting — `namespace_drift_report` is split out from the Docker-querying
    `namespace_drift` precisely so it can be tested with no Docker and no running
    stack. Assertions run against whitespace-normalized output so they pin the
    words, not the column padding.
    Uses the CLI's `MDNEST_LIB=1 source mdnest` hook to load the real functions.
  - Plus the existing builds, `npm test`, audits, version consistency, shellcheck.
- **CLI smoke test**: `tests/cli-smoke-test.sh` exercises every `mdnest` note
  operation (create/write/append/prepend/read/move/delete/search/list, subfolder
  scoping, `mdnest://` decode) plus the stdin edge cases end-to-end against a
  disposable namespace. Targets `testing_workspace` by default (add
  `MOUNT_testing_workspace=<host_path>` to `mdnest.conf` + `./mdnest-server
  reload`). Override with `MDNEST_TEST_NS` / `MDNEST_TEST_ALIAS` / `MDNEST_BIN`.
  Creates everything under a unique `__clitest_*` folder and deletes it on exit.
- **End-to-end tier (pushing toward `main`):**
  - `tests/e2e-docker.sh` — builds the **backend from the working tree**, boots a
    throwaway single-mode instance, mints a token, and runs the CLI smoke test
    against it **twice**: on the host (python3 present) and inside a **bare
    `alpine` container with no python3/jq** (the truest fresh-machine repro).
  - `tests/e2e-browser.sh` — builds **frontend + backend**, boots the full nginx
    stack, seeds a note, then runs the **Playwright** suite in `tests/browser/`
    (login, tree, open/render a note, Live [Crepe] + Basic editors, search,
    create-via-UI). Installs Playwright + Chromium into `tests/browser/` on first
    run. Exit code 2 = prerequisites (docker/node) missing → the hook SKIPs it.
  - `tests/setup-default-theme.sh` — **new in v4.3.0.** Asserts a config knob
    actually reaches the generated `.env`. This class of failure is silent: the
    backend ignores env it does not read, so broken plumbing does not error, it
    quietly reverts to a default. Runs in the pre-push hook alongside
    `tests/setup-marp-themes.sh`, which existed from v4.2.0 but was never
    invoked by anything until now.
  - `tests/setup-sso-options.sh` — **new in v4.5.4.** The same class for the
    SSO switches (`SSO_DISABLE_PASSWORD_LOGIN`, `SSO_AUTOPROVISION_USERS`,
    `OIDC_GROUPS_CLAIM`): each reaches `.env`, a typo in a boolean fails setup
    instead of silently meaning "off", and a value exported in the shell does
    not leak in. Written because `setup.sh` never forwarded the last two, so
    both were ignored on every setup.sh install and nothing said so.
- **Images are built once per tree, and the browser suites run in shards**
  (FAST-1). Every harness gets its images from `tests/lib/e2e-images.sh`,
  which tags them `mdnest-e2e-backend:<hash>` / `mdnest-e2e-frontend:<hash>`
  from a hash of `backend/` (or `frontend/` plus the `mdnest` CLI) as the
  working tree has it, uncommitted and untracked files included, and skips the
  build when that tag exists. So the release gate and every suite in it share
  one build, and two runs on different trees can never swap each other's
  image (the old fixed `:test` tag allowed exactly that). Containers,
  networks and notes folders carry the run's pid and shard number, so
  harnesses can run side by side. `MDNEST_E2E_REBUILD=1` builds anyway;
  `MDNEST_E2E_KEEP_IMAGES` (default 4) is how many tags `e2e_prune_images`
  keeps. `e2e-browser.sh` and `e2e-collab-multi.sh` split their specs across
  `MDNEST_E2E_SHARDS` stacks (default one per 3 CPUs, at most 3) with
  `playwright test --shard=i/N`. Each shard is a whole stack of its own
  (backend, Postgres where used, nginx, notes folder, accounts, CLI logins)
  with one worker, so no two specs share a server, which keeps the isolation
  the suite had on one stack: a spec that wipes the sticky board or relies on
  the tree's layout is still alone on its server. `MDNEST_E2E_SHARDS=1` is
  the old single-stack run. Each shard's traces go to
  `tests/browser-results/shard-N` (all output is outside `tests/browser`, the folder Playwright walks for specs, or a shard can crash on another one's half-written folder). There are no test-only knobs that
  shorten the app's poll intervals: the slow specs (`collab-idle`
  and `cli-vs-typing`) exist to prove behaviour across those real
  intervals.
  Timing-budget tests (a fixed millisecond limit, like chat.spec.js "typing
  stays fast in a long chat") carry `{ tag: '@budget' }`. The shards skip
  them and one stack runs them alone afterwards (`MDNEST_E2E_BUDGET`:
  `after` is the default, `skip`, `only`, or `inline` for no split), because
  a budget measured while other shards use the CPU fails for reasons that
  have nothing to do with the app. `tests/check.sh` runs them last, after
  all of its parallel work (see the levels table above). Tag any new test
  that compares a duration with a fixed number, and add the code it times to
  `BUDGET_CODE_PAT` in `tests/check.sh`.
- **Playwright pins `colorScheme: 'dark'`** in `tests/browser/playwright.config.js`.
  mdnest's default theme is `auto`, which follows `prefers-color-scheme`, and
  Playwright's own default emulation is *light* — so without that pin every
  existing spec would silently start running against the light palette. A spec
  that cares about a theme sets it with `page.emulateMedia()`.
- **A browser spec that seeds files must clean them up** (issue #114). The
  first transfer spec left fixtures at the namespace root, which pushed
  `tree-target.spec.js`'s drag row off-screen and failed it — a later spec,
  in another file. `transfer.spec.js` keeps each test's files in one folder
  and deletes it in `afterEach`. The harness mounts a second namespace,
  `zz_e2e_target`, named to sort AFTER `testing_workspace` so every other
  spec still opens in the namespace it expects.
- `tests/e2e-private-chats-multi.sh` — **issue #127.** Private chats against a
  real Postgres: the migration, the folder-prefix SQL behind move and copy,
  the row lock that keeps two members removing each other from leaving
  nobody, and a deleted account keeping its chat private. Not in the
  pre-push hook (needs Postgres); run it when touching chat membership or the
  permission checker. The route-by-route coverage is
  `backend/routes_chat_members_test.go`, against an in-memory store.
- `tests/e2e-collab-multi.sh`: **shared editing (v4.8.10).** Postgres + backend + nginx from the working tree, two accounts with write on testing_workspace, runs `tests/browser/collab-shared-editing.spec.js` (two contexts typing at once, open-and-leave keeps the bytes, saver closing mid-debounce, outside PUT merging in, front matter kept, folder move closes the room, Basic switching to Live), `collab-cli.spec.js` (the REAL ./mdnest, logged in with API tokens in throwaway HOMEs, at a note open in a browser: write/append/prepend/edit show live, a disk write shows via the saver's 20 s check, CLI changes during typing merge), `collab-idle.spec.js` (a note left open a minute: no remount, no change inside the editor, no reconnect), `cli-vs-typing.spec.js` (one person typing past the 60 s poll while the CLI appends: the CLI line must reach disk; prints a RESULT line per run) and `presence.spec.js`. `MDNEST_BUILD_ROOT=<checkout>` builds the app from another tree (an older tag in a throwaway worktree) with today's specs and CLI; `MDNEST_E2E_BACKEND_ENV="SHARED_EDITING=false"` adds backend settings. That is how v4.8.9 was shown to lose CLI text and v4.8.10 not. The notes dir is on the host so specs check disk bytes. Not in the pre-push hook (needs Postgres); run it when touching collab, App's save paths or the Live editor.
- `tests/release-gate.sh`: **the release gate (v4.8.12), now the ship level of `tests/check.sh`.** Run on the release commit before pushing it. It builds the e2e images once, then runs two lanes side by side: the browser lane (`e2e-browser.sh`, then `e2e-collab-multi.sh`, each sharded) and the other lane (the pre-push hook's release tier inline with `MDNEST_GATE_SUITES_OUTSIDE=1`, so the hook leaves its end-to-end suites to the gate; inside a push, GitHub dropped the SSH connection after 10 minutes; Go vet + `go test -race` with a real Redis (host Go or Docker), shellcheck (host or Docker), `e2e-docker`, `e2e-sec-multi`, `backend-image-init`, and the suites picked by the files changed since `origin/main` (`MDNEST_GATE_ALL=1` runs them all)). `MDNEST_GATE_LANES=1` runs the lanes one after the other. On success it writes the tested tree to `.git/mdnest-release-gate`; the hook refuses a `release/*` or `main` push of any other tree. It refuses to run with uncommitted tracked changes, since the record must name the tree it tested.
- `tests/e2e-ha-durability.sh`: **issue #147.** Redis + one `MDNEST_ROLE=writer` + one `MDNEST_ROLE=app` from the working tree (or `MDNEST_BUILD_ROOT=<checkout>`): a burst of appends must land on the writer's disk with the durability stream back at 0 entries, and a writer whose lock is taken away while Redis is at maxmemory must win it back and apply the next save without a restart. Against v4.8.10 it fails 4 of 9. The unit layer is `backend/storage/redis_queue_test.go`, which needs `MDNEST_TEST_REDIS_URL` (CI's backend job runs a Redis service for it; locally the tests skip without it). Not in the pre-push hook; run it when touching the queue, writer or leader.
- `tests/e2e-transfer-multi.sh` — **issue #114.** Postgres + the backend from
  the working tree, real users, path-scoped grants, an access group and an API
  token driven through `/api/transfer` and `/api/download`, every allowed and
  denied case checked against the disk. The multi-mode counterpart of the unit
  fakes; not in the pre-push hook (it needs Postgres), run it when touching
  either endpoint or the permission checker.
- `tests/setup-download-limits.sh` — `DOWNLOAD_MAX_*` reach `.env`, defaults
  are written, a non-number is refused at setup, a shell export cannot leak
  in (it did, before the reset at the top of `setup.sh`).
- **A test that destroys user data must refuse to run against a real account.**
  `tests/browser/stickies.spec.js` wipes the sticky board of whatever account
  it signs in as, and a sticky exists nowhere else — no namespace, no git
  remote, no history — so there is nothing to restore from. Pointed at the
  owner's own account on the dev instance it silently deleted his real
  stickies, repeatedly, and nothing in the code objected; the intention not to
  do it again is exactly what failed. The suite now refuses to start unless
  `MDNEST_USER` looks like a throwaway (`e2e`/`test`) or
  `MDNEST_ALLOW_BOARD_WIPE=1` is set. Any future suite that destroys per-user
  state should carry the same guard.
- **Adding a regression test is part of fixing a bug** (see `md-fix-bugs`): add a
  check to the layer that would have caught it — a CLI-behaviour bug → a
  `cli-smoke-test.sh` assertion; a parser/fallback bug → a `cli-unit.sh` case; a
  UI bug → a `tests/browser` spec. The point of the harness is that the next
  regression of the same shape fails loudly and locally before merge.

## Documentation

See `docs/` for:
- `api.md` — Full API reference with curl examples
- `user-guide.md` — End-user guide
- `setup.md` — Setup and configuration
- `architecture.md` — Architecture overview
- `codemap.md`: file-by-file map of the repo (moved out of this file)
- `security.md` — Threat model and the five defense layers (layer 5, rendered-content sanitization, is v3.11.7+)
- `cli.md` — `mdnest` client CLI
- `kubernetes.md` — Optional Helm chart (v3.11.7+); says which options are gated off and why
- `sso-setup.md` / `firebase-setup.md` — Identity-provider setup
