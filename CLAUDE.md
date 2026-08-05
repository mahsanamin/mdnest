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
| Handle a **GitHub issue** someone filed — "take care of issue 87", "here's the issue \<url\>", "someone reported X, deal with it" | **`md-issue-process`** | The whole arc for one issue: read it (including the screenshot — one report is often two bugs), split it into symptoms, decide which are even ours, reproduce the *mechanism* without owning the reporter's machine (PATH shims, containers), fix each per `md-fix-bugs`, add the test that would have caught it, release via `md-ship`, then reply to the reporter (owner's go-ahead first — it's public and under his name), close, and record the lessons in the brain. |
| Review PR(s) from an outside contributor — "what should we merge?", "check this PR", "is this safe?" | **`md-review-collab`** | Three gates in order: **legit** (does it do what it claims — verify by running, don't read), **safe** (no weakened path/permission check, no exploit), **direction** (doesn't trade away git-as-storage, mount-defined namespaces, or the lean core). Then merge order (simulate conflicts first), a review that only says what must be said, and merge into `develop` with owner sign-off on anything touching direction. |

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
    upload.go                # POST /api/folder, /api/upload, GET /api/files/ (ns comes from the URL path, so the read check is IN the handler, not middleware)
    upload_test.go           # First Go test in the repo (v3.11.7+) — pins the /api/files/ cross-namespace authz check
    move.go                  # POST /api/move?ns=&from=&to=
    path.go                  # SafePath(), RequireNamespace() — shared utils
    noteid.go                # ExtractNoteID / InjectNoteID / EnsureNoteID (UUID marker)
    comments.go              # GET/POST/PATCH/DELETE /api/comments?ns=&path=&id=
    history.go               # GET /api/note/history, /api/note/at — git-sync version history (v3.7.0+)
    sso.go                   # GET /api/auth/sso/{start,callback} (USER_PROVIDER=sso only)
    tasks.go                 # GET/POST/PATCH /api/tasks, /api/board — task board (v4.0.0+, ENABLE_TASK_BOARD)
    workspaces.go            # /api/admin/workspaces, /api/me/workspace — per-workspace git remotes (v4.0.0+, multi mode)
  firebase/                  # Firebase Auth + Firestore (USER_PROVIDER=firebase only)
    client.go                # Admin SDK wrapper (VerifyIDToken)
    totp_store.go            # Firestore-backed store.TOTPStore impl
  secrets/                   # AES-256-GCM sealing for git credentials at rest (v4.0.0+)
    secrets.go               # DeriveKey/Encrypt/Decrypt — same construction as the MCP OAuth sealing
  storage/                   # Pluggable note persistence behind STORAGE_BACKEND (v4.0.0+)
    storage.go               # Storage interface — namespace-scoped, backend-agnostic
    local.go                 # Default filesystem backend; owns the symlink-containment check
    git.go                   # STORAGE_BACKEND=git — in-process git history, idle-debounced commits
    gitremote.go             # Per-namespace remote resolution + push plan (askpass / GIT_SSH_COMMAND)
    queued.go                # MDNEST_ROLE=app — writes go to the working set + durability queue
    writer.go                # MDNEST_ROLE=writer — drains the queue, owns the git tree
    workingset.go            # Redis-backed coherence tier (the shared read path)
    leader.go                # Writer leader election
    factory.go               # FromEnv — local (default) | git [+ REDIS_URL -> coherent]
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
    sanitize.js              # DOMPurify wrappers (v3.11.7+): sanitizeHtml for marked output + release notes, sanitizeSvg for mermaid. sanitizeSvg MUST keep ADD_TAGS:['foreignObject'] or every flowchart label renders blank.
    __tests__/sanitize.test.js # Pins both directions — labels survive, payloads don't
    echo-gate.js             # v4.1.1+ — pure module (no React): suppresses the file-changed echo of a tab's own save. In-flight-save window + epoch token: broadcasts arriving before the PUT response resolves are deferred and re-checked once the save settles; reset() on note switch invalidates the window. Closes the self-conflict-banner race (issue #82).
    __tests__/echo-gate.test.js # Pins the echo-beats-response race, late echoes, note-switch epochs
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
      TaskBoard.jsx          # Kanban board over note checkboxes (v4.0.0+); lazy-loaded
      TaskEditor.jsx         # Rich task create/edit form used by the board
      BoardColumnsEditor.jsx # Per-namespace column layout (.mdnest/board.json)
      MoveToModal.jsx        # Touch-friendly destination picker for "Move to…" context action (v3.8.0+)
      EditorErrorBoundary.jsx # React error boundary around Live editor — catches Milkdown crashes and flips to Basic (v3.8.0+)

mcp-server/
  index.js                   # MCP server entry — tools + resources wrapping REST API
  package.json

deploy/
  helm/mdnest/               # Optional Helm chart (v3.11.7+) — inert unless used; Compose path unchanged
    Chart.yaml               # appVersion tracks the release — the FOURTH version-bump file
    values.yaml              # Every knob; three options are gated off (see _helpers.tpl)
    templates/_helpers.tpl   # mdnest.validateSupported (rejects unimplemented options) + mdnest.validateHA
    templates/               # backend/frontend/gitsync/mcp Deployments, Services, PVCs, Ingress, HPA, PDB
    files/sync.sh            # git-sync loop for the chart's sidecar (chart-local; Compose has its own)
    README.md(.gotmpl)       # helm-docs generated reference — edit the .gotmpl, patch both

.github/workflows/
  security-audit.yml         # npm audit + govulncheck + shellcheck. REQUIRED checks on main; also runs on PRs into develop
  ci.yml                     # (v3.11.7+) go build/vet/test -race, frontend build+test, helm lint/render/kubeconform, image builds
  release.yml                # (v3.11.7+) on v* tags: push images + chart to ghcr.io/<owner>/

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
- **Sanitization (v3.11.7+, `sanitize.js`): every path that puts rendered markup into the DOM goes through it.** `innerHTML` / `dangerouslySetInnerHTML` with `marked()` output, GitHub release notes, or mermaid SVG must call `sanitizeHtml` / `sanitizeSvg` — note bodies are user-authored and shared between users, and marked passes raw HTML through by design. If you add a new render target, route it through the same module rather than sanitizing inline. Two traps, both load-bearing: `sanitizeSvg` needs `ADD_TAGS: ['foreignObject']` because mermaid puts flowchart labels inside one and DOMPurify's svg profile excludes it (without it, diagrams render as blank shapes — nothing throws); and do **not** additionally allow `div`/`span`, because once allowed they fail DOMPurify's namespace check instead of being unwrapped and the labels vanish again. `sanitizeHtml` deliberately keeps `class`, `data-*`, and task checkboxes — the Preview's post-passes depend on them.
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

### Client CLI (`mdnest`, bash)
- Runs under `set -e` — a helper used as a bare statement must `return 0` on its success path or it aborts the script. (This also leaks into anything that *sources* the CLI: `tests/cli-unit.sh` does `set +e` right after the `MDNEST_LIB=1 source` for exactly this reason.)
- **Every python3 call goes through `py()`** (v4.1.2+), never `python3` directly. It passes `-S` (skip site initialisation, so a user's broken site-packages/`.pth` can't print a traceback into our output — issue #87) and `-E` (ignore `PYTHON*` env), drops python's stderr, and returns its exit status. **Gate on the result, not on presence:** `have python3` passing does not mean python3 *works*, so every call site must fall through to its pure-bash/awk tier when `py` fails. A present-but-broken interpreter is the failure mode that bit us, not a missing one.
- Dependency tiers, in order: python3 (`py`) → jq → pure bash/awk. The awk tier is not a token gesture; it is the tier that runs on a fresh machine, and `tests/e2e-docker.sh` proves it in a bare alpine container with neither python3 nor jq.
- **Human-facing output is rendered in awk only** — `format_tree` / `format_namespaces` for `mdnest list` have deliberately no python3/jq tier, so a listing is byte-identical on every machine and a broken python can't garble it. Verified on gawk, mawk and busybox awk. Raw API JSON stays available behind `--json` / `MDNEST_JSON=1` for scripts; don't make raw JSON the default output of a command again.
- Adding a command means three edits: the `case` dispatch, the help **Commands** list, and the help **Examples** block (`grep -c '<cmd>' mdnest` ≥ 3).
- `mdnest update` self-updates from `raw.githubusercontent.com/.../main` — so a CLI fix reaches users when it lands on `main`, independent of the tag/Release (those drive the in-app *server* update banner). Corollary: the CLI installed on this machine lags `develop`, so test with `./mdnest`, not `mdnest`.

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
- `security.md` — Threat model and the five defense layers (layer 5, rendered-content sanitization, is v3.11.7+)
- `cli.md` — `mdnest` client CLI
- `kubernetes.md` — Optional Helm chart (v3.11.7+); says which options are gated off and why
- `sso-setup.md` / `firebase-setup.md` — Identity-provider setup
