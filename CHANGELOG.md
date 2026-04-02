# Changelog

All notable changes to mdnest are documented here.

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
