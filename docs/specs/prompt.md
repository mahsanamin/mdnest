Do not ask any clarifying questions. Make all decisions yourself based on best practices. If something is ambiguous, pick the most reasonable default and proceed. Implement everything end to end, then verify it works.

I want to build an open source self-hosted note-taking app called mdnest. It is a personal second brain — clean, minimal, no plugins, no bloat. Built to be self-hosted via Docker, data stored as plain markdown files, automatically backed up to GitHub.

Monorepo structure:
mdnest/
  backend/        ← Go
  frontend/       ← React + Vite
  docker-compose.yml
  .env.example
  README.md

---

Backend (Go)

- REST API
- Single user auth: username + password from .env, returns a JWT, all routes protected
- Notes are plain .md files on disk inside a configurable NOTES_DIR
- Folder structure on disk = folder structure in the app (no database, no abstraction)
- APIs needed:
  - POST /auth/login — returns JWT
  - GET /tree — returns full folder/file tree of NOTES_DIR
  - GET /note?path= — returns raw markdown content of a file
  - PUT /note?path= — saves markdown content to file (creates file + dirs if needed)
  - POST /note?path= — creates a new .md file at the given path
  - DELETE /note?path= — deletes a file
  - POST /folder?path= — creates a new folder
  - POST /upload?path= — accepts image upload, saves to same folder as the note, returns relative path to embed
- All file operations must be sandboxed inside NOTES_DIR — no path traversal
- CORS configured for frontend origin from .env

---

Frontend (React + Vite)

- Clean minimal UI, dark mode by default
- Left sidebar: folder/file tree, collapsible folders, click to open note
- Toolbar: New Note button, New Folder button
- Main area: split view — markdown editor on left, live preview on right
- Editor: plain textarea with tab support, no heavy editor library
- Preview must render:
  - Standard markdown
  - Mermaid diagrams (use mermaid npm package)
  - Images (relative paths resolved against the note's folder)
  - Task checkboxes: - [ ] and - [x] rendered as real checkboxes (clicking them toggles and saves)
- Image upload: drag and drop or paste into editor → uploads via /upload API → inserts markdown image syntax at cursor
- Auth: login screen with username + password → stores JWT in localStorage → attaches to all API requests
- On 401, redirect to login

---

Docker Compose

Three services:

1. backend — Go binary, mounts NOTES_DIR
2. frontend — Nginx serving the Vite build, proxies /api to backend
3. git-sync — alpine/git sidecar, runs inside NOTES_DIR, auto-commits and pushes every 10 minutes with timestamp commit messages, mounts ~/.ssh read-only for GitHub SSH access

Bind all ports to 127.0.0.1 by default — nothing exposed to the network. How to access remotely is the user's choice.

---

.env.example

MDNEST_USER=ahsan
MDNEST_PASSWORD=changeme
MDNEST_JWT_SECRET=changeme
NOTES_DIR=./notes
FRONTEND_ORIGIN=http://localhost:5173
GIT_REMOTE=git@github.com:youruser/my-brain.git
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com

---

README

Write a clean README covering:
- What mdnest is and the philosophy (plain files, own your data, git as backup)
- Quick start: clone, copy .env.example to .env, fill in values, docker compose up
- How to set up GitHub SSH key so git-sync can push
- How to initialize the notes repo: git init inside NOTES_DIR, set remote, first push
- Remote access & HTTPS — document three options, user picks one:
  - Tailscale Serve — simplest, automatic HTTPS, no open ports
  - Nginx + Certbot — traditional reverse proxy with SSL cert
  - Cloudflare Tunnel — no open ports, works behind NAT
- All environment variables explained

---

Requirements:
- No hardcoded values anywhere — everything from .env
- No database — files are the source of truth
- Must work on macOS and Linux
- Go backend compiles to a single binary
- Frontend build is fully static (no SSR)
- Keep v1 clean — no search, no plugins, no multi-user, no sharing. Just notes, folders, images, tasks, mermaid, git backup.
- This will be open sourced — code must be clean, well structured, and easy for others to understand and contribute to (MIT license)

---

After implementation, verify the full stack works:
- Run docker compose up --build -d
- Hit POST /auth/login with test credentials and confirm you get a JWT back
- Hit GET /tree with the JWT and confirm it returns a tree
- Confirm the frontend is reachable at http://127.0.0.1:80
- Print a final summary of what was built and any manual steps remaining
