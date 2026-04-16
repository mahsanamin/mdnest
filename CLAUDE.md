# mdnest - AI Context

Privately-hosted Markdown notes app. Plain files on disk, Docker-based. Supports single-user (no database) and multi-user (PostgreSQL) modes.

## Quick Orientation

- **Backend**: Go (net/http + golang-jwt + lib/pq), lives in `backend/`
- **Frontend**: React + Vite + Milkdown (live editor), lives in `frontend/`
- **Docker**: multi-stage builds, nginx proxy, optional git-sync sidecar
- **MCP Server**: Node.js, lives in `mcp-server/` — wraps REST API for AI assistants
- **Config**: `mdnest.conf` -> `setup.sh` generates `docker-compose.yml` and `.env`

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
    upload.go                # POST /api/folder, /api/upload, GET /api/files/
    move.go                  # POST /api/move?ns=&from=&to=
    path.go                  # SafePath(), RequireNamespace() — shared utils
  middleware/
    auth.go                  # JWT validation middleware
    cors.go                  # CORS middleware
  store/
    db.go                    # Postgres connection pool (multi mode only)
    migrate.go               # Auto-migration: schema_migrations, users, access_grants

frontend/
  src/
    App.jsx                  # Root: auth, namespace/tree state, context menu, URL routing
    api.js                   # All API calls (fetch wrapper with JWT + 401 handling)
    mermaid-config.js         # Shared mermaid init, theme, and fixMermaidTextColors()
    components/
      Login.jsx              # Auth form
      Sidebar.jsx            # Namespace picker, tree area, expand/collapse
      TreeNode.jsx           # Recursive tree node (drag-drop, context menu, long-press)
      Toolbar.jsx            # Top bar: hamburger, +Note, +Folder, path display
      Editor.jsx             # Basic mode: textarea with tab/paste/drop support
      EditorToolbar.jsx      # Markdown formatting buttons (basic mode)
      LiveEditor.jsx         # Live mode: Milkdown rich editor with inline rendering
      MermaidBlock.jsx       # Inline mermaid with Source/Preview toggle + click-to-edit labels
      Preview.jsx            # Rendered markdown (marked + mermaid)
      ContextMenu.jsx        # Right-click / long-press floating menu

mcp-server/
  index.js                   # MCP server entry — tools + resources wrapping REST API
  package.json

mdnest                       # Client CLI (login, note read/write/append, works from any machine)
mdnest-server                # Server management CLI (start, stop, rebuild, runs from project dir)
setup.sh                     # Reads mdnest.conf, generates docker-compose.yml + .env
mdnest.conf.sample           # Template config with MOUNT_ entries
```

## Key Conventions

### Backend (Go)
- Standard library only, no web framework — just net/http with ServeMux
- External dependencies: golang-jwt/jwt/v5, lib/pq (Postgres driver), golang.org/x/crypto (bcrypt)
- Two auth modes: `AUTH_MODE=single` (file-based, no DB) or `AUTH_MODE=multi` (Postgres)
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
- marked v15: use plain renderer object (NOT `new marked.Renderer()`), method signature is `({ text, lang })` for code blocks
- Mermaid: rendered post-DOM-insert by querying `.mermaid-source` divs
- Two editor modes: Basic (textarea, Editor.jsx) and Live (Milkdown, LiveEditor.jsx)
- Live editor: lazy-loaded via React.lazy(), only downloads when user switches to Live mode
- Milkdown: ProseMirror-based, markdown-native. Uses commonmark + GFM presets
- Milkdown useEditor creates listeners ONCE — callbacks captured in closure are stale. Use refs (e.g. `onChangeRef`) for any prop that changes over time.
- Mermaid in Live mode: ProseMirror $view node view renders MermaidBlock.jsx in-place
- Both editors share the same onChange/content props — App.jsx doesn't know which is active

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

- Every release branch (`release/v3.X.Y`) MUST bump version as the first commit. Three files:
  - `backend/handlers/config.go` — `"version": "3.X.Y"`
  - `frontend/package.json` — `"version": "3.X.Y"`
  - `mdnest` CLI script — `MDNEST_CLI_VERSION="3.X.Y"`
- Update `CHANGELOG.md` with the new version section
- Merge to `main`, tag as `v3.X.Y`, push with `--tags`
- Run `/mdnest-ship` skill after code changes to update docs, website, and test instance
- Pre-push hook (`.githooks/pre-push`) verifies builds, security, lock files, version consistency
- New developers run `./mdnest-server dev-setup` to activate hooks

## Debugging Practice

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

## Documentation

See `docs/` for:
- `api.md` — Full API reference with curl examples
- `user-guide.md` — End-user guide
- `setup.md` — Setup and configuration
- `architecture.md` — Architecture overview
