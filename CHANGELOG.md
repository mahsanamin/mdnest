# Changelog

All notable changes to mdnest are documented here.

---

## v3.11.2 — CLI list/move fixes + prettier update indicator

### Bug fixes

- **`mdnest list <ns/subfolder>` now scopes to that subfolder.** It used to ignore the deeper path and return the entire namespace tree, so there was no way to enumerate a single folder. Now it returns just that folder (its children) or the file entry, and errors with a non-zero exit on a missing path.
- **`mdnest move` no longer loses content when given a full destination path.** Passing a full `@alias/namespace/path` destination (the same style typed for the source) made the server treat `@alias/namespace/` as literal folder names and relocate the file to a bogus path — the intended destination then read empty and write/delete returned 404, looking like data loss. The CLI now normalizes the destination to a namespace-relative path and rejects cross-namespace moves. (The backend move was always correct; the CLI was passing the destination raw.)
- **The "new version available" indicator no longer renders as an oversized cream blob.** On a narrow sidebar the old badge wrapped its `↑` and version onto two lines inside a pill, which looked broken. The alert is now folded into the build-details **ⓘ**: when an update is available the icon turns accent-blue and gently pulses (respecting `prefers-reduced-motion`), and clicking it opens the popover with the build details plus a tidy "↑ vX.Y.Z available — see what's new" action. Removed the standalone badge.

---

## v3.11.1 — Live editor mermaid sizing + contrast

### Bug fixes

- **Mermaid text is now always readable, whatever fill the source specifies.** Author/AI-written diagrams that set a light node fill (`style X fill:#fff8e1`, a light `classDef`, …) rendered as light-text-on-light-fill — invisible. The Live editor was injecting a blanket `.nodeLabel { color:#cdd6f4 !important }` override that forced *every* label light, fighting the per-node brightness logic that's supposed to pick contrast. Removed the blanket override so `fixMermaidTextColors()` is the single authority: each label's color is computed from its own node's fill brightness (dark text on light fills, light text on dark), so contrast holds regardless of the colors the author chose. (Print/export keeps its own light-page palette.)

- **Mermaid diagrams now render at a sensible size in the Live editor.** Small diagrams ballooned to full width while large/tall ones shrank into a corner — because every rendered SVG had its real dimensions stripped and was forced to `width:100%`, then classified by width alone (`<400px` = "small"), so a wide `flowchart LR` filled the pane (stretched up) and a narrow `flowchart TB` rendered at its tiny natural width with empty space beside it. Now the SVG keeps its **natural width, capped at the container and at a 820px max** (`width:<natural>px; max-width:min(100%, 820px); height:auto`): small diagrams stay small (no stretching), large ones scale **down** to fit (no shrinking into a corner) and don't sprawl past 820px on wide screens, and the zoom/Fit controls layer on top. The preview box also lost its oversized `200px` min-height and `2rem 3rem` padding, so a tiny inline diagram no longer sits in a giant empty frame.

---

## v3.11.0 — CLI stdin fixes + smoke-test harness

### Added

- **Build commit shown next to the version.** `/api/config` now reports a `commit` field — the short git SHA the backend binary was built from, injected at build time via `-ldflags` (computed by `setup.sh`, passed through docker-compose as a build arg, baked into the binary). The sidebar footer renders it as `v3.11.0 · <sha>`, and `mdnest servers` shows it as `3.11.0 (<sha>)`. Because the SHA is compiled into the binary rather than read from config, it can't drift from the running code — so a stale container is now obvious even when the version string hasn't changed (the exact situation where a rebuilt `develop` still displayed an old version). Falls back to `dev` for local `go build` without the ldflag.
- **Build-details popover (ⓘ) with build time.** A short SHA alone isn't very legible, so the sidebar version now has an info button that opens a small popover showing the version, the commit (linked to its GitHub commit page), and **when the running build was produced** — a `buildTime` field newly added to `/api/config`, baked in via `-ldflags` alongside the commit (UTC timestamp computed by `setup.sh`, rendered in local time). Answers "is this the build I just deployed, and when?" at a glance.
- **Live editor: reclaimed the left space.** Crepe reserved an ~88px left gutter for its hover drag/`+` block handles, wasting ~20% of the width on mobile. The handle is now a compact **vertical grip** sitting flush in a **28px** gutter (no empty lane beside it), list indentation is tightened (marker column 24px→20px, marker→text gap 10px→4px) so bullets hug the left, and a Live-toolbar **toggle** hides the handle entirely for full-width content (**16px** margin). The slash `/` menu keeps working with the handle hidden. The state persists per browser and defaults to hidden on **touch devices** (`hover: none` / `pointer: coarse`), shown on pointer devices.
- **Live editor: toolbar buttons work reliably on touch + a real Link prompt.** Toolbar formatting buttons used `mousedown`, which doesn't preserve the editor selection on touch devices, so most icons did nothing on mobile; they now use `pointerdown` (covering touch) and refocus the editor after running, so bold/heading/list/etc. apply to the selection. The Link button now prompts for a URL and applies it as the link `href` (previously it toggled a link mark with no destination — a dead link).

### Bug fixes

- **`mdnest create` now accepts piped stdin via `-`, like its sibling verbs.** Previously `create` forwarded its positional argument straight to the API, so `echo "# Note" | mdnest create @ns/file.md -` wrote the literal one-byte string `-` as the file body — and the API still returned `{"status":"created"}`. The result was a silently corrupted (near-empty) file reported as a success, which is the most common way automated tooling (scripts, AI agents) corrupted notes: the command "succeeded", nothing retried, and the bad file surfaced much later. `create` now reads stdin on `-` (or an omitted arg) exactly like `write`/`append`/`prepend`.
- **Robust, TTY-aware stdin handling with a literal-dash guard.** All content verbs now route through a shared `read_content()` helper: `-` reads stdin and errors with a non-zero exit if nothing was piped (instead of writing a literal `-`); an omitted arg auto-reads stdin only when piped and never blocks on an interactive terminal. This removes both the TTY-hang footgun and the literal-`-` corruption path.
- **Empty content now fails loudly instead of reporting false success.** `create`/`write`/`append`/`prepend` refuse to issue the API call when no content was supplied, printing a clear message and exiting non-zero rather than creating an empty file and returning `ok`. (The guard returns success explicitly on the happy path so it is safe under the script's `set -e`.)

### Testing

- **New CLI smoke-test harness — `tests/cli-smoke-test.sh`.** 18 end-to-end checks covering every note operation (create/write/append/prepend/read/move/delete/search/list) plus the stdin edge cases above, run against a disposable namespace. It tests the working-tree CLI, creates everything under a unique self-cleaning folder, and exits non-zero on any failure. Run it after any change to the `mdnest` CLI. A new optional `MOUNT_testing_workspace` mount (documented in `mdnest.conf.sample`) gives it a dedicated namespace.

### Security / CI

- **MCP server: bump `hono` to clear a high-severity advisory** (transitive via `@modelcontextprotocol/sdk`). `npm audit` now reports zero vulnerabilities.
- **Frontend: bump `vitest` 2.x → 4.x** to clear the vulnerable `vite`/`vite-node`/`@vitest/mocker`/`esbuild` dev-toolchain chain (a high + a critical). The production build's direct `vite` was already on a fixed version; only the test runner's pinned `vite@5` was affected. Tests still pass (11/11) and `vite build` is unchanged.
- **Backend: run `govulncheck` in binary mode.** `govulncheck@latest` (v1.4.0) segfaults in source mode (nil pointer deref in `vulncheck.vulnFuncs`) when analysing code built with the Go 1.26.x toolchain that `go.mod` pins. Building the binary and scanning it with `-mode=binary` avoids the crashing source-SSA path while still detecting reachable vulnerable symbols; the local pre-push hook does the same. Also points setup-go's module cache at `backend/go.sum` to clear a warning.
- **Backend: bump Go 1.26.3 → 1.26.4** (`go.mod` + Dockerfile builder image) to clear two called standard-library advisories surfaced by the now-working govulncheck scan: `GO-2026-5039` (`net/textproto` error escaping) and `GO-2026-5037` (`crypto/x509` candidate-hostname parsing), both fixed in go1.26.4.

---

## v3.10.2 — Live editor list alignment + "Refresh Now" feedback

### Security

- **Bump `golang.org/x/net` v0.53.0 → v0.55.0** to clear `GO-2026-5026` (IDNA `idna.ToASCII` fails to reject ASCII-only Punycode-encoded labels — reachable from the in-app update poller's outbound `https://api.github.com/...` request via `http.Client.Do`). Transitive bumps: `x/crypto` 0.50→0.51, `x/sys` 0.43→0.45, `x/text` 0.36→0.37. `govulncheck ./...` now reports zero vulnerabilities.

### Bug fixes

- **Live editor: nested bullets / task items no longer appear as floating orphans between sub-rows.** Symptom (most visible at depth ≥ 2): a parent item's bullet drifted down to sit halfway through its own nested children, looking like a stray dot sandwiched between two unrelated sub-bullets. Root cause: the v3.10.0 Crepe migration added speculative CSS overrides on the list-item layout — most damagingly `align-items: center` on `.list-item`. Crepe's DOM for a list row is `[label-wrapper | children]`, and `.children` contains the parent's paragraph **plus** every nested `.milkdown-list-item-block`. Centering the bullet vertically against that whole stack pushed the parent's bullet to the visual midpoint of all its descendants. The fix strips every speculative list-item override and trusts Crepe's playground defaults for sizing / gap / alignment — the only override left is a single `.milkdown-list-item-block p { margin: 0 }` rule to neutralise the app-wide `p { margin: 0.4rem 0 }` that leaked into list rows (Crepe inserts a `<div class="content-dom">` between `.children` and `<p>`, so the previous `.children > p` selector was silently missing the paragraph and the leaked margin offset the bullet from the text's optical centre).
- **"New version available" banner's Refresh Now button now shows `Refreshing…` immediately on click.** Symptom: a user clicked the button after upgrading their server from v3.9.1 to v3.10.1, "nothing happened" visibly, then the tab appeared frozen and they had to kill the browser. Diagnosed: the click was actually triggering `window.location.reload()`, but the v3.10+ bundle is heavier than v3.9 (Crepe + Vue + CodeMirror + KaTeX ≈ 340 KB gzipped) and parsing it during the reload can take several seconds on a slow connection or low-memory device — during which the OLD tab stays visually idle because the click handler didn't update any UI before calling reload. Two changes: (a) set a `refreshing` state immediately on click so the button reads `Refreshing…` and goes `disabled` before the reload starts, giving the user an instant signal that the click registered; (b) drop the deprecated `true` argument from `window.location.reload(true)` — it was Firefox's non-standard "forceGet" flag that no other browser ever implemented and Firefox itself dropped years ago, so it was already a no-op everywhere but spec-incorrect.

---

## v3.10.1 — Login form: proper password-manager hints + per-server scoping + "Keep me signed in"

### New features

- **"Keep me signed in" checkbox** on the login form. Default ON. When checked the backend issues a 1-year JWT instead of the default 30 days, so users on personal/trusted devices stop getting unexpectedly logged out. Unchecked = 30-day TTL (the previous default) — appropriate for shared / kiosk sessions. The flag threads through every multi-step path (initial login → TOTP verify → forced password change) so the final JWT gets the right TTL regardless of which path the user takes. SSO and Firebase login default to the long-lived TTL since they have no checkbox UI of their own (their IdPs own the "stay signed in" UX). Backend helper `jwtTTL(rememberMe)` in `backend/handlers/auth.go` is the single source of truth.

### Bug fixes

- **Browser password-manager hints on the login form.** The username and password inputs were missing `name` + `autocomplete` attributes, so browsers couldn't reliably offer to save credentials and couldn't autofill them on return visits. Added `autoComplete="username"` / `autoComplete="current-password"` (and `"new-password"` on the forced-password-change step) so the "Save password?" prompt appears at the right time and re-visits get autofilled.
- **Per-server credential scoping (best-effort).** When the user runs multiple mdnest installs, browsers were lumping their saved credentials together — typing into one install's login form would try to autofill another install's password. The form's `name` and `id` now include the server's `SERVER_ALIAS` (read from `/api/config`) plus a hidden `server` input field. Together those make the form's identity distinct per install for password managers that fingerprint form structure (1Password, Bitwarden, KeePassXC). Browsers' built-in password managers (Chrome, Edge, Safari, Firefox) scope primarily by HTTP origin and use the Public Suffix List for autofill suggestions — they conflate sibling subdomains (`brain.example.com` and `wbrain.example.com` both autofill from the `example.com` record). For full per-install isolation, give each install a different parent domain, or in 1Password/Bitwarden set the saved entry's URL match to "Host" or "Exact".
- **Post-login password forms don't trigger save-prompts at the wrong time.** Settings → Change Credentials, the Admin → Reset Password modal, and the Admin → Create User form all had bare `<input type="password">` with no `autocomplete` attribute. Browsers would see those after login and offer to save / autofill the wrong credentials (which is what the user was seeing as "weird dialogue prompts inside when logged in"). Added the correct `autocomplete="current-password"` on current-password fields, `"new-password"` on every new/confirm field, `"username"` where applicable, and `autoComplete="off"` on the wrapping forms — so password managers don't mistake these for login forms after sign-in.
- **LICENSE copyright corrected** — the MIT LICENSE shipped from the initial release commit with the wrong copyright holder ("Ahsan Nabi Dar") — a template artifact that survived because nobody re-reads LICENSE on each release. Now reads `Copyright (c) 2026 Ahsan Amin`, matching the actual repo owner.
- **`docs/security.md` "Defense layers at a glance" mermaid diagram renders on GitHub.** The diagram failed to render in GitHub's docs viewer (and on mdnest.dev) with `Parse error on line 2: ...Expecting 'SQE', 'DOUBLECIRCLEEND', ... got 'PS'`. Cause: node labels like `net[Network boundary<br/>(loopback, Tailscale, …)]` contain unquoted parentheses inside a `[...]` square-bracket node, which mermaid interprets as a nested round-bracket shape definition. Wrapped the affected labels in `"…"` (the mermaid escape for "treat literally") — renders correctly on GitHub, on mdnest.dev, and in our own Live editor.
- **Update-available banner surfaces within ~minutes of a release, not a day.** Two cadence issues: the backend poller was hitting `https://api.github.com/repos/<owner>/<repo>/releases/latest` every 24 hours, and the frontend only fetched `/api/config` once per page load — so a long-running tab would never see a new release at all. Dropped the backend interval to 1 hour (still 1/60th of GitHub's unauthenticated rate limit) and changed the existing 60s `/api/config` poller on the frontend to refresh `appConfig.latestRelease` (it only updates state when the release version actually changed, so re-renders stay cheap). End-to-end: a new GitHub Release now shows up in the sidebar footer within roughly one hour of being published, no manual refresh needed. Also: the v3.10.0 GitHub Release was published this cycle — before that the API returned 404 from `/releases/latest` because we'd been pushing tags without publishing Releases. Both `CLAUDE.md`'s release process and the `/mdnest-ship` skill now require `gh release create` as Step 11 alongside `git push --tags`.

---

## v3.10.0 — Live editor migrated to Crepe + per-workspace last-file memory

The big one: the Live editor is now built on [`@milkdown/crepe`](https://milkdown.dev) — the same component the Milkdown playground uses. The pre-v3.10 hand-rolled `@milkdown/core` + commonmark + GFM stack is gone. Crepe brings a block-edit handle (drag + `+` button + slash menu), native SVG task-list checkboxes, KaTeX math, polished tables with column / row controls, link tooltip, and an image-block upload affordance. All four custom plugins from v3.9 (mermaid live edit, comments, in-cell `[ ]`/`[x]` checkboxes, clear-empty-block) port forward; the Catppuccin Mocha look is preserved.

This release also rolls up the v3.9.1 changes (paste-handler priority, browser tab title, Vitest scaffolding) — they shipped on the migration branch as the first commit and never got their own tag.

### New features

- **Block-edit menu** — hover the left margin of any block to get a drag handle and `+` button. The `+` button opens Crepe's slash menu (Heading 1-6, code block, math, image, hr, table, …). Typing `/` anywhere in the doc opens the same menu inline.
- **Native task-list checkboxes** — top-level `- [ ] foo` items now render as proper SVG checkboxes (clickable to toggle). Replaces the v3.9.2 hand-rolled `topLevelTaskCheckboxPlugin` which never looked right.
- **KaTeX inline + block math** — `$inline$` and `$$block$$` render via KaTeX. Auto-detected as markdown; no special syntax needed beyond the dollar signs.
- **Image upload UI** — slash-menu → Image inserts a placeholder block; click to upload or paste a URL. Pasting an image from clipboard works the same way (PNG screenshots, etc.). Uploads go to `/api/upload` and the rendered `<img>` resolves through a new `proxyDomURL` that rewrites the bare-filename markdown src into `/api/files/<ns>/<dir>/<file>?token=…`.
- **Auth middleware accepts `?token=<JWT>`** — for browser GETs that can't set an `Authorization` header (`<img>` tags, future `<a>` downloads). Same validation flow as Bearer; both JWT and `mdnest_…` API tokens accepted. Without this, images upload-but-never-display because `/api/files/…` requires auth and the browser image fetch had no way to provide it.
- **Per-namespace last-opened-file memory** — switching workspaces and switching back restores whichever file you had open in that workspace, with its scroll position. Stored in `localStorage` under `mdnest_last_path:<ns>`. URL hashes (`#ns/path`) still win for bookmarks. Stale entries (file deleted, moved, or renamed) are cleaned up automatically as the operations happen, and the note-loading effect's catch handler clears any that slip through.
- **Mermaid auto-detect on paste** — pasting raw mermaid source (text that starts with `flowchart TD`, `sequenceDiagram`, `graph LR`, etc.) auto-wraps it in a ```mermaid` fence and renders. The detector is intentionally strict: pastes that ALSO look like markdown (contain `#` headings or `|` table rows) are routed to the markdown path instead, so a document that just happens to mention "user journey" or "pie chart" doesn't get swallowed into a mermaid block.

### Mermaid rendering preserved

The legacy `MermaidBlock` React component (Preview / Source toggle, zoom, Fit, Copy, fullscreen viewer, "click any label to edit") stays. Crepe's `code-mirror` feature is kept enabled (its LaTeX feature depends on it) and a composing plugin wraps the `code_block` nodeView so `language=mermaid` blocks render via the React component while everything else falls through to Crepe's CodeMirror block. The fallback was important: without it disabling code-mirror crashed the editor on any `$…$` math because LaTeX's editor uses CodeMirror internally.

### Paste-fidelity contracts (v3.9.1 priority + new ProseMirror bypass)

- **`data-pm-slice` bypass** — when the clipboard HTML carries ProseMirror's slice marker (you copied from another mdnest tab / another Milkdown), the custom paste handler returns early without `preventDefault()`. Milkdown's native `parseSlice` then reconstructs the doc with full schema fidelity — table cells keep their inline marks (e.g. `**Enigma**` in the first column), fenced code blocks keep their language tag, link attributes survive. The previous behavior routed everything through `htmlToMarkdown → markdownToSlice`, which flattens GFM-specific structure.
- **v3.9.1 priority preserved** for external clipboards — plain-text-that-looks-like-markdown wins over rich HTML, so Obsidian's `- [ ] Foo` task lists stay task lists.
- **Code-block paste fix** — when the cursor is inside a code fence, the custom paste handler returns early so multi-line SQL / JS / etc. pastes as plain text into the block instead of being broken into one paragraph per line.

### Table-editing polish

- **Single-click cursor placement** — Crepe's default behavior turned the first click on a cell into a node-selection over the cell content (caret only appeared on the second click). Wrapped Crepe's table nodeView to let plain mousedowns fall through to ProseMirror's normal cursor placement.
- **Visible caret in cells** — set `caret-color: #89b4fa` on the editor; browser's `auto` was being swallowed by the dark cell backgrounds.
- **Inline code wraps inside cells** — `white-space: pre-wrap; overflow-wrap: anywhere` on `code` inside `.milkdown-table-block`, so long URLs / endpoint paths break instead of clipping.
- **Table-level horizontal scroll fallback** — `overflow-x: auto` on `.milkdown-table-block` so tables wider than the editor pane scroll horizontally instead of pushing the rightmost columns off-screen.
- **Drag handle anchors to the table** — Crepe's default block-edit filter explicitly rejects tables, so the drag handle skipped past them. Overrode `blockConfig.filterNodes` to reject nodes whose `$pos` is inside a table while accepting the table itself, so clicking the 6-dot handle selects (and lets you drag) the whole table. Selected-state outline (`2px #89b4fa`) added so the selection is visible against the table's own cell backgrounds.
- **Mermaid block selection outline** — same fix as tables, on `.mermaid-live-container.ProseMirror-selectednode`, so Delete-from-handle works discoverably.

### From v3.9.1 (subsumed into this release)

- **Pasted GFM task lists survive their checkboxes** when the clipboard carries both `text/plain` and `text/html` — the plain-text-that-looks-like-markdown path beats the HTML path.
- **Browser tab title includes the server alias** — `mdnest (srv-ahsan-mini)` so multi-tab users can tell servers apart.
- **Vitest scaffolding** — `frontend/src/__tests__/markdown-fixtures.test.js` exercises the paste-priority detection. `npm test` in `frontend/` runs the suite; the pre-push hook gates on it.

### Bug fixes

- **Mermaid container right-sizes for small diagrams** — a 3-node flowchart used to stretch a full editor-width container with ~1300px of empty halo on each side. `.mermaid-live-block` now uses `width: fit-content; max-width: 100%` so the block hugs the diagram (with the toolbar's natural width as a floor so its buttons never wrap).
- **Task-list spacing** — Crepe's default flex gap of 10px + the app-wide `p { margin: 0.4rem 0 }` were leaking ~13px of stacked margin between rows. Reset paragraph margin inside `.children`, tightened the gap to 6px, center-aligned the marker box on the text line so bullets / `1.` / checkboxes sit on the text baseline.
- **Heading hierarchy underline** — H1 *and* H2 keep their `#313244` bottom border (previous override only added it to H1).

### Internal cleanup

- **Legacy `LiveEditor.jsx` deleted.** The four shared plugins (`commentHighlightPlugin`, `clearEmptyBlockPlugin`, `tableCellCheckboxPlugin`, `LiveToolbar`, plus `findAnchorMatches` and `commentHighlightKey`) live in `frontend/src/components/live-editor-plugins.jsx`. `LiveEditorCrepe.jsx` imports from there.
- **`VITE_USE_CREPE` build flag removed.** Crepe is now the only Live editor; `./mdnest-server rebuild` (no env var) ships it. Dockerfile ARG and `mdnest-server` BUILD_ARGS propagation deleted.
- **Bundle size** — the Live editor chunk is now ~1.1 MB / ~340 KB gzipped (Crepe + Vue runtime + CodeMirror + KaTeX). Lazy-loaded; the main app bundle is unchanged in size for the initial page load.

### Notes

- Crepe brings a Vue 3 runtime (~340 KB raw, ~80 KB gzipped) into the lazy chunk. It is contained — no Vue components are mounted in the React tree; Crepe creates its own Vue app inside the editor's contenteditable root. mdnest as a whole remains a React app.
- The plain textarea ("Basic") editor stays. Some users prefer raw markdown editing, and Basic is also the auto-fallback when the Live editor crashes on a specific file (the existing `EditorErrorBoundary` catches Live-editor exceptions and flips to Basic).

---

## v3.9.1 — Paste-handler priority + browser tab title + test scaffolding

### Bug fixes

- **Pasted GFM task lists (`- [ ] Foo`) survive their checkboxes** when the clipboard carries both `text/plain` and `text/html` (Obsidian, terminals, most modern apps populate both). The Live editor previously checked the HTML branch first; `htmlToMarkdown` is lossier than `markdownToSlice` for task lists because the HTML version typically doesn't carry GFM's `data-item-type="task"` data attribute, so the DOM round-trip dropped the checkbox semantics and the result landed as a plain bulleted list. Reordered: plain text that *looks like markdown* (any line starting with `#`, `-`, `*`, `>`, `|`, `` ` ``, `[`, `!`) now wins over rich HTML when both are present. HTML conversion remains the path for sources that don't ship markdown (Google Docs, Confluence, web pages). The basic textarea editor already had this priority; this aligns the Live editor with it. Extracted the markdown-detection regex into `frontend/src/markdown-utils.js` so the two paste handlers share one source of truth.

### New features

- **Browser tab title includes the server alias.** Multiple mdnest tabs (different servers) are now visually distinguishable: `mdnest (srv-ahsan-mini)` instead of plain `mdnest`. Falls back to `mdnest` when no `SERVER_ALIAS` is configured. Reads from the existing `/api/config` payload — no backend change needed.

### Tests

- **Vitest scaffolding for markdown roundtrips** (`frontend/src/__tests__/markdown-fixtures.test.js`). Targets the regression patterns that have actually shipped: paste-priority detection, task-list HTML conversion (the v3.8.0 fix verification), and `looksLikeMarkdown` edge cases. Runs under jsdom so the `htmlToMarkdown` path (uses browser `DOMParser`) is exercised. `npm test` in `frontend/` runs the suite; pre-push hook gates pushes on it passing. Eleven tests today; add a fixture before touching the editor next time so the next regression of this shape is impossible to ship.

### Notes

- The deeper consolidation work (unifying Live's `tableCellCheckboxPlugin` with Preview's DOM-walker checkbox path, memoizing the comment-highlight plugin, schema-level task-list cleanups) is documented in the plan file as Tier 3 future PRs — explicitly NOT in this release. The pattern of "small markdown things keep breaking" needs that work, but each piece is its own change with its own blast radius and should ship one at a time.

---

## v3.9.0 — Tree auto-refresh in single mode + host-side token CLI + path-confusion guard

### New features

- **`mdnest update`** (and `mdnest upgrade`) — self-update verb on the CLI. Re-fetches the latest `mdnest` script from upstream and replaces itself in place; safe on Unix because the kernel keeps the running inode alive until the current invocation exits, so the next call picks up the new code. Reports the upgrade path (`vX.Y.Z -> vA.B.C`) and short-circuits with "up to date" when current matches latest. `--force` re-downloads regardless. Closes the discoverability gap where the only update path was remembering the `install-cli.sh` URL and re-piping it into bash.
- **`mdnest-server create-token <name>`** — host-side API token provisioning. Generates a token, persists it to the same `tokens.json` store the web UI uses, and prints just the raw token to stdout so callers can capture it: `TOKEN=$(./mdnest-server create-token foo)`. Same trust model as `reset-password` — anyone with shell access to the server can mint tokens, which is by design (server shell = full operator trust). In single mode the token is bound to `MDNEST_USER` for clarity in logs / UI; in multi-mode this CLI exits with a clear error pointing at the web UI's per-user token flow (web-UI tokens bind to the logged-in user, which the CLI can't disambiguate from the host).

### Bug fixes

- **Tree auto-refreshes in single mode** (and multi-mode without `ENABLE_LIVE_COLLAB`). Previously the tree was kept in sync via the WebSocket `tree-changed` event, which only fires in multi-mode + live-collab installs. Without it, a file created from the CLI / MCP / git-sync / another browser tab stayed invisible until the user clicked the Refresh button. Now the frontend polls the tree every 60s when no websocket is connected (skipped when the tab is hidden so backgrounded sessions don't burn requests). Costs one tree GET per minute per active session.
- **Better error when creating a file at a path that conflicts with an existing directory.** `POST /api/note?path=foo/bar.md` while a directory `foo/bar/` already exists at the same level used to silently create a misplaced sibling — agents (and humans) frequently meant "create a file inside `foo/bar/`" and didn't realize the path syntax was wrong. Now the backend detects this case and returns 409 with a clear hint: `a directory named 'foo/bar' exists at this location — to create a file inside it use path 'foo/bar/<filename>.md'`. POSTing directly to a directory path also returns a more informative 409 instead of the misleading "file already exists." Same `safePath` checks; just a smarter conflict message.
- **CLI-minted API tokens validate without a server restart.** The token store loads `tokens.json` once at startup and serves all subsequent validations from memory. The new `create-token` CLI runs in a one-shot container that writes the file but can't update the running server's in-memory map, so newly-minted tokens were rejected with `401 invalid API token` until the next rebuild. Fixed in `tokens.go`: on a hash miss the validator re-reads `tokens.json` from disk before giving up. Successful validations stay fast (in-memory hit, no I/O); only misses pay the file-read cost. Same logic mirrored in `ResolveAPITokenUser` for multi-mode user-resolution misses.

### Notes

- This release is on `release/v3.9.0`.

---

## v3.8.0 — Update notifications, version compare, and multi-IP bind

### New features

- **"Update available" badge with release notes.** The backend now polls the GitHub releases API once every 24 hours and includes the latest release (version, name, publish date, full markdown body) on `/api/config`. When a newer mdnest is published, a small badge appears next to the version in the sidebar footer. Clicking it opens a modal that renders the release notes inline so you can see *what actually changed* (features, bug fixes, breaking notes) before deciding to update — not just the version number. Per-version "don't remind me" dismissal is saved in localStorage; a newer release re-arms the badge automatically.
- **Compare two versions in the History modal.** A new "Compare to:" dropdown above the preview pane lets you pick any other commit, or the live "Current version", to diff against the primary selection. Green-tinted lines exist only in the target, red-tinted lines only in the primary — so when you're considering a restore, you can read exactly what would change and decide before clicking Restore. Diff is line-based (LCS); identical inputs short-circuit to "no differences."
- **Comma-separated `BIND_ADDRESS` for multi-IP binding.** `BIND_ADDRESS=127.0.0.1,100.73.118.115` now works — useful for binding localhost plus a private overlay address (Tailscale, ZeroTier, VPN) without falling back to `0.0.0.0`. Previously a comma-separated value was passed verbatim to a single Docker port mapping, so `mdnest-server rebuild` failed with `invalid IP address`. Single-IP behavior is unchanged.

### Bug fixes

- **Sidebar shows the configured username in single-user mode** instead of the literal placeholder "User". Previously the sidebar's `UserFooter` only had a username to display when `/api/me` populated `userInfo` — but `/api/me` is registered only in multi-mode, and `App.jsx` actively passed `null` to the sidebar in single mode (`userInfo={isMulti ? userInfo : null}`). So an admin signed in via `MDNEST_USER` always saw the generic "User" label. Fixed in `App.jsx` by decoding the JWT's `sub` claim client-side (which already carries `MDNEST_USER` from `mdnest.conf`) and synthesizing a minimal `userInfo` for single mode (with `is_super_admin: true` since the single-mode user implicitly owns everything). The gate at the Sidebar prop is dropped — `userInfo` flows through in both modes now.
- **Long-press on a file/folder on mobile now shows the same context menu as right-click on desktop.** `TreeNode.handleTouchStart` didn't call `e.stopPropagation()` (its right-click sibling does). The touch event bubbled up to the parent `.sidebar-tree`, whose own empty-area long-press handler also scheduled a 500ms timer with `target=null`. Both timers fired, the empty-area one ran *after* the file-specific one, so the file menu was rendered for an instant and then immediately overwritten with the empty-area "New Note / New Folder" menu. Fixed by adding `e.stopPropagation()` at the top of `handleTouchStart`, mirroring `handleRightClick`. The empty-area handler still fires correctly when the user long-presses on actual blank space below the tree.
- **Patched Go stdlib + golang.org/x/net CVEs.** The pre-push hook surfaced four `govulncheck` findings on the v3.8.0 branch: GO-2026-4982 / GO-2026-4980 (XSS via `html/template` escaper bypasses), GO-2026-4971 (panic in `net.Dial`/`LookupPort` on Windows from NUL bytes — reachable via `database/sql` and `exec.Command` lookups), and GO-2026-4918 (HTTP/2 transport infinite-loop on a malicious `SETTINGS_MAX_FRAME_SIZE` — reachable from `updates.Checker` and the Firebase admin SDK). Fixed by bumping `go.mod`'s `go` directive from `1.26.2` → `1.26.3` (which forces the patched stdlib via Go's auto-toolchain), pinning the Dockerfile builder image from `golang:1.26-alpine` (floating) to `golang:1.26.3-alpine` so production binaries match, and upgrading `golang.org/x/net` from `v0.52.0` → `v0.53.0`. `govulncheck ./...` now reports clean.
- **Checkboxes now render inside table cells.** GFM's standard `table_cell` schema admits only `paragraph+` content — list items (where Milkdown's task syntax lives) are not allowed children, so `| - [ ] X |` in a cell fell through to plain `[ ]` text in both the Live editor and the Preview. Rather than widening the schema (which breaks the ProseMirror tables editing plugin's cell-selection / tab-navigation / paste-rule assumptions), added two cooperating layers that operate on literal `[ ]` / `[x]` text inside cells: (a) Live mode — a new `tableCellCheckboxPlugin` ProseMirror plugin scans `table_cell`/`table_header` nodes on every transaction, hides each three-character bracket span via inline decoration (`width:0; visibility:hidden` so the cursor steps cleanly across), and paints an `<input type="checkbox" contentEditable=false>` widget decoration at the same position; clicking dispatches a `replaceWith` transaction that flips the underlying text → checked state persists through normal autosave. (b) Preview mode — DOM post-pass walks every `td`/`th` text node, replaces matched `[ ]`/`[x]` with checkbox elements, indexes them left-to-right top-to-bottom, and on toggle finds the N-th `[ ]`/`[x]` literal in the source markdown and rewrites it via the existing `onCheckboxToggle` callback (which now accepts a `colIndex` second argument so in-cell toggles target the specific bracket pair, not the surrounding list-item form). Round-trip is invariant: the underlying text in the document remains literal `[ ]` / `[x]`, so `toMarkdown` serializes it unchanged. Works in nested lists and blockquotes too — anywhere the literal brackets appear inside a cell.
- **CLI writes (and other HTTP-originated changes) now propagate to a same-user browser tab.** The `Hub` in `backend/collab/hub.go` was tracking presence in a `noteKey -> userID -> *Conn` map, and `BroadcastFileChanged` excluded *every* connection sharing the originator's userID. So `mdnest write @ns/path.md` from the CLI as user X excluded X's own browser tab from the resulting `file-changed` event — the tab kept showing the old content until you clicked away and back. Refactored to `noteKey -> set of *Conn` (set semantics on the connection pointer): `Join`/`Leave` operate on `*Conn`, presence + countUsers dedupe by `User.ID` for display purposes, and broadcasts split into two helpers — `broadcastToOthers(key, exclude *Conn, msg)` for WS-triggered relays (cursor / selection / live content) where the originating tab should not echo, and `broadcastToAll(key, msg)` for HTTP-triggered events (file-changed / tree-changed) where there is no originating `*Conn`. Side effects: a user can now have multiple tabs open on the same note without one silently displacing the other; "join"/"leave" presence events now fire only on the user's first/last connection so a second tab doesn't double-count.
- **Pasted markdown task lists no longer drop their checkboxes.** Pasting `- [ ] Foo` (from Obsidian, a terminal, or anywhere that puts plain markdown on the clipboard) into the Live editor produced bare text lines without bullets or checkboxes. Root cause: the paste handler used `@milkdown/utils`'s `insert(md)`, which wraps `doc.content` in `Slice(content, selection.openStart, selection.openEnd)` — when the cursor sat inside a paragraph (the common case) the slice's open ends were inferred as inline, so block-level lists collapsed to plain inline text on insertion. Switched to `markdownToSlice(md)` (the DOM-round-trip path) which serializes via the schema's `toDOM` (GFM's listItemSchema renders `<li data-item-type="task" data-checked="…">`) and re-parses via `DOMParser.parseSlice`, whose `parseDOM` rule extracts the `checked` attr and rebuilds the slice with proper open ends. Task list items survive the paste round-trip with checkboxes intact.
- **Live editor crash no longer blanks the entire app.** Some markdown content (deeply nested tables, certain HTML, malformed mermaid blocks) can throw inside Milkdown's `Editor.make()` or its plugin chain. Until now there was no React error boundary around the Live editor, so the exception propagated up to the app root and unmounted the entire tree — the user saw a blank white screen and had to hard-reload. New `EditorErrorBoundary` wraps the Live mount: on catch it (1) calls `onError`, which auto-flips `editorMode` to `basic` and persists the choice, (2) shows a banner above the editor pane naming the affected file and pointing to the toolbar toggle for re-trying Live, (3) resets itself when the user navigates to a different note (`resetKey={ns}/{path}`) so a single bad file doesn't lock out Live for the rest of the session. Manually toggling back to Live for the crashed file clears the banner.
- **Files created outside the UI now have a one-tap path to show up in the sidebar tree.** Files created via the `mdnest` CLI, the MCP server, or git-sync only auto-propagate to the browser when (a) live-collab is enabled (multi-mode + `ENABLE_LIVE_COLLAB=true`), AND (b) the user has a file open at the time — the per-file WebSocket is closed when no note is selected, so a `tree-changed` broadcast can't reach the client. Single-mode users have no WebSocket at all. The toolbar already has a refresh button for the open-file case, but it's hidden when no file is open, so on mobile (where there's no F5 / Cmd-R) the only recovery was a full browser reload. New refresh button added to the sidebar's tree-control bar (the row with expand-all / collapse-all / show-full-names). Always visible, works on touch, calls the same `refreshTree` path used after rename/move/delete. Spins for ~600ms on click so the action feels responsive even when the network call is fast.

### Mobile UX

- **Tree is usable on phones again at deep nesting.** Three CSS-side improvements behind the existing `@media (max-width: 768px)` breakpoint: (1) per-level indent reduced from `0.75rem` to `0.4rem` per depth — at depth 7 that's ~50px of left padding instead of ~92px, giving the label ~40% more room on a 360px-wide sidebar; (2) sidebar width grows from a flat `280px` to `min(88vw, 360px)`, using more of a phone's available width; (3) `.tree-row` gets `min-height: 40px` and a slightly larger font on phones, hitting the Apple HIG / Material Design minimum touch-target size so siblings don't get fat-fingered. Indent is now driven by a `--tree-depth` CSS custom property (set inline by `TreeNode.jsx`) so the breakpoint can override it cleanly. Long folder/file names ellipsize via `text-overflow: ellipsis` instead of pushing the chevron off-screen; the native `title=""` tooltip still shows the full name on hover.
- **Move files and folders without drag-and-drop.** Touch devices have `draggable=false` on tree rows (long-press is reserved for the context menu, and HTML5 drag-and-drop on touch interferes with scroll), so there was no way to move a file from one folder to another on a phone. New **Move to…** entry in the context menu opens a touch-friendly destination picker — flat list of folders in the namespace with hierarchy indent, 44px-tall rows, "Move here" confirm. Filters out invalid destinations (the source itself, the source's current parent, any descendant of the source if the source is a folder). Calls the same `POST /api/move` endpoint desktop drag-and-drop uses, so collision and permission rules are byte-identical across the two paths. Available on desktop too as an accessibility-friendly alternative to dragging. New `MoveToModal.jsx` component.
- **History modal is readable on phones.** The desktop layout puts a fixed-240px commit list next to a flex-1 content pane — on a 330px-wide phone modal that collapses the content to ~60px and stairsteps every line of markdown one word at a time. Below 768px we now stack vertically: the commit list takes the top 28vh, the content pane takes 50vh, and the "Compare to:" dropdown wraps to fill width. Modal grows from `min(900px, 92vw)` to `min(640px, 96vw)` for a touch more horizontal room. Desktop layout is unchanged.
- **Tree loading shows a spinner instead of "No files yet".** On slow connections the previous empty-state copy made it look like a namespace was empty mid-fetch. Now: while `getTree()` is in flight and the tree is empty, the sidebar shows a centered Catppuccin-blue spinner + "Loading…" text. When the tree is already populated and a refresh fires (after rename/move/create/delete/git-sync), a thin animated progress bar slides at the top of the tree area while the refresh lands — the existing tree stays visible underneath. Both are CSS-only animations, no JS overhead.
- **Long folder/file names are readable on phones.** Two coordinated changes that don't disrupt the tree's visual rhythm: (1) the sidebar slide-over grows from `min(88vw, 360px)` to `min(94vw, 420px)` on phones — since the sidebar overlays the editor anyway when open, reserving more room for the tree makes long names fit without compromise. (2) The toolbar's open-file path was `white-space: nowrap` + ellipsize-from-end, which on narrow toolbars cut the *filename* (most informative part) and kept the parent folders. Now split into `dirname / basename` spans: the dir half shrinks and ellipsizes when squeezed, the basename half has `flex-shrink: 0` and stays visible. The basename gets a slightly brighter color + medium weight to read as the primary identifier. Full path is on the `title=""` attribute for desktop hover reveal. Tree labels keep their single-line ellipsis everywhere — no per-row layout jumps.

### Notes

- **Update check is opt-out, not opt-in.** Default-on so most operators learn about security patches; air-gapped or privacy-sensitive installs can set `DISABLE_UPDATE_CHECK=true` in `mdnest.conf` (or `UPDATE_CHECK_REPO=<owner/repo>` to point at a fork). Failures are logged at info level and never block startup. The backend hits GitHub from one IP per server per day — user IPs are never exposed to GitHub.
- **Release-notes payload is capped.** Release bodies over 8 KB are truncated in `/api/config` with a "see full release notes on GitHub" hint, to keep the config payload small even if a future release ships with a giant body.
- **No new database migration.** This release is config-and-UI only on the multi-mode side; no schema changes.

---

## v3.7.0 — In-app version history with restore (single + multi mode)

### New features

- **Right-click any note → History.** Opens a modal listing the most recent 50 commits affecting that file from the per-namespace git-sync repo, newest first. Selecting a commit shows its content as of that point, and **Restore this version** writes the old content back through the regular save path (so the v3.6.1 empty-overwrite guard, the ETag conflict check, and the websocket file-changed broadcast all run as usual — restoration is not a separate write path that could carry a new class of bugs). Works in both single mode and multi mode; the only requirement is that git-sync is configured for the namespace. If it isn't, the modal says so clearly with a one-line setup hint.
- **Multi-user awareness on restore.** When a user clicks Restore in a multi-user install with live collab on, the resulting websocket `file-changed` event now carries `reason: "restored"` and the restored-from SHA, so other users currently on the same file see a distinct **info-coloured banner** ("X restored this file to an earlier version (sha)") instead of the usual yellow conflict banner. Their unsaved local changes are preserved until they choose to reload — same UX shape as the existing conflict banner, deliberately a different colour and copy because a restore is an intentional action by another user, not a divergence.
- **Backend endpoints (also new).** `GET /api/note/history?ns=&path=` returns `[{commit, unix_ts, author, message}]` (capped at 50, newest first); `GET /api/note/at?ns=&path=&ref=<sha>` returns the file's content at a specific commit. `ref` is required to be a 7-40 char hex SHA — branch names, `HEAD~N`, and other git ref forms are rejected to keep the surface predictable. Both endpoints are read-only and gated by the same `RequireNsAccess` middleware that protects `GET /api/note`. `PUT /api/note` accepts a new optional `?restore-from=<sha>` query parameter that adds the broadcast tagging without changing any safety logic.

### Notes

- **No file locks.** The user explicitly asked whether this should add a per-file lock primitive (acquire-while-editing). Decision: no. The existing optimistic-concurrency model (ETag + the new info banner + the existing presence bar) handles the multi-user restore case cleanly without introducing the stale-lock / lock-takeover / lock-expiration UX surface that locking inevitably brings. If real users hit conflicts the new banner can't mediate, locking can be designed as its own feature later.
- **No diff highlighting for now.** The History modal shows old content as a plain `<pre>` rather than a coloured diff. A diff library can be wired in later if there's appetite; the simpler viewer is enough for v3.7.0.
- **No `--follow` for renamed files.** Per-file history starts when the file was named what it's named now. If a file was renamed, its pre-rename commits aren't in the modal — fall back to the GitHub UI for that case. Easy to add later.
- **Read-only collaborators** can browse history and view old content; the **Restore** button is disabled for them with a tooltip.

---

## v3.6.1 — Stop the Live editor's undo from erasing your notes

### New (small UX add)

- **Undo and Redo buttons in the Live editor toolbar.** Hidden behind keyboard shortcuts before — and on macOS the redo binding is `Cmd+Shift+Z`, not `Cmd+Y`, which trips up plenty of people. Now there are two visible buttons (curved-arrow icons) at the start of the toolbar. Same effect as `Cmd+Z` / `Cmd+Shift+Z` on the keyboard. The basic textarea editor already uses your browser's native undo/redo; no toolbar buttons there.

### Bug fixes (critical — data-loss prevention)

- **Pressing Cmd+Z 2-3 times in the Live editor could silently erase a non-empty note.** The data-loss path was a chain of four cooperating defects, and any single one of them would have prevented the loss. We've fixed all four. (1) The frontend's `content` state defaulted to `''` and was reset to `''` on namespace change / failed load / browser-nav transitions, so for a brief window the Milkdown editor was initialized with empty content even when a real (non-empty) note was about to load. That empty state ended up as a reachable entry in ProseMirror's undo stack — pressing Cmd+Z walked back through your typing and then into that empty load. (2) `<LiveEditor>` had no `key` prop, so the same Milkdown instance carried across note switches and Cmd+Z could walk into another note's history. (3) `handleContentChange`'s 800ms debounced autosave fired unconditionally — when the editor briefly held empty content, the autosave dutifully committed empty bytes to disk. (4) The backend's `PUT /api/note` had no guard against truncating a non-empty file to empty. Fixed in `App.jsx` (initial state is now `null` until a note is loaded; setting `null` during transitions instead of `''`; autosave skips when `newContent === ''` and the loaded content was non-empty; `key={ns/path}` on `<LiveEditor>` and `<Editor>` so each note gets a fresh instance with its own undo stack), `LiveEditor.jsx` (only mounts when content is a real string, so the empty-during-load transition no longer enters the undo stack), and `notes.go` (refuses to overwrite a non-empty file with an empty body unless the request explicitly passes `?allow-empty=1` — autosave never does, so the silent-truncation path is closed even if every layer above somehow fails).
- **Recovery for already-lost content:** if your install runs the optional git-sync sidecar (default cadence 600s), every note has a complete commit history in the per-namespace git repo. Browse the repo on GitHub to find a `sync: <UTC-timestamp>` commit before the destructive undo, view the file at that commit, and copy the content back. We are surfacing this as an in-app "Version history" button in v3.7.0 so future recovery doesn't require the GitHub UI.

---

## v3.6.0 — Admin password reset (UI + host CLI)

### New features

- **Superadmins can reset another user's password from the Admin Panel.** Each non-superadmin row in Admin → Users now has a "Reset password" button (visible only to superadmins, only when `USER_PROVIDER=local`). The dialog asks for a new password twice; on submit the target user's `must_change_password` flag is set so their next login is gated on picking their own password before they can do anything else (the existing forced-change flow in `Login.jsx` already handled this case for invited users — we just reuse it).
- **Resetting another superadmin's password from the UI is intentionally blocked.** That would be a lateral-escalation primitive — one compromised superadmin could lock out every other superadmin in a single click. The UI button is hidden for superadmin rows and the `/api/admin/reset-password` endpoint returns 403 if the target's role is `superadmin`. The legitimate recovery case (a colleague forgot their superadmin password) is handled by the new host-side CLI below.
- **`mdnest-server reset-password <email>`** — host-shell command for resetting *any* user's password, including superadmins. Prompts for the new password with hidden input (twice), pipes it via stdin to a one-shot backend container so the password never appears in argv or shell history. Validates `AUTH_MODE=multi` + `USER_PROVIDER=local` and refuses otherwise. Same `must_change_password=true` guarantee — the temp password is single-use.

### Notes

- No database changes. The `must_change_password` column has existed since the original multi-mode work, so this release is additive: any existing schema works unchanged.
- Federated providers (`firebase`, `sso`) reject the new endpoint — identity is owned by the IdP. Reset there.

---

## v3.5.4 — Fix renamed file vanishing from the sidebar when extension is dropped

### Bug fixes

- **Renaming a note to a name without a file extension silently hid it from the tree.** The sidebar only lists files with a recognized text extension (`.md`, `.txt`, `.json`, `.sql`, `.csv`, `.yaml`, `.yml`, `.markdown`) — that's `tree.go`'s `textExtensions` filter. The rename prompt accepted any string and passed it straight to `/api/move`, so typing `foo` while renaming `foo.md` wrote `foo` to disk and the file disappeared from the sidebar: still on disk, no error, no warning. Fixed in `App.jsx` by mirroring `doCreateNote`'s extension-preserving behaviour — when the target is a file and the typed name contains no `.`, the original extension is auto-appended. Folders are exempt; explicit extension changes (`foo.md` → `foo.txt`) still work as before.

---

## v3.5.3 — Fix bogus 409 "modified by another user" on first save of new notes

### Bug fixes

- **"This file was modified by another user" 409 on the first save of a freshly-created note.** Notes carry an invisible `<!-- mdnest:UUID -->` marker so comments survive renames; the marker is lazy-injected by `EnsureNoteID` the first time a comments endpoint touches a file. `ExtractNoteID` returned the body in two different shapes — bytes-as-is when no marker, with a trailing `\n` normalization when the marker was present — so the ETag computed by `getNote` *before* the lazy injection didn't match the ETag computed by `updateNote` *after*. The frontend's first autosave hit the conflict path with no actual conflict, the user lost their typed content on refresh. Same defect also fired on every save *after* the first (since `newETag = sha256(body)` ignored the same normalization). Fixed in `notes.go` by adding `canonicalForETag`, a helper that drops trailing newlines from clean note content. Wrapped around all three ETag call sites (`getNote`, `updateNote` `currentETag`, `updateNote` `newETag`) so the hash is identical regardless of whether the marker has been injected yet — the race becomes mathematically irrelevant. Bytes on disk and bytes returned to the editor are unchanged; only the hash input is canonicalized. Genuine conflicts (real concurrent edits) still 409 correctly.

---

## v3.5.2 — Fix empty tree for superadmin in multi mode

### Bug fixes

- **Superadmin users saw an empty file tree in multi-user mode.** The grant filter in the tree handler only bypassed filtering for `role="admin"` (namespace-admin), not `role="superadmin"`. Since superadmins have no explicit grant rows (they're meant to have implicit full access), `filterTreeByGrants` stripped every node — returning an empty root. Fixed by adding the `"superadmin"` role check alongside `"admin"` in `tree.go`.

---

## v3.5.1 — Go 1.26 bump for stdlib CVEs

### Security

- **Bumped Go to 1.26** (was 1.25). Clears five stdlib vulnerabilities flagged by govulncheck against the 1.25 line:
  - `GO-2026-4865` — `html/template` JS context tracking bug (XSS)
  - `GO-2026-4866` — `crypto/x509`
  - `GO-2026-4870` — `crypto/tls` KeyUpdate DoS
  - `GO-2026-4946` — `crypto/x509` slow policy validation
  - `GO-2026-4947` — `crypto/x509` slow chain building
- `backend/go.mod`: `go 1.25.0` → `go 1.26.2`. `backend/Dockerfile`: `golang:1.25-alpine` → `golang:1.26-alpine` (the moving tag tracks the latest 1.26.x patch so future fixes land on rebuild without manual bumps).
- No code changes required for the bump — `go mod tidy` was a no-op, `go build` and `go vet` clean, and the production-style `docker compose build --no-cache` succeeded against the new image.

---

## v3.5.0 — Namespace-scoped Admin role + SuperAdmin + token access scoping

### Breaking changes

- **Existing `role='admin'` users are migrated to `role='superadmin'` on first startup of v3.5.0.** They keep current behaviour — global access to every namespace, every user-management endpoint, every grant. This is a one-shot rename done by migration 007 and only fires when the migration runs the first time. No action required from operators.
- **The new `role='admin'` is namespace-scoped, not global.** A user with `role='admin'` can only manage the namespaces listed for them in the new `namespace_admins` table — they invite users into those namespaces, manage grants on them, promote co-admins, and trigger git-sync for them. They cannot delete users, change anyone's role, reset 2FA, or sync globally — those are SuperAdmin-only.
- **API tokens no longer get a system-wide admin bypass.** Pre-v3.5.0, an admin's token bypassed every permission check. Post-v3.5.0 a token resolves to its creator's current scope at request time: superadmin tokens are still global, namespace-admin tokens work only on their owner's admin namespaces, collaborator tokens work only on their owner's grants. Revoking a user's grant immediately revokes their tokens for that namespace too.
- **`ADMIN_EMAILS` now auto-promotes to `superadmin`** (was `admin`). This preserves the operator-bootstrap intent across the role rename.

### Features

- **Three-tier role hierarchy.** SuperAdmin (global) / Admin (namespace-scoped) / Collaborator (grants only). The model lets a multi-tenant deployment have one superadmin operator and per-team admins who can run their own namespace without seeing other teams' data.
- **`namespace_admins(user_id, namespace, granted_by, created_at)` table.** Migration 007 creates it; the `PermissionChecker` consults it on every `role='admin'` request to decide whether the namespace is in scope. The hot path is a single-row `EXISTS` query.
- **New endpoints `/api/admin/namespace-admins`** — `GET ?ns=<n>` lists admins of a namespace, `POST {user_id, namespace}` promotes (auto-bumps `users.role` from collaborator to admin, auto-creates a `permission='write'` grant on `/`), `DELETE ?user_id=<id>&ns=<n>` demotes (auto-reverts to collaborator if no other admin namespaces; the auto-grant is left in place so access doesn't disappear by surprise).
- **`/api/me` exposes `is_super_admin` and `admin_namespaces`** so the frontend can scope the admin panel without an extra round-trip on every page load.
- **`/api/admin/users` is filtered by caller scope.** SuperAdmins see all users; namespace admins see only users with grants or namespace_admins entries on their own namespaces (plus self).
- **`/api/admin/grants` is filtered by caller scope.** Same model: superadmin sees all, namespace admin sees only their namespaces. Create / update / delete return 403 if the target grant isn't in the caller's admin scope.
- **Reset 2FA, delete user, change role** are SuperAdmin-only. Promoting between superadmin/admin/collaborator globally requires SuperAdmin. Promoting another user as namespace admin only requires admin scope on the target namespace.
- **Sidebar admin scope hint.** Namespace admins see a yellow "Admin of: <ns list>" badge at the top of the admin panel so they know what they're managing.
- **New "Namespace Admins" tab in the admin panel.** Pick a namespace, see who admins it, promote any non-superadmin user, demote with one click. Visible to anyone with the panel; the backend scopes both reads and writes.

### Configurable grant depth

- **`GRANT_MAX_DEPTH`** in `mdnest.conf` caps how deep into a namespace tree an admin can scope a grant. `/` is depth 0 (always allowed), `/foo` is 1, `/foo/bar` is 2. New grants beyond the limit are rejected at `POST /api/admin/grants` with a 400 explaining the depth and the configured limit. Existing rows are grandfathered — only new INSERTs are checked. Default `3`. Set to `0` for no limit. The PathPicker dropdown in the admin UI reads the same value from `/api/config` and hides too-deep folders so admins can't pick something the API will reject.

### Dev-only

- **`INSECURE_DEV_LOGIN` backdoor** for local SSO testing. When set to `true` in `mdnest.conf`, the backend registers `POST /api/auth/dev-login` which mints a 30-day session JWT for any **existing** user by email — completely bypassing the IdP. Identity rules match SSO (no auto-provisioning, blocked users still rejected). Off by default; the route 404s when the flag is unset. The default sign-in page is unchanged (still strict SSO); the bypass is reachable only by manually navigating to `/?login=dev`. While enabled, every authenticated page renders a sticky red warning banner, and the backend logs a multi-line warning at startup. Strictly for local development — never enable on a non-localhost deployment. New `LoginDev.jsx` component, `devLoginEnabled` field on `/api/config`.

### Internal

- New `backend/store/namespace_admins.go`: `NamespaceAdminStore` interface + Postgres impl with `Add`, `Remove`, `IsAdminOf`, `ListByUser`, `ListByNamespace`, `CountByUser`. `Add` is idempotent via `ON CONFLICT DO NOTHING` so promote re-runs are safe.
- `backend/middleware/permission.go`: new constructor `NewPermissionChecker(grantStore, nsAdminStore)` and a `hasAdminScope(uc, ns)` helper. The three places that used to short-circuit on `Role == "admin"` now go through it.
- `backend/middleware/admin.go`: `RequireAdmin` now means "any admin role"; new `RequireSuperAdmin` for the global gate. `IsSuperAdmin(ctx)` helper added.
- `backend/handlers/admin.go`: every method now scopes through `callerCanAdminNamespace` / `callerAdminNamespaces`. `ensureNotLastAdmin` → `ensureNotLastSuperAdmin` (only superadmins are deadlock-load-bearing).
- `backend/handlers/sync.go` takes an `nsAdminStore` and returns 403 when the caller isn't allowed to sync the requested namespace.
- `backend/handlers/tokens.go`: `listTokens` and `revokeToken` no longer give `role=='admin'` system-wide visibility — superadmin only. Owners always see / revoke their own.
- `backend/store/grants.go`: + `GetGrant(id)` so admin handlers can authorize the action against the target grant's namespace.
- Frontend: `App.jsx` derives `isSuperAdmin` and `adminNamespaces` from `/api/me`; threads them into `AdminPanel`. The panel hides global actions (Cycle role, Delete user) for non-superadmins, locks the Invite namespace dropdown to admin scope, adds the Namespace Admins tab. New `api.js` helpers: `adminListNamespaceAdmins`, `adminAddNamespaceAdmin`, `adminRemoveNamespaceAdmin`. `adminInviteUser` accepts a `namespace`.

---

## v3.4.0 — Corporate SSO + Federated Identity

### Features
- **`mdnest-server reload`** — new lightweight subcommand for config-only edits. Regenerates `.env` + `docker-compose.yml` from `mdnest.conf` and force-recreates `backend` + `frontend` (and `git-sync` if enabled) so they re-read the new env. No image rebuild — ~10s vs `rebuild`'s 60-90s. Postgres and other persistent services are left untouched. Use after editing `mdnest.conf` (e.g. flipping `USER_PROVIDER`, adding a `MOUNT_*`, rotating an SSO secret).
- **`mdnest-server rebuild` always force-recreates app containers.** Previously the default rebuild relied on the `--no-cache` backend build to change the image hash, which usually triggered recreation but could miss conf-only changes that produced an identical binary. Now `rebuild` always passes `--force-recreate` to `compose up -d` for `backend` + `frontend`, guaranteeing the new `.env` is read. Postgres + git-sync still stay running. `--full` continues to nuke everything for the rare cases that need it.
- **Backend Dockerfile: BuildKit cache mounts.** `/root/.cache/go-build` and `/go/pkg/mod` are now persisted across builds. After v3.4.0 added Firebase Admin SDK + grpc + protobuf, a clean `go build` was taking 180-235s on a small EC2. With cache mounts the first build is unchanged, but every subsequent rebuild reuses the precompiled package archives → typically **10-30s** for source-only changes. The default `rebuild` also drops `--no-cache` to take advantage of layer caching too; `rebuild --full` keeps `--no-cache` for the paranoid case.
- **`mdnest-server` disables BuildKit attestations.** Sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1` at the top of the script so every build skips SLSA provenance + SBOM generation. These are designed for images pushed to a registry; we build locally, so they're pure overhead and can hang at "resolving provenance for metadata file" depending on the host's network conditions. Skipping them never affects image content or behaviour.
- **Corporate SSO via generic OIDC.** New `USER_PROVIDER=sso` mode (requires `AUTH_MODE=multi`). Users sign in through your IdP (Google Workspace, Okta, Microsoft Entra, Keycloak, Auth0 — anything that speaks OIDC discovery). Backend uses `coreos/go-oidc` + `oauth2` with PKCE; state/nonce/code-verifier carried in a short-lived HMAC-signed cookie. The IdP owns MFA, so mdnest's local 2FA is skipped in this mode. See `docs/sso-setup.md`.
- **Email-gated sign-in, no auto-provisioning.** An SSO sign-in only succeeds if the email is already in the mdnest `users` table (invited by an admin). Role, grants, and blocked flag stay in Postgres. Rejection paths redirect back with `#sso_error=<code>` for the frontend to surface.
- **Optional `SSO_ALLOWED_DOMAINS`** allowlist for corporate-domain-only sign-in.
- **Firebase identity (peer mode).** `USER_PROVIDER=firebase` is also available for teams that prefer Firebase Auth + Firestore-backed shared TOTP. Docs: `docs/firebase-setup.md`. Chosen mode is exclusive per server; Firebase is not required and carries no overhead when not enabled.
- **`store.TOTPStore` interface.** TOTP handlers, login flow, and admin 2FA reset now route through an interface with Postgres and Firestore implementations. Makes the 2FA surface swappable and explicit.
- **`totp_enabled` JWT claim.** Populated at login-issue time so the frontend can render "Enable 2FA" vs "Manage 2FA" without hitting the TOTP store on every request. Real 2FA enforcement still runs against fresh state at login.
- **`ADMIN_EMAILS` bootstrap.** Comma-separated list in `mdnest.conf` is reconciled into `role='admin'` on every startup. Removals are NOT auto-demoted — operator demotes explicitly.
- **Profile name + avatar from the IdP.** SSO callback now reads the `name` and `picture` OIDC claims from the ID token. Avatar is mirrored into a new `users.avatar_url` column on every login (picture URLs rotate at the IdP). Username is filled in once when the row's value is empty — admin-set usernames are never overwritten. The sidebar renders `<img>` from `avatar_url` with a graceful fallback to initials when the image fails to load. New users created by the SQL-INSERT bootstrap path get their real face + name automatically on first sign-in instead of "User" / "?". Migration 006 adds the column; additive, safe in all modes.

### Internal
- New `backend/sso/` package: OIDC relying-party with PKCE, cookie-based state, domain allowlist, `SanitizeFromPath` to prevent open-redirect abuse through the post-login `from=` param.
- New `backend/handlers/sso.go` wiring two routes: `GET /api/auth/sso/start`, `GET /api/auth/sso/callback`. Only registered when `ssoClient != nil`, so misconfigurations 404 cleanly.
- New `backend/firebase/` package: Firebase Admin SDK wrapper + Firestore TOTP store. Only instantiated when `USER_PROVIDER=firebase`.
- Migration 005: `users.firebase_uid TEXT UNIQUE`, `DROP NOT NULL` on `password_hash` / `username`, indexes on `firebase_uid` and `email`. Additive; safe on local-mode databases.
- Frontend: `LoginSSO.jsx` for SSO mode, `LoginFirebase.jsx` for Firebase mode, unchanged `Login.jsx` for local mode. `App.jsx` picks the right one from `/api/config.userProvider`. Hash-fragment token handoff (`#sso_token=…`) for the SSO callback.
- `Settings.jsx` hides the "Credentials" tab in both federated modes (no local password to change).
- `setup.sh` validates SSO / Firebase config at rebuild time, emits env vars into `.env`, mounts Firebase JSON files when needed.
- Dockerfile: Go image bumped to `golang:1.25-alpine` (Firebase Admin SDK requires Go 1.25+).

---

## v3.3.1 — Preview crash hotfix + CLI server-alias cleanup

### Breaking (CLI)
- **No more silent `@default` alias.** `mdnest login <url> <token>` without an explicit `@alias` used to create an alias literally named `default` — which hid which server was which in copy-path URIs. Now the CLI fetches `/api/config` and uses the server's `SERVER_ALIAS` automatically. If the server doesn't advertise one, login refuses with an actionable error: either pass `@alias` explicitly or set `SERVER_ALIAS=<name>` in the server's `mdnest.conf` and rebuild.
- **`@default` is rejected as an alias name** at login time.
- **New `mdnest rename @old @new` command** so users stuck with an existing `@default` alias can fix it in one step. Updates the default-server pointer if it referred to the old name.
- **Existing `@default` aliases keep working** (backward-compat for scripts) but print a one-line deprecation nudge per invocation pointing at `rename`.

### Server
- **`SERVER_ALIAS` soft-required.** Backend logs a `WARNING` on startup if it's unset, and `setup.sh` prints a warning at rebuild. Not a hard failure (existing installs keep running), but CLI users on unnamed servers have to pass `@alias` manually until it's set.
- `mdnest.conf.sample` now ships with `SERVER_ALIAS=mdnest` uncommented and a comment explaining why.

### Fixes
- **Preview crash on task lists with nested content** — clicking Split or Preview view on a file whose task list contained nested blocks (sub-lists, multi-paragraph items) threw `Token with "list" type was not found` from marked and took the preview tree down. Root cause: the custom `listitem` renderer called `parseInline` on block-level tokens. Fixed by dropping the override entirely — marked v15 already renders GFM task lists as `<li><input type="checkbox">`, and we re-wire those in the DOM post-pass.
- **Preview crash on headings / paragraphs / tables** — follow-up regression from the first fix attempt. Passing a plain-object `renderer` via the per-call `marked(src, {renderer})` option **replaces** the default renderer entirely in marked v15, instead of merging with it. Any token type not explicitly overridden (heading, paragraph, table, blockquote, etc.) crashed with `this.renderer.X is not a function`. Fixed by switching to `new Marked().use({renderer: {...}})`, which merges with defaults.

### Robustness
- **Preview error containment** — `renderMarkdown` is now wrapped in try/catch, and the `Preview` component is wrapped in a `PreviewErrorBoundary`. A malformed note (or any future renderer bug) now shows a readable error panel inside the preview pane instead of unmounting the whole app. The boundary auto-resets when the user navigates to a different note, so a single bad file doesn't permanently black out the pane.
- **View-mode toggle visible without a file open** — previously the Editor / Split / Preview and Basic / Live toggles were hidden when no file was selected. That trapped users in a bad mode after a crash: every file they tried to open re-triggered the same render path. Toggles are now always visible so users can pre-switch to a safe mode before opening the next file.

---

## v3.3.0 — Inline Comments

### Features
- **Inline comments** — select text in the Live editor and attach a comment to it. Commented text gets a persistent bright-yellow highlight so reviewers see what's been discussed at a glance. Highlights do not appear in print or export.
- **Threaded replies** — each comment can carry a conversation. Click **Reply** under any active thread to add a message; Enter sends, Esc cancels. Replies stack inside the parent card.
- **Comment sidebar** — slide-out panel on the right with active and resolved threads. Each thread shows the quoted anchor text, author, relative time, and actions (Go To, Reply, Resolve, Delete).
- **Clickable highlights** — click yellow text in the editor to open the sidebar and pulse the matching comment card into view.
- **Go To with pulsing flash** — the **Go To** button scrolls the commented text into view and plays a ProseMirror decoration flash on it, so the location is obvious even in long documents. Position tracking is done by ProseMirror itself, so scrolls and edits don't desync it.
- **Cross-mark anchor matching** — highlights work even when the commented selection spans inline marks (bold, italic, inline code, links). The search concatenates every text node with position mapping, rather than walking nodes one at a time.
- **UUID-anchored storage** — each note carries an invisible `<!-- mdnest:UUID -->` marker at the bottom, stripped on GET and re-injected on PUT. Comments are stored at `<namespace>/.mdnest/comments/<uuid>.jsonl`, so moving or renaming a file keeps its comments attached.
- **Direct-link loading** — comments now load correctly when opening a note via URL hash or browser back/forward, not just when clicked in the tree.
- **Requires multi-user + live collab** — comments need both `AUTH_MODE=multi` (for real author identity) and `ENABLE_LIVE_COLLAB=true` (for the WebSocket hub). Without either, the UI is hidden and the `/api/comments` route is unregistered.

### Fixes
- **Floating Comment popup at wrong positions** — suppressed when the triggering mouseup/keyup comes from outside the editor (e.g. clicking Go To in the sidebar no longer resurrects the popup).
- **Single-user / collab-off mode crash on comment** — the comment UI was showing in single-user mode and in multi-user installs that disable live collaboration (`ENABLE_LIVE_COLLAB=false`), even though the feature requires real user identity and the WebSocket hub. Comments are now gated on `liveCollab` on both the frontend (no icon, no popup, no sidebar, no API calls) and the backend (`/api/comments` route is only registered when live collab is on).

---

## v3.2.2 — Responsive Mobile & Stability

### Fixes
- **Mobile responsive rendering** — uses React `isMobile` state instead of CSS-only for editor/preview switching. At 768px breakpoint, only one wrapper renders (editor OR preview), preventing blank screens and split-view glitches.
- **Mobile mobileView sync** — syncs with desktop viewMode on first load so preview mode works on mobile.
- **False update banner (v1.0)** — removed second fallback in api.js that returned version '1.0' when config failed.
- **WebSocket status hidden when no file** — "Offline" no longer shows when no file is selected.

---

## v3.2.1 — Performance & Stability

### Fixes
- **Server overload (critical)** — GET requests on `/api/note` triggered `BroadcastTreeChanged` to all WebSocket clients, causing an infinite loop. Now only broadcasts on mutating requests (PUT/POST/DELETE).
- **WebSocket ghost reconnections** — switching files left stale `onclose` handlers that reconnected to the old file, stacking connections. Fixed with connection ID tracking.
- **Tree filtering** — non-markdown files (Postman JSON, binaries) excluded from tree. Supports `.md`, `.txt`, `.json`, `.sql`, `.csv`, `.yaml`. Files >5MB skipped. Empty directories still shown.
- **Removed 15-second tree polling** — WebSocket `tree-changed` events handle tree updates. Eliminated 80+ redundant requests/min with 20 users.
- **Note poll reduced** — 10s → 60s. WebSocket `file-changed` is real-time, poll is just a fallback.
- **Tree-changed debounce** — 1-second debounce prevents rapid-fire tree refreshes from bulk operations.
- **PathPicker cache** — admin panel directory picker caches tree API for 30s, preventing N duplicate calls.
- **ETag conditional (304)** — note GET returns 304 Not Modified when content unchanged, saving bandwidth.
- **Backend always rebuilt --no-cache** — prevents stale Docker cache from deploying old binaries.
- **False update banner** — no longer shows "v3.2.1 → v1.0" when backend is slow/unreachable.
- **iPad viewport** — `100dvh` accounts for mobile browser bar. View mode toggle visible on tablets.
- **Copy path URI** — uses `mdnest://@alias/namespace/path` format for LLM readability.
- **WebSocket status text** — shows "Live", "Reconnecting", or "Offline" next to the status dot.
- **CLI login warning** — warns before overwriting default server with a different URL, suggests aliases.

---

## v3.2.0 — Two-Factor Authentication & Account Security

### New Features
- **Two-Factor Authentication (TOTP)** — authenticator app support (Google Authenticator, Authy, 1Password). QR code setup, recovery codes, admin reset.
- **Mandatory 2FA** — `REQUIRE_2FA=true` in config forces all users to set up 2FA. Guided setup flow during login with QR code + step-by-step instructions.
- **Shared 2FA across servers** — `export-2fa` / `import-2fa` commands let admins share TOTP secrets across multiple mdnest instances. One authenticator entry for all servers.
- **Forced password change** — new users must change their password on first login (`must_change_password` flag).
- **Block/unblock users** — admin can block users, preventing login with a clear error message.
- **Multi-step login flow** — password → forced password change → 2FA setup/verify → JWT. Each step shows a clean UI.
- **30-day sessions** — JWT expiry extended from 24 hours to 30 days (safe with 2FA).
- **Auto-migrate on rebuild** — `./mdnest-server rebuild` automatically runs database migrations for multi-user mode.

### Fixes
- **Mermaid text colors** — injected SVG `<style>` override ensures light text on all diagram types. No more black text on load or color toggling on click.
- **Mermaid label click** — diagram-type agnostic click handler. Works on all mermaid types (sequence, flowchart, class, etc.) by finding nearest `<g>` group text instead of checking specific CSS classes.
- **Mermaid label replace** — handles `<br/>` line breaks at any word boundary via brute-force matching.
- **WebSocket stale closure** — collab message handler used stale namespace/path from closure, causing one user's saves to disrupt another user's view. Now uses refs for current values.
- **Editor mode reset** — switching files no longer resets Live mode to Basic. Editor/view mode are global user preferences, not per-file.
- **Table cell selection** — multi-cell selection now visually highlights in Live editor (blue overlay).
- **Table row paste** — copying table rows and pasting inside an existing table inserts rows after the current row instead of creating a new table.

### Config
- `REQUIRE_2FA=true|false` — require all users to set up 2FA (default: false)
- `TOTP_ISSUER=name` — issuer name shown in authenticator app (default: mdnest)

---

## v3.1.8 — Developer Experience & Security

### New Features
- **Pre-push git hook** — verifies frontend/backend compile, npm audit, govulncheck, lock file integrity, and version consistency before every push. Install with `./mdnest-server dev-setup`.
- **`remove-namespace` command** — lists namespaces, removes config entry and deploy key. Files on disk are NOT deleted.
- **Improved `add-namespace`** — two clear paths (GitHub clone or local directory), SSH verification, auto-clone, branch name prompt, never exits on bad input (re-prompts instead), auto-creates subdirectories for non-empty paths.

---

## v3.1.7 — Mermaid Improvements & UX Polish

### New Features
- **Per-file preferences** — each file remembers its view mode (editor/split/preview), editor mode (basic/live), and scroll position in localStorage. Survives page refresh.
- **Default to Live editor** — new files open in Live editing mode instead of basic textarea.
- **Sync status visible to all users** — "Synced 5m ago" green dot shown to collaborators, not just admins. Sync trigger button stays admin-only.
- **`add-namespace` command** — `./mdnest-server add-namespace` walks through creating a namespace: directory, git init, deploy key generation, remote URL setup.

### Fixes
- **Mermaid color revert on label edit** — mermaid.initialize was only in Preview.jsx; Live mode used default pastel theme. Moved to shared `mermaid-config.js`.
- **Mermaid text contrast** — smart post-processing detects parent node fill brightness and forces dark or light text for readability.
- **Mermaid label click for multi-line labels** — labels with `<br/>` line breaks now correctly detected and replaced in source.
- **Mermaid code consolidated** — theme config, initialization, and text color fix all in one shared file.
- **Refresh icon moved** — now appears right after the file path instead of at the end of the toolbar.
- **Raw editor paste fix** — pasting markdown text no longer wraps it in triple backticks.
- **Git-sync fresh repos** — first push uses `--set-upstream` for newly created namespaces.
- **Git-sync SSH alias auto-fix** — detects `host:path` format (without `git@`) and rewrites to `git@github.com:path`.
- **Rebuild force-recreates git-sync** — volume-mounted services always restart on rebuild.

---

## v3.1.1 — Critical Save Fix

### Fixes
- **Live Editor stale onChange (critical)** — switching files in Live mode caused 409 conflicts and lost changes. Milkdown's `markdownUpdated` listener captured `onChange` once at editor creation, so saves went to the wrong file path after switching. Fixed with `onChangeRef` that always points to the latest callback.
- **MutationObserver phantom saves** — Milkdown's async MutationObserver fired `markdownUpdated` after `replaceAll`, triggering phantom saves that changed file ETags. Now suppressed until real user interaction (keydown/mousedown).
- **Auto-refresh poll race condition** — in-flight `getNote` responses from the previous file could overwrite the new file's state after switching. Now discards stale responses.
- **Save timer stale closure** — `saveTimer` was React state (stale in closures), changed to ref. Cleared on file switch.
- **Version update banner** — active sessions show a blue banner when server is updated, with "Refresh Now" button.
- **Browser cache on deploy** — nginx serves `index.html` with `no-cache` so hard refresh picks up new bundles.

---

## v3.1.0 — Mermaid Zoom & Live Toolbar

### New Features
- **Mermaid zoom controls** — `−` / `+` / `Fit` buttons in the mermaid toolbar. Zoom 20%–300% via CSS transform. Small diagrams render at natural size, large diagrams fill container width.
- **Rich text formatting toolbar** — Live mode now has a full toolbar: Bold, Italic, Strikethrough, Code, H1/H2/H3, Bullet/Numbered list, Blockquote, HR, Link, Code block, Table, +Row/+Col/-Row/-Col.
- **Copy mermaid code** — Copy button in mermaid toolbar copies the source code to clipboard.
- **Version update banner** — when the server is updated, active sessions show a blue banner with current → new version and a "Refresh Now" button. Polls `/api/config` every 60s.

### Fixes
- **Live Editor stale onChange (critical)** — switching files in Live mode caused 409 conflicts and lost changes. Root cause: Milkdown's `markdownUpdated` listener captured `onChange` once at editor creation, so saves went to the wrong file path. Fixed by using a ref that always points to the latest callback.
- **Auto-refresh poll race condition** — in-flight `getNote` responses from the previous file could overwrite the new file's state. Now discards stale responses via a poll key check.
- **Save timer stale closure** — `saveTimer` was React state (stale in closures). Changed to `useRef` and cleared on file switch.
- **Smart mermaid sizing** — uses SVG viewBox dimensions (reliable) instead of width attribute (unreliable). Small diagrams centered at natural size, large diagrams fill container.
- **Mermaid fullscreen** — was broken because modified SVG (stripped attributes) was passed to viewer. Now stores and passes original unmodified SVG.
- **Scroll position on view switch** — switching between editor/split/preview modes now preserves scroll position.
- **Browser cache on deploy** — nginx now serves `index.html` with `no-cache` header so hard refresh always picks up new JS bundles.

---

## v3.0.0 — Live Rich Editor

### New Features

- **Live editor mode** — Obsidian-style rich editing powered by Milkdown (ProseMirror). Markdown renders inline as you type: bold shows bold, headings render as headings, lists format in place. Toggle between Basic (plain textarea) and Live mode from the toolbar.
- **Interactive table editing** — click into table cells to edit. Toolbar buttons to insert tables, add/remove rows and columns. Tab between cells.
- **Mermaid inline rendering** — mermaid code blocks render as diagrams in-place in Live mode with Source/Preview/Fullscreen buttons. Click any node or edge label to edit it directly on the diagram.
- **Clickable checkboxes in edit mode** — task list checkboxes work in Live mode without switching to preview.
- **Rich paste** — paste from Google Docs, Confluence, or any rich source into Live mode and it inserts as parsed markdown nodes (headings render as headings, not `# text`).
- **Scroll sync** — editor and preview scroll proportionally in split view.
- **Collapsible headings** — click the toggle icon on any heading in preview to collapse/expand that section. Expand All / Collapse All buttons in preview toolbar.

### Improvements

- **Lazy-loaded Live editor** — Milkdown only downloads when you switch to Live mode (462KB chunk). Main bundle stays at 311KB for fast initial load.
- **Smart backspace** — empty headings/blockquotes convert to paragraphs on single backspace in Live mode.
- **Text selection in mermaid** — can select and copy text from rendered mermaid diagrams in preview mode. Fullscreen expand moved to a hover button.
- **Editor mode per view** — Live mode preference is separate for editor-only view. Split view always uses Basic mode.
- **Heading collapse** — only the toggle icon (not heading text) triggers collapse. Expand All properly shows all nested content.
- **Copy buttons** — headings show a clipboard icon on hover (copies heading text). Code blocks show a "Copy" button on hover (copies code content).
- **Table delete controls** — separate Del Row, Del Col, Del Table buttons using direct ProseMirror commands (cursor in cell is enough, no need to select).
- **Scroll position persistence** — each document remembers its scroll position. Switch between documents and your reading position is restored.
- **Mermaid label editing for sequence diagrams** — participants, messages, and other sequence diagram labels are clickable alongside flowchart nodes.
- **Auto-expanding label editor** — mermaid label input grows/shrinks with text content.

### Dependencies

- Added: `@milkdown/core`, `@milkdown/ctx`, `@milkdown/react`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, `@milkdown/plugin-listener`, `@milkdown/plugin-history`, `@milkdown/plugin-clipboard` (all v7.20)
- Existing: `marked` (preview/basic mode), `mermaid` (diagrams) unchanged

### New Files

- `frontend/src/components/LiveEditor.jsx` — Milkdown editor wrapper with table toolbar, mermaid node view, paste handling
- `frontend/src/components/MermaidBlock.jsx` — React component for inline mermaid with Source/Preview toggle and click-to-edit labels

---

## v2.1.0 — Multi-Server CLI + Git Sync Fix

### New Features
- **Multi-server CLI** — manage multiple mdnest servers with `@alias` paths. `mdnest login @work <url> <token>`, then `mdnest read @work/engineering/docs.md`. Single-server users see zero change.
- **Flat CLI commands** — `mdnest read`, `mdnest list`, `mdnest search` etc. (no more `mdnest note` prefix needed, though it still works).
- **`mdnest servers`** — list all configured servers with versions and reachability.
- **Copy Path includes server alias** — right-click Copy Path in the web UI gives `@work/namespace/path` when `SERVER_ALIAS` is set, directly pasteable into the CLI.
- **Collapsible headings in preview** — click any heading to fold/unfold the section. Expand All / Collapse All buttons in preview toolbar.
- **Git sync status indicator** — green dot + "Synced 5m ago" in sidebar header.
- **Sync button commits + pushes** — pressing sync now does git add + commit + pull + push (was pull-only before).

### Fixes
- **Git-sync SSH key** — the git-sync sidecar now falls back to `SSH_KEY_PATH` when `git-sync/keys/` is empty. One SSH key config works for both the sync button and the auto-sync cycle.
- **Mermaid inline sizing** — 50% on desktop, 90% on mobile. Removed inline style override.
- **Sync button reloads current note** — not just the tree.
- **Tree arrows bigger and blue** — more visible expand/collapse indicators.
- **Hard refresh on login** — clean state, no stale data.
- **Removed "no key" warning** — was confusing for users who don't need git pull.

### Configuration
- `SERVER_ALIAS` — optional, sets the `@alias` used in CLI paths and Copy Path.
- `SSH_KEY_PATH` — now used by both the backend sync button AND the git-sync sidecar.

---

## v2.0.1 — Patch Release

### Fixes
- **Drag-drop to ancestor directories** — moving items up the tree (e.g. subdir to parent) was blocked by an overly aggressive guard. Fixed.
- **SSH key mount for git pull** — sync button now supports SSH authentication. Set `SSH_KEY_PATH` in `mdnest.conf` pointing to a passphrase-free deploy key.

### New Features
- **HTML-to-Markdown paste** — copy from Google Docs, Confluence, Notion etc. and paste into the editor. Rich content (headings, bold, lists, tables, code blocks) auto-converts to clean Markdown.
- **View mode persistence** — your Edit/Preview/Split selection is remembered across page reloads (stored in localStorage).
- **Mobile toggle restyle** — Edit/Preview buttons are now pill-shaped buttons instead of flat tabs.

---

## v2.0 — Multi-User Collaboration

> Powerful, privately-hosted Markdown notes — use it the way you like.

mdnest v2.0 transforms the app from a personal note tool into a collaborative workspace for teams, while keeping the default single-user experience unchanged.

### Upgrading from v1

If you're running mdnest v1 (single-user), **no changes are required**. Your existing setup continues to work exactly as before. Multi-user features are opt-in.

To enable multi-user mode:

1. Update your code:
   ```bash
   cd mdnest
   git fetch origin
   git checkout v2.0
   ```

2. Edit `mdnest.conf` — add:
   ```
   AUTH_MODE=multi
   POSTGRES_PASSWORD=a-secure-password
   ```

3. Run setup and migrate:
   ```bash
   ./mdnest-server setup      # regenerates docker-compose.yml with Postgres
   ./mdnest-server migrate    # creates database tables
   ./mdnest-server rebuild    # rebuilds and starts everything
   ```

Your first user (from `MDNEST_USER`/`MDNEST_PASSWORD`) becomes the admin automatically.

To also enable live collaboration:

4. Add to `mdnest.conf`:
   ```
   ENABLE_LIVE_COLLAB=true
   ```

5. Rebuild:
   ```bash
   ./mdnest-server rebuild
   ```

### New Features

#### Multi-User Mode (E1-E6)
- **PostgreSQL-backed user management** — optional, only when `AUTH_MODE=multi`
- **Roles** — Admin and Collaborator. Admins can invite users and manage access.
- **Namespace & directory-level access grants** — control who can read or write to which namespaces and subdirectories. `write` implies `read`. Grant on `/` covers the full namespace.
- **Permission enforcement** — every API endpoint checks access. Collaborators only see namespaces they have grants for.
- **Admin panel** — manage users (invite, promote/demote, delete) and access grants from the web UI. Accessible via the user avatar menu.
- **Frontend permission awareness** — read-only mode for view-only grants, write actions hidden when no permission, 403 handled gracefully (no redirect to login).
- **Logout button** and user identity display in the sidebar.
- **`/api/config`** — public endpoint returns auth mode and feature flags so the frontend adapts.
- **`/api/me`** — returns current user profile and grants.
- **Database auto-migration** — tables created automatically on startup. Safe to run on every restart.
- **`mdnest-server migrate`** — standalone command for running migrations before starting.

#### Live Collaboration (E7)
- **WebSocket-based presence** — see who else has the same note open, with colored avatar dots and usernames.
- **Real-time cursor tracking** — colored cursor lines show where other users are in the document, with name labels.
- **Live content sync** — when one user types, others see the changes in real-time (~200ms). When both type simultaneously, each keeps their own content to avoid conflicts.
- **Typing indicator** — pulsing avatar and "bob is typing..." text in the presence bar.
- **ETag conflict detection** — `GET /api/note` returns an ETag, `PUT /api/note` accepts `If-Match`. Stale saves return 409 Conflict.
- **Conflict banner** — when another user saves while you have unsaved changes, a banner appears with a Reload button.
- **Auto-reconnect** — WebSocket reconnects automatically with exponential backoff on connection drop.
- **No external services** — everything runs on your server via `nhooyr.io/websocket`. No Firebase, no Google, no third-party dependencies.

#### UI Improvements
- **Resizable sidebar** — drag the right edge to make the project pane wider or narrower (180px–600px).
- **SVG file tree icons** — replaced emoji icons with crisp SVG icons. Folders with content show blue, empty folders show dashed grey outline with italic name.
- **Directory-level share dialog** — right-click any folder → "Manage Access" opens a clean dialog to add/remove users with read/write toggles per directory.
- **Directory picker for grants** — admin panel shows actual folder tree in dropdown instead of free-text path input.
- **User-centric grants accordion** — admin panel Access Grants tab shows each collaborator as an expandable card with all their directory grants inline.
- **Namespace sync button** — admin can click the sync icon in sidebar to trigger git pull and refresh the file tree.
- **Copy Path** — right-click any file or folder to copy its full mdnest path (e.g. `growth/docs/readme.md`) to clipboard.
- **User avatar menu** — sidebar footer shows user initials in a circle, click to open dropdown with "Manage Users & Access" and "Sign Out".
- **Tree filtering by grants** — collaborators only see directories they have access to, not the full namespace tree.
- **Mobile improvements** — Edit/Preview toggle moved to top, editor fills full screen width, sidebar resize handle hidden on mobile.

### Bug Fixes
- Fixed links in preview opening in the same tab instead of a new tab (marked v15 renderer compatibility).
- Fixed WebSocket proxy through nginx (missing upgrade headers).
- Fixed concurrent editing overwriting — remote content only applied when local user is idle.
- Fixed live content sync stopping after first remote update.

### Configuration Reference

New settings in `mdnest.conf` (all optional, defaults preserve v1 behavior):

| Setting | Default | Description |
|---------|---------|-------------|
| `AUTH_MODE` | `single` | `single` (file-based) or `multi` (PostgreSQL) |
| `POSTGRES_PASSWORD` | — | Required when `AUTH_MODE=multi` |
| `POSTGRES_HOST` | `postgres` | PostgreSQL host (use `postgres` for built-in container) |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `mdnest` | PostgreSQL database name |
| `POSTGRES_USER` | `mdnest` | PostgreSQL user |
| `ENABLE_LIVE_COLLAB` | `false` | Enable WebSocket presence and live editing |

### Docker Changes

When `AUTH_MODE=multi`, `setup.sh` automatically adds a `postgres` service to `docker-compose.yml` with:
- `postgres:16-alpine` image
- Health check (`pg_isready`)
- Persistent volume (`mdnest-pgdata`)
- Backend `depends_on` with health condition

### API Changes

New endpoints (multi-user mode only):

| Endpoint | Description |
|----------|-------------|
| `GET /api/config` | Public — returns auth mode and feature flags |
| `GET /api/me` | Current user profile + grants |
| `POST /api/admin/invite` | Create a new user (admin only) |
| `GET /api/admin/users` | List all users (admin only) |
| `PUT /api/admin/users?id=` | Update user role (admin only) |
| `DELETE /api/admin/users?id=` | Delete user (admin only) |
| `POST /api/admin/grants` | Create access grant (admin only) |
| `GET /api/admin/grants` | List grants (admin only) |
| `PUT /api/admin/grants?id=` | Update grant permission (admin only) |
| `DELETE /api/admin/grants?id=` | Revoke grant (admin only) |
| `POST /api/admin/sync?ns=` | Git pull + cache refresh for a namespace (admin only) |
| `GET /api/ws` | WebSocket for live collaboration |

Changed endpoints:

| Endpoint | Change |
|----------|--------|
| `GET /api/note` | Now returns `ETag` header |
| `PUT /api/note` | Accepts `If-Match` header, returns 409 on conflict. Response includes `etag` field. |
| `GET /api/namespaces` | In multi mode, filtered to user's granted namespaces |
| `GET /api/tree` | In multi mode, filtered to user's granted directories |

---

## v1.0 — Self-Hosted Private Knowledge Base

The initial release. A single-user, file-based markdown notes app.

### Features
- **Markdown editor** with live preview, split view, and formatting toolbar
- **Mermaid diagrams** rendered inline with interactive fullscreen viewer
- **Task checkboxes** — click to toggle in preview, auto-saves to file
- **Image upload** — paste or drag images into the editor
- **Full-text search** with concurrent file reading and cached file index
- **Namespace model** — mount multiple host directories as separate workspaces
- **REST API** with JWT and API token authentication
- **MCP server** for AI agent integration (Claude, Cursor)
- **CLI tool** (`mdnest`) for terminal-based note access from any machine
- **Git sync** — optional auto-commit and push to private repos
- **Mobile responsive** — works on phone, tablet, desktop
- **Docker deployment** — multi-stage builds, nginx proxy, alpine runtime
- **Private by default** — binds to localhost, no cloud, no telemetry
- **Tailscale ready** — one command for encrypted remote access
