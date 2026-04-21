# Changelog

All notable changes to mdnest are documented here.

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
- **Multi-user only for v1** — comments require `AUTH_MODE=multi` so each message has a real author identity.

### Fixes
- **Floating Comment popup at wrong positions** — suppressed when the triggering mouseup/keyup comes from outside the editor (e.g. clicking Go To in the sidebar no longer resurrects the popup).

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
