# mdnest - AI Context

Privately-hosted Markdown notes app. Plain files on disk, Docker-based. Supports single-user (no database) and multi-user (PostgreSQL) modes.

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

If unsure which applies, prefer the skill over an ad-hoc approach and say which one
you're running. The `md-*` family is authoritative; the summaries here are just a
router. See also the **Release Process** section below (the skills implement it).

## Project Structure

```
backend/
  main.go                    # Entry point, route registration, AUTH_MODE branching
  handlers/
    auth.go                  # POST /api/auth/login (JWT)
    namespaces.go            # GET /api/namespaces (lists mounted dirs)
    tree.go                  # GET /api/tree?ns= (recursive dir listing)
    notes.go                 # GET/POST/PUT/PATCH/DELETE /api/note?ns=&path=
    search.go                # GET /api/search?ns=&q= (concurrent search with caching)
    tokens.go                # GET/POST/DELETE /api/auth/tokens (API token management)
    totp.go                  # 2FA: TOTP setup, verify, disable, admin reset
    upload.go                # POST /api/folder, /api/upload, GET /api/files/
    move.go                  # POST /api/move?ns=&from=&to=
    path.go                  # SafePath(), RequireNamespace() — shared utils
    noteid.go                # ExtractNoteID / InjectNoteID / EnsureNoteID (UUID marker)
    comments.go              # GET/POST/PATCH/DELETE /api/comments?ns=&path=&id=
    history.go               # GET /api/note/history, /api/note/at — git-sync version history (v3.7.0+)
    sso.go                   # GET /api/auth/sso/{start,callback} (USER_PROVIDER=sso only)
  firebase/                  # Firebase Auth + Firestore (USER_PROVIDER=firebase only)
    client.go                # Admin SDK wrapper (VerifyIDToken)
    totp_store.go            # Firestore-backed store.TOTPStore impl
  sso/                       # Generic OIDC relying-party (USER_PROVIDER=sso)
    client.go                # coreos/go-oidc + oauth2 with PKCE, signed state cookie
  middleware/
    auth.go                  # JWT validation middleware
    cors.go                  # CORS middleware
  updates/                   # Background poller for newer mdnest releases (v3.8.0+)
    checker.go               # 24h GitHub releases poll, served on /api/config as latestRelease
  store/
    db.go                    # Postgres connection pool (multi mode only)
    migrate.go               # Auto-migration: schema_migrations, users, access_grants, firebase_uid (005), avatar_url (006), namespace_admins (007)
    users.go                 # UserStore (Postgres) + UpsertFirebaseUser / PromoteToSuperAdmin
    namespace_admins.go      # NamespaceAdminStore — per-namespace admin scope (v3.5.0+)
    totp_store.go            # TOTPStore interface + PostgresTOTPStore

frontend/
  src/
    App.jsx                  # Root: auth, namespace/tree state, context menu, URL routing
    api.js                   # All API calls (fetch wrapper with JWT + 401 handling)
    wikilink.js              # Obsidian [[wikilink]] support (v3.11.5+) — pure module: parse/resolve, marked inline extension, relative-.md-link resolver, restoreWikilinks() serializer-unescape. No React imports (unit-tested standalone).
    mermaid-config.js         # Shared mermaid init, theme, and fixMermaidTextColors()
    firebase-config.js       # Firebase SDK lazy init (USER_PROVIDER=firebase only)
    components/
      Login.jsx              # Auth form (USER_PROVIDER=local)
      LoginFirebase.jsx      # "Sign in with Google" button (USER_PROVIDER=firebase)
      LoginSSO.jsx           # Corporate SSO sign-in button (USER_PROVIDER=sso)
      Sidebar.jsx            # Namespace picker, tree area, expand/collapse
      TreeNode.jsx           # Recursive tree node (drag-drop, context menu, long-press)
      Toolbar.jsx            # Top bar: hamburger, +Note, +Folder, path display
      Editor.jsx             # Basic mode: textarea with tab/paste/drop support
      EditorToolbar.jsx      # Markdown formatting buttons (basic mode)
      LiveEditorCrepe.jsx    # Live mode: @milkdown/crepe-based rich editor (v3.10.0+)
      live-editor-plugins.jsx# Shared Milkdown plugins (comments, table-cell checkboxes, clearEmptyBlock) + LiveToolbar component
      MermaidBlock.jsx       # Inline mermaid with Source/Preview toggle + click-to-edit labels
      Preview.jsx            # Rendered markdown (marked + mermaid)
      ContextMenu.jsx        # Right-click / long-press floating menu
      CommentSidebar.jsx     # Inline comments: slide-out panel, threads, replies, Go To
      HistoryModal.jsx       # Per-file git-sync history viewer + restore (v3.7.0+)
      MoveToModal.jsx        # Touch-friendly destination picker for "Move to…" context action (v3.8.0+)
      EditorErrorBoundary.jsx # React error boundary around Live editor — catches Milkdown crashes and flips to Basic (v3.8.0+)

mcp-server/
  index.js                   # MCP server entry — tools + resources wrapping REST API
  package.json

mdnest                       # Client CLI (login, note read/write/append, works from any machine)
mdnest-server                # Server management CLI (start, stop, rebuild, reset-password, runs from project dir)
setup.sh                     # Reads mdnest.conf, generates docker-compose.yml + .env
mdnest.conf.sample           # Template config with MOUNT_ entries
```

## Key Conventions

### Backend (Go)
- Standard library only, no web framework — just net/http with ServeMux
- External dependencies: golang-jwt/jwt/v5, lib/pq (Postgres driver), golang.org/x/crypto (bcrypt)
- Two auth modes: `AUTH_MODE=single` (file-based, no DB) or `AUTH_MODE=multi` (Postgres)
- Three identity providers (multi-mode only): `USER_PROVIDER=local` (default, username/password), `USER_PROVIDER=firebase` (Firebase Auth + Firestore TOTP), `USER_PROVIDER=sso` (generic OIDC). Exclusive; chosen at startup. In `sso` mode 2FA is skipped entirely (IdP owns MFA) and local password endpoints are unused. See `docs/sso-setup.md` and `docs/firebase-setup.md`.
- **Three role values** (v3.5.0+): `superadmin` (global), `admin` (namespace-scoped via the `namespace_admins` table), `collaborator` (per-grant only). Pre-v3.5.0 `admin` is migrated to `superadmin` by migration 007. `ADMIN_EMAILS` auto-promotes to `superadmin`. Permission checks go through `middleware.PermissionChecker.hasAdminScope(uc, ns)` — superadmin bypasses everywhere; admin only for `namespace_admins` rows; everyone else falls through to grants. API tokens follow the same precedence chain (no admin bypass for tokens).
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
- Wikilinks (v3.11.5+, `wikilink.js`): resolution runs against the current namespace tree only (built via `buildPathIndex(tree)` and memoized in `App.jsx`, shared by `Preview.jsx` and the Live editor). Round-trip fidelity is the hard requirement — the Live editor stores literal `[[...]]`, but Milkdown's serializer escapes `[[`→`\[\[` in plain text, so `markdownUpdated` routes every serialized doc through `restoreWikilinks()` before `onChange`. Don't add a wikilink node to the schema — the decoration + serializer-unescape approach is deliberate so bytes never change.
- Mermaid: `LiveEditorCrepe.jsx` defines an inline `mermaidNodeView` that renders the `MermaidBlock` React component for `code_block` nodes where `language === 'mermaid'`. The compose-mermaid plugin runs after `SchemaReady`, reads Crepe's existing `code_block` factory from `nodeViewCtx`, and writes a wrapper that delegates to it for non-mermaid blocks — so Crepe's CodeMirror UI still works for other code languages AND mermaid renders via our React component.
- Image upload: Crepe's `image-block` `onUpload` calls `uploadImage()` in `api.js`. `proxyDomURL` resolves the bare-filename markdown src (e.g. `![](photo.png)`) into `/api/files/<ns>/<dir>/<file>?token=<jwt>` for rendering — the `?token=` query param is the auth-fallback the middleware accepts for `<img>` GETs that can't carry an `Authorization` header.
- Per-namespace last-file memory: `localStorage` key `mdnest_last_path:<ns>` records the path of whichever note was last opened in each namespace. Restored on namespace switch and on initial load when there's no URL hash. URL hashes still win for explicit navigation. Per-file scroll position lives in `mdnest_file_prefs:<ns>/<path>.scrollPct` (existing pre-v3.10 mechanism).
- Crepe nodeView composition: when overriding a node view that Crepe registers (e.g. `code_block` for mermaid, `table` for the click-to-cursor fix), the pattern is to wait for `SchemaReady`, read the existing entry from `nodeViewCtx`, then append a new entry with the same node-type id. `Object.fromEntries(nodeViewCtx)` keeps the last entry for duplicate keys, so ours wins; we keep a reference to the original factory and delegate to it for cases we don't want to override.
- Both editor implementations share the same onChange/content props — Crepe is now the only Live editor, but `App.jsx` keeps its lazy import named `LiveEditor` so the JSX call site stays editor-agnostic.

### Namespace Model
- Namespaces are NOT created at runtime — they are host directories mounted via Docker volumes
- Configured in `mdnest.conf` as `MOUNT_<name>=<host_path>`
- `setup.sh` generates docker-compose.yml volume mounts from these
- Backend sees them as subdirectories under NOTES_DIR
- GET /api/namespaces lists them (reads top-level dirs)

### Docker
- Backend: golang:1.24-alpine build, alpine runtime
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

- **One PR per release.** Bundle all the work for a release into a single branch (`feat/<name>` or `release/v3.X.Y`) and open **one** PR against `main`. Don't open intermediate / sibling PRs for sub-features during the same release cycle — they cause merge conflicts on shared files (`CHANGELOG.md`, the three version files, `App.jsx`, docs) when one lands while another is still open. Hotfix exception: a true emergency (security CVE, prod crash) can ship as its own PR ahead of the release, but flag it before opening. v3.10.0 hit exactly this — PR #10 (v3.9.1) merged while PR #11 (v3.10.0) was open and produced six-file conflicts; resolve by merging `main` into the release branch and keeping the higher version + the deletion of any files the cutover removed.
- **Version scheme — `develop` carries `X.Y.Z-dev`, releases drop the suffix.** `develop` always holds the in-flight version with a `-dev` pre-release suffix (e.g. `3.11.3-dev`), so a develop/staging box reads `v3.11.3-dev` ("candidate, still validating") and production reads the plain `v3.11.3`. The **release branch sets the plain `X.Y.Z`** (drops `-dev`); after the release merges, bump `develop` to the *next* `X.Y.(Z+1)-dev`. `isVersionNewer` (App.jsx) is pre-release-aware so a `-dev` build shows no false "update available" against the last release but does see the final release as newer once it ships.
- Set the version in three files — on the release branch use the plain `X.Y.Z`; on `develop` use `X.Y.Z-dev`:
  - `backend/handlers/config.go` — `"version": "3.X.Y"`
  - `frontend/package.json` — `"version": "3.X.Y"`
  - `mdnest` CLI script — `MDNEST_CLI_VERSION="3.X.Y"`
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

## Testing

**Tiered, fully-local test strategy — no CI/remote needed.** All of it runs on the
host via Docker; the pre-push hook (`.githooks/pre-push`) wires it into the
release flow so nothing broken reaches `main`. Fast checks run on every push; the
heavier end-to-end suites run only when pushing toward `main` (a `release/*` or
`main` ref — detected from the refs git feeds the hook on stdin). Emergency
override: `MDNEST_SKIP_E2E=1`.

- **Fast tier (every push):**
  - `tests/cli-unit.sh` — instant pure-function checks of the CLI helpers
    (`urlencode`/`urldecode`/`json_top_string`), run **twice**: with `python3`
    and with `python3`/`jq` force-disabled. This is the cheap guard for the
    class of bug where the CLI silently breaks on a machine without `python3`.
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
