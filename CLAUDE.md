# mdnest - AI Context

Self-hosted markdown notes app. Plain files on disk, no database, Docker-based.

## Quick Orientation

- **Backend**: Go (net/http + golang-jwt), lives in `backend/`
- **Frontend**: React + Vite, lives in `frontend/`
- **Docker**: multi-stage builds, nginx proxy, optional git-sync sidecar
- **Config**: `mdnest.conf` -> `setup.sh` generates `docker-compose.yml` and `.env`

## Project Structure

```
backend/
  main.go                    # Entry point, route registration
  handlers/
    auth.go                  # POST /api/auth/login (JWT)
    namespaces.go            # GET /api/namespaces (lists mounted dirs)
    tree.go                  # GET /api/tree?ns= (recursive dir listing)
    notes.go                 # GET/POST/PUT/DELETE /api/note?ns=&path=
    upload.go                # POST /api/folder, /api/upload, GET /api/files/
    move.go                  # POST /api/move?ns=&from=&to=
    path.go                  # SafePath(), RequireNamespace() — shared utils
  middleware/
    auth.go                  # JWT validation middleware
    cors.go                  # CORS middleware

frontend/
  src/
    App.jsx                  # Root: auth, namespace/tree state, context menu, URL routing
    api.js                   # All API calls (fetch wrapper with JWT + 401 handling)
    components/
      Login.jsx              # Auth form
      Sidebar.jsx            # Namespace picker, tree area, expand/collapse
      TreeNode.jsx           # Recursive tree node (drag-drop, context menu, long-press)
      Toolbar.jsx            # Top bar: hamburger, +Note, +Folder, path display
      Editor.jsx             # Textarea with tab/paste/drop support
      EditorToolbar.jsx      # Markdown formatting buttons
      Preview.jsx            # Rendered markdown (marked + mermaid)
      ContextMenu.jsx        # Right-click / long-press floating menu

setup.sh                     # Reads mdnest.conf, generates docker-compose.yml + .env
mdnest.conf.sample           # Template config with MOUNT_ entries
```

## Key Conventions

### Backend (Go)
- Standard library only, no web framework — just net/http with ServeMux
- Only external dependency: golang-jwt/jwt/v5
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

### Namespace Model
- Namespaces are NOT created at runtime — they are host directories mounted via Docker volumes
- Configured in `mdnest.conf` as `MOUNT_<name>=<host_path>`
- `setup.sh` generates docker-compose.yml volume mounts from these
- Backend sees them as subdirectories under NOTES_DIR
- GET /api/namespaces lists them (reads top-level dirs)

### Docker
- Backend: golang:1.23-alpine build, alpine runtime
- Frontend: node:20-alpine build, nginx:alpine serve
- Nginx proxies /api/ to backend service
- SPA fallback: try_files -> /index.html
- git-sync: optional (--profile sync), alpine/git with cron-style loop

## What NOT to Do

- Do not add a database — files are the source of truth
- Do not add runtime namespace/workspace creation — namespaces come from mounts
- Do not use `new marked.Renderer()` — use plain object for marked v15
- Do not hardcode paths or credentials — everything from env/config
- Do not add SSR — frontend is fully static
- Do not add heavy editor libraries (CodeMirror, Monaco) — plain textarea
- Do not add plugins/extensions system — keep v1 clean

## Documentation

See `docs/` for:
- `api.md` — Full API reference with curl examples
- `user-guide.md` — End-user guide
- `setup.md` — Setup and configuration
- `architecture.md` — Architecture overview
