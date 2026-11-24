# Setup and Configuration

This guide is the reference: every way to install mdnest and every setting. For the shortest path to a running server with your agent connected, see the [Quick Start](https://mdnest.dev/docs/quick-start).

> Running mdnest in an existing Kubernetes cluster instead — including active/active with the git-native HA topology — is covered in [kubernetes.md](kubernetes.md). This guide is the Docker Compose install.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (version 20.10 or later)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2, included with Docker Desktop).
  The guided setup needs **Compose 2.17 or newer** from 4.8.5 on: it builds the
  frontend image with a second build context (`additional_contexts`) so the
  image can serve the `mdnest` CLI at `/cli/mdnest`. `setup.sh` checks the
  version and stops with a message naming it if Compose is older. Check yours
  with `docker compose version`. The plain Compose install only pulls images
  and has no such requirement.
- Git — only for the [guided setup](#guided-setup); the plain Compose install needs none

There are two ways to install. They run the same images and give you the same
mdnest.

| | [Plain Docker Compose](#plain-docker-compose-or-docker-run) | [Guided setup](#guided-setup) |
|---|---|---|
| You get | one `docker-compose.yml` you own and edit | a script that writes the compose file from `mdnest.conf` |
| Images | pulled from `ghcr.io`, nothing to build | built from source on your machine |
| Good for | people who run their own proxy, TLS and networks | a one-command install with git sync, HTTPS and multi-user wired for you |

---

## Plain Docker Compose (or docker run)

No clone, no setup script, nothing to build. Follow the
[basic setup in the Quick Start](https://mdnest.dev/docs/quick-start#1-basic-setup): it downloads
`docker-compose.yml`, writes two secrets to `.env`, and runs
`docker compose up -d`.

Open `http://localhost:3236` and sign in as `admin` with the password from
`.env` (`cat .env`). If you forget a secret, `docker compose up` refuses to
start and names the variable, so a half-configured mdnest never runs.

**What is running:** two containers, `backend` (the API) and `frontend` (nginx
serving the web app and proxying `/api/` to the backend). Only the frontend has
a port. Your notes are plain `.md` files in `./notes` on the host. The
`mdnest-secrets` volume holds API tokens, preferences and stickies. It isn't
notes, but it is state you'd miss.

The file is short and every optional setting is a comment in it:
[`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml).
The usual changes:

| I want to… | Change this in `docker-compose.yml` |
|---|---|
| add a second notes folder | another line under `backend.volumes`: `- /srv/work:/data/notes/work` (each mount is one namespace in the sidebar) |
| reach it from other machines | `ports: ["3236:80"]` instead of `127.0.0.1:3236:80` |
| use my own reverse proxy | delete `ports`, attach `frontend` to your proxy's network, point the proxy at `frontend:80`, and set `FRONTEND_ORIGIN` to your public URL (the block at the end of the file shows the lines) |
| turn on the task board, drawings or slides | uncomment `ENABLE_TASK_BOARD`, `ENABLE_EXCALIDRAW` or `ENABLE_MARP` |
| accounts for a team | uncomment the multi-user block at the end of the file (adds Postgres) |
| pin a version | replace `:latest` with a release, e.g. `:4.5.3`, on **both** images |

Point your proxy at the **frontend**, never the backend. The frontend already
routes `/api/` and the `/api/ws` websocket.

**Upgrade:** `docker compose pull && docker compose up -d`. Your notes and
settings stay where they are.

**The same thing with `docker run`.** The frontend finds the backend by the
name `backend`, so both containers need a shared network, and the backend
must be named `backend` on it:

```bash
docker network create mdnest
docker volume create mdnest-secrets

docker run -d --name backend --network mdnest --restart unless-stopped \
  -e MDNEST_USER=admin \
  -e MDNEST_PASSWORD='pick-a-strong-password' \
  -e MDNEST_JWT_SECRET="$(openssl rand -hex 32)" \
  -e NOTES_DIR=/data/notes -e SECRETS_DIR=/data/secrets \
  -e FRONTEND_ORIGIN=http://localhost:3236 \
  -e SERVER_ALIAS=mdnest \
  -v "$PWD/notes:/data/notes/notes" \
  -v mdnest-secrets:/data/secrets \
  ghcr.io/mahsanamin/mdnest-backend:latest

docker run -d --name mdnest-frontend --network mdnest --restart unless-stopped \
  -p 127.0.0.1:3236:80 \
  ghcr.io/mahsanamin/mdnest-frontend:latest
```

Every setting in the rest of this guide is an environment variable on the
backend container, with the same name as in `mdnest.conf`. Only these keys
are specific to the guided setup and don't apply here: `MOUNT_*` (use
volumes), `BACKEND_PORT`, `FRONTEND_PORT` and `BIND_ADDRESS` (use `ports`),
`SSH_KEY_PATH` and `GIT_SYNC_INTERVAL` (the git-sync sidecar),
`CADDY_DOMAIN`, `COMPOSE_PROJECT_NAME`, and `ENABLE_MCP` / `MCP_*` (those
configure the separate MCP server container, see [mcp.md](mcp.md)). The
Firebase settings `FIREBASE_SERVICE_ACCOUNT` and `FIREBASE_WEB_CONFIG` are
file paths, so mount the files into the backend and give the path *inside*
the container.

---

### If mdnest says it has no namespaces

Each namespace is a folder mounted into the **backend** container at
`/data/notes/<name>`. When the sidebar is empty, the page says which of these
it is, and `docker compose logs backend` lists the namespaces it found at
startup:

| What you see | Cause | Fix |
|---|---|---|
| "No namespaces found" | nothing is mounted at `/data/notes/<name>` in the backend | put the volume under the **backend** service (not the frontend), e.g. `- ./notes:/data/notes/notes`, and recreate it |
| "No namespaces found", but the folder exists | Docker cannot see the host folder, so it mounts an empty one | on Docker Desktop add the folder under Settings > Resources > File sharing; on an SELinux host (Fedora, RHEL) add `:z` |
| "Your notes are mounted one level too high" | the folder is mounted at `/data/notes` itself, so its files are in no namespace | mount it one level down: `- ./notes:/data/notes/notes` |
| "The notes folder cannot be read" | permissions, or SELinux without `:z` | fix the host permissions, or add `:z` to the volume |
| "No namespaces you can open yet" | multi-user mode: your account has no grant (admins get none automatically) | an admin can click **Give me access to all namespaces** on that page, or choose namespaces in **Manage users & access** |

For a mount problem the page also shows the lines to paste, and a **Check
again** button that re-reads the list once you have fixed it, so there is no
need to reload. Apply a mount change with `docker compose up -d`:
`docker compose restart`, and **Settings > Server > Restart server**, keep the
container's old mounts.

## Guided setup

```bash
# 1. Clone the repository
git clone https://github.com/mahsanamin/mdnest.git
cd mdnest

# 2. Run setup (creates mdnest.conf from the sample on first run)
./mdnest-server setup

# 3. Edit mdnest.conf with your settings
#    - Set your username and password
#    - Add MOUNT_ entries for your note directories
#    - Optionally configure git sync

# 4. Generate config and start
./mdnest-server rebuild
```

Open `http://localhost:3236` in your browser and log in with the credentials you configured.

---

## Configuration File: mdnest.conf

The `mdnest.conf` file is the single source of configuration. The `setup.sh` script reads it and generates both `.env` and `docker-compose.yml`.

On first run, `setup.sh` copies `mdnest.conf.sample` to `mdnest.conf` and exits, prompting you to edit it.

### All Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `MDNEST_USER` | `admin` | Username for the login screen |
| `MDNEST_PASSWORD` | `changeme` | Password for the login screen. Change this. |
| `MDNEST_JWT_SECRET` | `changeme` | Secret key used to sign JWT tokens. Use a long random string. |
| `FRONTEND_ORIGIN` | `http://localhost:<FRONTEND_PORT>` | The full URL people open mdnest at. Used for CORS, the SSO return address, and, with script mode (`PAGES_ORIGIN`), the only address allowed to show HTML pages. Behind a custom domain or reverse proxy, set it to that public URL. |
| `BACKEND_PORT` | `8286` | Host port mapped to the backend container (port 8080 internally) |
| `FRONTEND_PORT` | `3236` | Host port mapped to the frontend container (port 80 internally) |
| `BIND_ADDRESS` | `127.0.0.1` | Host IP(s) to bind the published ports to. To reach mdnest over Tailscale, a VPN or the LAN, keep `127.0.0.1` and put a reverse proxy in front (Caddy, nginx, or `tailscale serve`). A comma-separated list (e.g. `127.0.0.1,100.73.118.115`) also works, but Docker only publishes a port if that IP exists when the container starts, so an address that comes up after Docker (a reboot, a Docker restart) leaves mdnest running with no port published, or, if the address is missing at the moment Docker starts the container, not started at all (Docker does not retry it). `setup.sh` warns about such an address, and `./mdnest-server status` reports both cases. |
| `GIT_AUTHOR_NAME` | *(none)* | Name used for git commits when git-sync is enabled |
| `GIT_AUTHOR_EMAIL` | *(none)* | Email used for git commits when git-sync is enabled |
| `AUTH_MODE` | `single` | Auth mode: `single` (file-based, no DB) or `multi` (Postgres-backed users & permissions) |
| `POSTGRES_HOST` | `postgres` | PostgreSQL host (only when `AUTH_MODE=multi`). Use `postgres` for the built-in container. |
| `POSTGRES_PORT` | `5432` | PostgreSQL port (only when `AUTH_MODE=multi`) |
| `POSTGRES_DB` | `mdnest` | PostgreSQL database name (only when `AUTH_MODE=multi`) |
| `POSTGRES_USER` | `mdnest` | PostgreSQL user (only when `AUTH_MODE=multi`) |
| `POSTGRES_PASSWORD` | *(none, required when multi)* | PostgreSQL password (only when `AUTH_MODE=multi`) |
| `USER_PROVIDER` | `local` | Identity provider when `AUTH_MODE=multi`: `local` (username/password + Postgres TOTP), `firebase` (see `docs/firebase-setup.md`), or `sso` (generic OIDC — see `docs/sso-setup.md`). |
| `SSO_ISSUER_URL` | *(required when `USER_PROVIDER=sso`)* | OIDC issuer URL, e.g. `https://accounts.google.com`, `https://<org>.okta.com`. |
| `SSO_CLIENT_ID` | *(required when `USER_PROVIDER=sso`)* | OAuth client ID from your IdP. |
| `SSO_CLIENT_SECRET` | *(required when `USER_PROVIDER=sso`)* | OAuth client secret from your IdP. |
| `SSO_REDIRECT_URL` | `<FRONTEND_ORIGIN>/api/auth/sso/callback` | Override if your callback URL doesn't match the default. |
| `SSO_ALLOWED_DOMAINS` | *(none)* | Comma-separated email-domain allowlist, e.g. `example.com`. Leave empty to allow any verified email. For Google, a set allowlist also requires the account to be in a Workspace (an `hd` claim), except for `gmail.com` addresses — see `docs/sso-setup.md`. |
| `SSO_PROVIDER_LABEL` | `SSO` | Text on the sign-in button (e.g. `Google`, `Okta`). |
| `SSO_AUTOPROVISION_USERS` | `false` | Opt-in. Create a least-privilege collaborator for an unknown but IdP-authenticated email on first sign-in, instead of rejecting it. Enable only when the IdP gates who can get a token; pair with `SSO_ALLOWED_DOMAINS`. |
| `SSO_DISABLE_PASSWORD_LOGIN` | `false` | Opt-in. Refuse username/password on `/api/auth/login`, so the IdP is the only way in. Recommended when mdnest is reachable from the internet. SSO sign-in and API tokens keep working; an MCP server must then use `MDNEST_TOKEN`, not `MDNEST_USER`/`MDNEST_PASSWORD`. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_WEB_CONFIG` | *(required when `USER_PROVIDER=firebase`)* | See `docs/firebase-setup.md`. |
| `ADMIN_EMAILS` | *(none)* | Comma-separated emails auto-promoted to `role=superadmin` on every startup (idempotent — removals are NOT auto-demoted). |
| `REQUIRE_2FA` | `false` | Force TOTP enrollment on next login for all users (local + Firebase only — ignored in SSO mode). |
| `ENABLE_LIVE_COLLAB` | `false` | Enable WebSocket-based live collaboration: presence, cursors, comments, real-time tree updates. Multi mode only. |
| `SHARED_EDITING` *(v4.8.10+)* | `true` | With live collaboration on, people in the same markdown note edit one shared copy (Yjs) and one browser saves it, so nobody's typing is lost. **Single backend only**: always off on `MDNEST_ROLE=app`. `false` keeps whole-file saves. Rejected at setup time if not `true`/`false`. See [collab.md](collab.md). |
| `DEFAULT_THEME` *(v4.3.0+)* | `auto` | Theme for users who have not chosen one: `auto` follows the viewer's operating system setting, `dark` and `light` pin it. A per-user choice is stored server-side and always overrides this, so changing it later only affects people who have never picked. Rejected at setup time if it is not one of the three values. |
| `ENABLE_TASK_BOARD` *(v4.0.0+)* | `false` | Enable the kanban task board over note checkboxes, including task relations, filters and the cross-workspace "All workspaces" scope. Routes are not registered and the UI chunk is not loaded when off. |
| `ENABLE_MARP` *(v4.1.0+)* | `false` | Render a note whose frontmatter declares `marp: true` as a slide deck in the Preview pane. The Marp engine chunk only downloads for a deck. |
| `ENABLE_MARP_THEMES` *(v4.2.0+)* | `false` | Requires `ENABLE_MARP`. Adds a shared theme catalog decks reference by name (`theme: <name>`) plus a superadmin **Marp Themes** admin tab. Themes live in the reserved `.marp-themes` namespace; `setup.sh` backs it with the `mdnest-marp-themes` named volume so a rebuild doesn't wipe them, and the Helm chart already mounts all of `/data/notes`. |
| `ENABLE_AGENT_APPROVALS` *(v4.8.5+, experimental)* | `false` | Answer an agent's (Claude Code or Codex) permission prompt from mdnest: the question shows as a card, you press Allow or Deny in the browser, and the agent continues. Each machine also has to opt in, see `docs/chat.md`. Decisions are accepted only from a browser login. Requests live in memory and are not available on `MDNEST_ROLE=app`. Read the added risk in `docs/security.md` before turning it on. |
| `ENABLE_EXCALIDRAW` *(v4.2.0+)* | `false` | Open `.excalidraw.md` notes on an Excalidraw canvas and allow read-only drawing embeds in any note. The (large) editor bundle is code-split and only loads when a drawing is opened. See `docs/excalidraw.md`. |
| `EXCALIDRAW_LIBRARIES` *(v4.2.0+)* | *(none)* | Requires `ENABLE_EXCALIDRAW`. Comma-separated URLs to `.excalidrawlib` files, preloaded into every drawing so an organisation can ship a shared shape set. Fetched by the **browser**, not the backend, so the URLs must be reachable by clients (and CORS-enabled). |
| `ENABLE_PAGES` | `false` | Optional. View-only HTML pages (reports, dashboards) published into any folder from the CLI, MCP or a desktop drop; each shows in the tree as a small `<name>.page.md` handle and opens in a viewer. Off by default: no route is registered and the frontend loads no pages code. **Pages are for casual sharing:** their files are kept apart from the notes, so git sync does not save them and they do not move with the notes to another server. Back up `PAGES_DIR` (or the `mdnest-pages` volume) yourself. See [HTML pages](#html-pages-optional). |
| `PAGES_DIR` | *(named volume `mdnest-pages`)* | Requires `ENABLE_PAGES`. Host folder for page files, kept apart from the notes. Not in git: back it up with the notes, and copy it along when you move to another server. Must not be inside a notes folder. |
| `PAGES_MAX_MB` | `20` | Requires `ENABLE_PAGES`. Largest total size of one page, checked when it is published. The web server in front of mdnest takes uploads up to 32 MB, so keep it at 30 or less. |
| `PAGES_MAX_FILES` | `500` | Requires `ENABLE_PAGES`. Most files in one page, and also most folders, checked when it is published. |
| `PAGES_ORIGIN` | *(none: static mode)* | Optional, needs team setup. A second address (another port or hostname) that serves page files and nothing else. With it, page scripts run there in a sandbox; without it, pages show with scripts off. Must differ from `FRONTEND_ORIGIN`. |
| `PAGES_PORT` | *(the port in `PAGES_ORIGIN`)* | Script mode, `setup.sh` only. Host port for the pages listener, when `PAGES_ORIGIN` has no port because your own proxy is in front. |
| `PAGES_NETWORK` | `strict` | Requires `PAGES_ORIGIN`. `strict`: a page loads only its own files. `open`: it may also load outside scripts and call outside sites (https). |
| `OIDC_GROUPS_CLAIM` *(v4.2.0+)* | *(none)* | Requires `USER_PROVIDER=sso`. Name of the ID-token claim holding the user's IdP group IDs (e.g. `groups` on Entra ID). Enables OIDC-group membership in access Groups. Empty disables OIDC-group resolution entirely. **Membership is snapshotted at login** — see `docs/security.md`. In multi mode each SSO login also records the person's IdP groups *(v4.8.15+)*, so the assignee and chat member pickers list the IdP-group members of access groups, for 30 days after that login (or `API_TOKEN_GROUPS_MAX_AGE` when longer). |
| `API_TOKEN_GROUPS_MAX_AGE` *(v4.8.14+)* | `0` | Requires `OIDC_GROUPS_CLAIM` and multi mode. Go duration (e.g. `168h`): API tokens use the IdP groups of their owner's last SSO login for that long after the login, so OIDC-group members of access Groups reach the same notes from the CLI and agents as in the browser. `0` = tokens use direct grants and user memberships only. Group changes reach tokens at the next login or when the age is reached — see `docs/security.md`. |
| `STORAGE_BACKEND` *(v4.0.0+)* | `local` | `local` (filesystem; git history via the optional git-sync sidecar) or `git` (in-process git with idle-debounced commits, which also enables comment-marker recovery across a delete+recreate). Only these two values are accepted; anything else fails at startup. |
| `GRANT_MAX_DEPTH` | `3` | Cap on how deep into a namespace tree a grant's path can go (`/` = depth 0). New grants beyond this depth return 400. Existing rows are grandfathered. Set `0` for no limit. |
| `INSECURE_DEV_LOGIN` | `false` | **Dev-only.** Enables `POST /api/auth/dev-login` which mints a session for any existing user by email — bypassing the IdP. Loud red warning pill renders on every authenticated page while this is on. NEVER enable on a non-localhost deployment. |
| `ENABLE_CHAT` | `true` | Chat rooms stored as notes, for people and AI agents. `false` turns it off: the `/api/chat*` routes are not registered and the browser never loads the chat code. See [chat.md](chat.md). |
| `SEARCH_MAX_RESULTS` | `30` | Most results one search returns. |
| `SEARCH_MAX_FILE_SIZE` | `1048576` | Files larger than this many bytes (1 MB) are skipped by search. |
| `SEARCH_WORKERS` | `8` | How many files search reads at once. Raise it for a large repository (5,000+ notes). |
| `SEARCH_CACHE_TTL` | `30` | Seconds the list of files search looks at is kept before it is read again. |
| `DOWNLOAD_MAX_FILES` | `500` | Most files one folder download (zip) or move/copy between namespaces may hold. A bigger folder is refused up front with the real count. |
| `DOWNLOAD_MAX_MB` | `100` | Most megabytes one folder download or move/copy between namespaces may hold. |
| `DOWNLOAD_MAX_CONCURRENT` | `2` | Zip downloads running at once, for the whole server (one per user). |
| `MCP_TOKEN`, `MCP_HTTP_PORT` | *(none)*, `3000` | Optional MCP server container. `MCP_TOKEN` is the one mdnest API token it uses for every call (service mode); `MCP_HTTP_PORT` is the host port of its `/mcp` endpoint. See [mcp.md](mcp.md). |
| `MCP_AUTH_MODE`, `MCP_PUBLIC_URL`, `MCP_OAUTH_SECRET`, `MCP_SSO_AUTHORIZE_URL`, `MCP_ALLOWED_REDIRECT_ORIGINS` | *(service mode)* | `MCP_AUTH_MODE=oauth` makes each MCP client sign in as its own user through your SSO, instead of sharing one token. Needs the next three; `MCP_ALLOWED_REDIRECT_ORIGINS` lists extra client addresses allowed to finish that sign-in. See [mcp.md](mcp.md). |
| `COMPOSE_PROJECT_NAME` | *(unset = directory basename)* | Override the docker compose project name. Useful when running parallel installs from differently-named (or similarly-named) directories so their containers don't collide. |
| `SSH_KEY_PATH` | *(none)* | Path to SSH private key on the host. Mounted into the backend for git pull via sync button. Must be passphrase-free. |
| `CADDY_DOMAIN` | *(none)* | Domain name for automatic HTTPS via Caddy. When set, adds a Caddy container and makes backend/frontend ports internal-only. Requires a DNS A record pointing to the server. |
| `SERVER_ALIAS` | *(none)* | Short name advertised by `/api/config` so the `mdnest` CLI can auto-pick the right `@alias` on `mdnest login <url> <token>`. |
| `DISABLE_UPDATE_CHECK` *(v3.8.0+)* | `false` | When `true`, the backend stops polling GitHub for newer mdnest releases. The "Update available" badge in the sidebar disappears. Useful for air-gapped or privacy-sensitive installs. |
| `UPDATE_CHECK_REPO` *(v3.8.0+)* | `mahsanamin/mdnest` | Owner/repo to poll for releases. Override if you've forked mdnest and want the badge to track your fork instead of upstream. |
| `MOUNT_<name>` | *(none, at least one required)* | Maps a namespace to a host directory. See below. |

### Example Configuration

```ini
# Auth
MDNEST_USER=ahsan
MDNEST_PASSWORD=a-strong-password-here
MDNEST_JWT_SECRET=another-long-random-string

# Frontend origin (for CORS)
FRONTEND_ORIGIN=http://localhost:3236

# Ports
BACKEND_PORT=8286
FRONTEND_PORT=3236

# Git sync
GIT_AUTHOR_NAME=Ahsan
GIT_AUTHOR_EMAIL=ahsan@example.com

# Namespace mounts
MOUNT_personal=/home/ahsan/notes/personal
MOUNT_work=/home/ahsan/notes/work
```

---

## Namespaces

Namespaces are the top-level organizational unit in mdnest. Each namespace maps to a directory on the host machine.

### How They Work

Every `MOUNT_<name>=<host_path>` entry in `mdnest.conf` creates a namespace. When `setup.sh` runs, it generates Docker volume mounts that map each host path into the container at `/data/notes/<name>`.

The backend scans `/data/notes/` at runtime and exposes each subdirectory as a namespace through the API. The frontend displays them in the namespace selector dropdown.

### Adding a Namespace

1. Create the directory on your host (or point to an existing one):
   ```bash
   mkdir -p /home/ahsan/notes/projects
   ```

2. Use the interactive command (handles everything: config, directory, git, deploy key):
   ```bash
   ./mdnest-server add-namespace
   ```

   It offers to reload for you at the end, which is the whole of step 3.

   Or manually add a `MOUNT_` line to `mdnest.conf`:
   ```
   MOUNT_projects=/home/ahsan/notes/projects
   ```

3. Apply it:
   ```bash
   ./mdnest-server reload
   ```

   **A conf edit alone changes nothing.** Namespaces are Docker volume mounts,
   so the running backend keeps serving the mounts it was created with until the
   containers are recreated — a namespace you have added but not applied is
   simply absent from the UI and the API. `./mdnest-server status` compares
   `mdnest.conf` against what the running container actually serves and tells you
   when the two disagree, in either direction. Use `rebuild` instead of `reload`
   only when you also need the images rebuilt (`reload` is ~10s, `rebuild` ~60s).

### Removing a Namespace

```bash
./mdnest-server remove-namespace
```

Lists all namespaces, asks which to remove, cleans up config and deploy key. Files on disk are NOT deleted.

Or manually: remove the `MOUNT_` line from `mdnest.conf` and run `./mdnest-server reload`. Until you do, the container still has the old mount and keeps serving the namespace — `./mdnest-server status` flags that too.

### Naming Rules

Namespace names (the part after `MOUNT_`) must be simple identifiers:

- No slashes or backslashes
- Must not start with a dot
- Should contain only alphanumeric characters and underscores

---

## Multi-User Mode

By default, mdnest runs in **single-user mode** -- one user, file-based auth, no database needed. This is the simplest setup and works for personal use.

**Multi-user mode** adds PostgreSQL-backed user management with roles and namespace-level access control. When enabled, `setup.sh` automatically adds a Postgres container to `docker-compose.yml`.

### Multi-User Mode with Plain Docker Compose

If you installed with the [plain Docker Compose](#plain-docker-compose-or-docker-run)
file, the multi-user block is already at the end of `docker-compose.yml`,
commented out:

1. Follow that block: add the `AUTH_MODE` and `POSTGRES_*` lines to the
   backend's `environment`, add the `postgres` service, and add
   `mdnest-pgdata:` under `volumes`.
2. Add a database password to `.env`:

   ```bash
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
   ```

3. For comments and presence, also add `ENABLE_LIVE_COLLAB: "true"` to the
   backend's `environment`.
4. Restart with `docker compose up -d`.

The `admin` account (`MDNEST_USER`) becomes the first administrator, and your
notes are not changed. For company sign-in, add the settings from the
[SSO setup guide](sso-setup.md) to the backend's `environment`: each setting in
this guide is an environment variable with the same name. To invite people and
give them access, see [Roles & administration](user-guide.md#roles--administration-multi-user-mode).

The sections below are for the guided setup (`mdnest.conf`).

### Enabling Multi-User Mode (New Install)

Add these lines to `mdnest.conf`:

```ini
AUTH_MODE=multi
POSTGRES_PASSWORD=a-secure-password

# Optional -- defaults are fine for the built-in Postgres container:
# POSTGRES_HOST=postgres
# POSTGRES_PORT=5432
# POSTGRES_DB=mdnest
# POSTGRES_USER=mdnest
```

Then build and start:

```bash
./mdnest-server rebuild
```

On first startup, the backend automatically:
1. Connects to PostgreSQL
2. Creates the `users` and `access_grants` tables
3. Seeds the initial admin user from `MDNEST_USER` / `MDNEST_PASSWORD`

### Upgrading from Single to Multi-User

If you already have a running single-user mdnest and want to enable multi-user:

1. **Edit `mdnest.conf`** -- add the `AUTH_MODE` and `POSTGRES_PASSWORD` lines shown above.

2. **Regenerate config:**
   ```bash
   ./mdnest-server setup
   ```
   This regenerates `docker-compose.yml` with a Postgres service added.

3. **Run migrations:**
   ```bash
   ./mdnest-server migrate
   ```
   This starts Postgres, connects the backend, and creates the database tables.

4. **Rebuild and start:**
   ```bash
   ./mdnest-server rebuild
   ```

Your existing notes and configuration remain untouched. The database only stores user accounts and access permissions -- your notes are still plain files on disk.

### Recommended: Team install with corporate SSO

For a small company deploying mdnest as a shared knowledge base, the recommended config is multi-user mode + corporate SSO + a TLS reverse proxy:

```ini
# Auth
AUTH_MODE=multi
USER_PROVIDER=sso
ENABLE_LIVE_COLLAB=true
GRANT_MAX_DEPTH=3
ADMIN_EMAILS=ops-lead@example.com,you@example.com    # auto-promoted to superadmin

# Postgres
POSTGRES_PASSWORD=<long-random-string>

# OIDC (from your IdP — see docs/sso-setup.md)
SSO_ISSUER_URL=https://accounts.google.com
SSO_CLIENT_ID=<from-IdP>
SSO_CLIENT_SECRET=<from-IdP>
SSO_ALLOWED_DOMAINS=example.com
SSO_PROVIDER_LABEL=Google

# TLS via Caddy (built-in HTTPS)
CADDY_DOMAIN=notes.example.com
FRONTEND_ORIGIN=https://notes.example.com

# JWT secret — use a fresh long random value
MDNEST_JWT_SECRET=<long-random-string>

# Mounts (one per team / topic)
MOUNT_engineering=/srv/notes/engineering
MOUNT_design=/srv/notes/design
MOUNT_ops=/srv/notes/ops
```

```bash
./mdnest-server rebuild
```

What this gets you:

- All identity centralized in your IdP — users sign in with their existing corporate account, MFA enforced where the IdP enforces it.
- One or two SuperAdmins (the `ADMIN_EMAILS` list) who manage the system globally, plus per-team Admins assigned from the **Namespaces** tab in the admin UI. Each per-team Admin can invite their teammates and manage grants on their own namespace without seeing other teams.
- Public TLS via Caddy + Let's Encrypt, with the backend bound only to a Docker-internal network. The reverse proxy is the only thing exposed.
- Live collaboration (cursors, presence, real-time comments) on by default for multi-user installs.
- Per-team git backup if each `MOUNT_*` is a separate git repo with a deploy key in `git-sync/keys/<namespace>` — see [Git Sync](#git-sync) below.

After the first sign-in, your `ADMIN_EMAILS` users are SuperAdmin. From the admin panel they can invite the rest of the team and assign per-namespace Admins.

### Using an External PostgreSQL

If you prefer to use an existing Postgres server instead of the built-in container, set `POSTGRES_HOST` to your server's address:

```ini
AUTH_MODE=multi
POSTGRES_HOST=db.example.com
POSTGRES_PORT=5432
POSTGRES_DB=mdnest
POSTGRES_USER=mdnest
POSTGRES_PASSWORD=your-password
```

When `POSTGRES_HOST` is not `postgres` (the default), `setup.sh` does **not** add a Postgres container to `docker-compose.yml` -- it assumes you are managing the database yourself.

---

## Git Sync

mdnest includes an optional git-sync sidecar container that automatically commits and pushes your notes to a remote git repository every 10 minutes.

### Setting Up Git Sync

**1. Initialize git in each notes directory:**

```bash
cd /home/ahsan/notes/personal
git init
git remote add origin git@github.com:youruser/personal-notes.git
echo "# Personal Notes" > README.md
git add -A && git commit -m "init"
git push -u origin main
```

**2. Set up SSH keys:**

The git-sync container needs **unencrypted** SSH keys. Your regular SSH key likely has a passphrase and is decrypted by macOS Keychain or an SSH agent — neither is available inside the container.

Keys live in `git-sync/keys/`. The sync script resolves keys in this order:

1. **`git-sync/keys/<namespace>`** — a per-namespace key (matches your `MOUNT_<name>`)
2. **`git-sync/keys/default`** — a shared key used for all namespaces that don't have their own
3. **No key found** — commits locally but skips push/pull

**Option A: Single key for all repos** (simplest if you have a machine user or personal key):

```bash
mkdir -p git-sync/keys
# Copy or generate an unencrypted key
ssh-keygen -t ed25519 -f git-sync/keys/default -N "" -C "mdnest-sync"
```

Add the public key to your GitHub account (Settings > SSH Keys) or as a collaborator key.

**Option B: One key per namespace** (required if using GitHub deploy keys, since each must be unique):

```bash
mkdir -p git-sync/keys
ssh-keygen -t ed25519 -f git-sync/keys/work_brain -N "" -C "mdnest-sync"
ssh-keygen -t ed25519 -f git-sync/keys/personal   -N "" -C "mdnest-sync"
```

Add each `.pub` key to the corresponding repo's deploy keys:
- **GitHub**: repo Settings > Deploy Keys > Add deploy key (enable "Allow write access")
- **GitLab**: repo Settings > Repository > Deploy Keys

> **Why not mount `~/.ssh` directly?**
> - Passphrase-protected keys silently fail (no agent to decrypt them).
> - macOS SSH configs use `UseKeychain`, which Alpine's SSH doesn't recognize and treats as a fatal error.

**3. Configure git identity in `mdnest.conf`:**

```
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
```

**4. Rebuild and start:**

```bash
./mdnest-server rebuild
```

Git sync starts automatically when keys are found in `git-sync/keys/`. No keys = no sync — your notes stay local.

### How It Works

The sync loop runs every 600 seconds (10 minutes) per namespace:

1. **Commit** — stages all changes and commits. If the previous unpushed commit is also a sync commit, it squashes into it instead of creating a new one. This keeps history clean when push fails across multiple cycles.
2. **Pull** — pulls from the remote with rebase for linear history.
3. **Push** — pushes to the remote. If push fails, retries next cycle.

### Important: Let mdnest Own the Repo

The git remote should be treated as a **backup destination**, not a shared workspace. Do not push to it from other tools or machines. Since mdnest is the only process committing and pushing, conflicts cannot occur under normal use.

If a conflict does happen (e.g., someone accidentally pushed to the repo directly), git-sync handles it automatically: it saves the local version as a `.sync-conflict-*` file, accepts the remote, and keeps the sync loop running. No data is lost, no manual intervention needed.

---

## Git Pull from the Web UI (Sync Button)

If your namespaces are git repos managed outside mdnest (e.g., pushed from CI or other machines), the admin sync button in the sidebar lets you pull the latest changes without leaving the browser.

For this to work, the backend container needs an SSH key to authenticate with the git remote.

### Option A: Dedicated deploy key (recommended)

Generate a passphrase-free key specifically for mdnest:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/mdnest-deploy -N "" -C "mdnest-sync"
```

Add the public key to your git provider:
- **GitHub**: repo Settings > Deploy Keys > Add deploy key (enable "Allow write access" if you also want git-sync push)
- **GitLab**: repo Settings > Repository > Deploy Keys

Then add to `mdnest.conf`:

```
SSH_KEY_PATH=/home/you/.ssh/mdnest-deploy
```

Rebuild:

```bash
./mdnest-server rebuild
```

The sync button (&#8635; in the sidebar) will now pull from the remote.

### Option B: Use your existing SSH key

If your default SSH key (`~/.ssh/id_ed25519` or `~/.ssh/id_rsa`) has **no passphrase**, you can use it directly:

```
SSH_KEY_PATH=/home/you/.ssh/id_ed25519
```

**Important:** If your key has a passphrase (common on macOS with Keychain), it will **not work** inside the Docker container — there's no SSH agent to decrypt it. Use Option A instead.

### Option C: No SSH key (manual pull on host)

If you don't set `SSH_KEY_PATH`, the sync button will still:
- Invalidate the search cache
- Refresh the file tree

But it won't pull from the remote. You'll need to run `git pull` on the host machine manually or via a cron job:

```bash
# Add to crontab: pull every 5 minutes
*/5 * * * * cd /path/to/your/notes && git pull --ff-only 2>/dev/null
```

---

## HTML pages (optional)

People and agents can publish HTML pages (a report, a dashboard) into a
project folder, and the people who can read that folder can view them. Pages
are view only: there is no HTML editor.

**A page lives in the notes tree as one small file**, `<name>.page.md`, in any
folder, next to the notes it belongs with. That file is the page's handle: it
holds only front matter (`page: <id>`, title, author, published date) and a
line saying it is an HTML page. The page's own files (HTML, CSS, scripts,
images, data) are stored apart from the notes and never show in the tree or
in notes search. With pages on, the handle shows with a page icon and opens
the page in a viewer; with pages off it is just a small note.

A page is a folder with an `index.html` (and any files it links to with
relative paths), or a single `.html` file. Publish it with the CLI or the MCP
`publish_page` tool:

```bash
mdnest page publish @myserver/engineering/Reports/q3-report ./report-folder
mdnest page list @myserver/engineering
mdnest read @myserver/engineering/Reports/q3-report.page.md   # the handle, then the page's text
```

Or drag it from your desktop onto a folder in the tree: one `.html` file, a
folder with an `index.html`, or a page your browser saved with "Save page as,
Webpage complete" (the `.html` file together with its `_files` folder). The
size and file count are checked before it uploads, and a page that already
exists asks before it is replaced. Dropping anything that is not HTML does
nothing, as before.

Publishing to the same handle again replaces the page; there is no version
history.

**Finding pages.** The **Pages** button on the right of the toolbar (with
Chats and Stickies) opens the Pages list in the side panel. Its ⤢ button, or
"Open full view", opens the Pages view; on a phone or a narrow window the
button opens the Pages view directly. The Pages view has a card for every HTML
page in the workspace you can
read, with its title, folder, author, date, file count and, when the page has
a `<meta name="description">`, that description. Search covers the pages'
text, titles and descriptions; sort by newest, title or folder. **Open** shows
the page; the target button shows its handle in the tree without opening it.
The cards are never live previews, so opening the view runs no page scripts.

The side panel's Pages list is a short searchable list for working beside
your notes: a click opens the HTML page in the main area and the panel stays
open, so you can flip through several. Its target button shows a page in the
tree.

**Who can do what.** A page uses the permissions of the folder its handle is
in, exactly like the notes next to it: read access on the handle lets you
view the page, write access lets you publish over it or delete it. A grant on
a subfolder works for the pages in that subfolder.

**Moving, copying, deleting.** Move or rename the handle like any note and
the page goes with it. Moving or copying it to another namespace takes the
page along. Copying a handle within a namespace gives the readers of the new
folder that page too, the same as copying a note they could read. Deleting
the handle deletes the page, unless another handle still points to it.

A page belongs to the namespace it was published in. A handle that reaches
another namespace some other way (copied by hand, or by git sync) shows
"this page was published in another namespace: publish it again here". A
handle removed outside mdnest (by git sync, for example) leaves its page
"unlinked": writers of the whole namespace see them on the Unlinked tab of the
Pages view and can delete them. They are never deleted on their own.

**Turning it on.** Set `ENABLE_PAGES=true` in `mdnest.conf` and run
`./mdnest-server rebuild`. Page files are kept in the named volume
`mdnest-pages`, or in the host folder `PAGES_DIR` names. Back that up along
with your notes. On the Helm chart, set `pages.enabled: true`; page files are
kept on the notes volume in a hidden folder. Pages are not available on the
multi-replica app role (`MDNEST_ROLE=app`, the git-native HA topology).

**Pages are for casual sharing, not kept in git.** A page's HTML, scripts and
images are stored apart from your notes (in `PAGES_DIR` or the `mdnest-pages`
volume). Git sync saves only the small `<name>.page.md` file, so a server
rebuilt from the git repository alone shows every page as missing. Back up the
pages store with your notes, and copy it along when you move to another
server. The Pages view in the app says the same.

**Set `FRONTEND_ORIGIN` to the address people open.** Pages with scripts off
show at mdnest's own address whatever it says. With script mode
(`PAGES_ORIGIN`), only the address in `FRONTEND_ORIGIN` may show a page, so
behind your own domain or reverse proxy set it to that public URL (for example
`FRONTEND_ORIGIN=https://notes.example.com`), not the internal
`http://localhost:<port>`, or pages show the browser's "refused to connect".

### Static mode (the default)

Without `PAGES_ORIGIN`, pages are served from mdnest's own address with their
scripts turned off. Text, tables, CSS and images show; anything a script would
have drawn (a chart, a filter) does not. No extra setup is needed.

### Script mode (needs team setup)

A page's script runs in the viewer's browser. On mdnest's own address it could
act as the viewer, so scripts only run when pages come from a second address
that serves page files and nothing else. Set `PAGES_ORIGIN` to that address:

| Setup | `mdnest.conf` | What `setup.sh` does |
|---|---|---|
| A second port | `PAGES_ORIGIN=http://localhost:3237` | Publishes that port to the backend's pages listener |
| A second hostname, with Caddy | `CADDY_DOMAIN=notes.example.com`, `PAGES_ORIGIN=https://pages.example.com` | Adds a Caddy site for that hostname. Point its DNS at the server |
| A second hostname, your own proxy | `PAGES_ORIGIN=https://pages.example.com`, `PAGES_PORT=3237` | Publishes host port 3237 to the pages listener. Send that hostname to it from your proxy |

`PAGES_ORIGIN` must differ from `FRONTEND_ORIGIN`. `setup.sh` refuses the same
address, and the backend logs an error and stays in static mode if it is given
one. On Helm, set `pages.origin`; with `ingress.enabled` the chart adds a rule
for that hostname.

`PAGES_NETWORK` decides what a page's scripts may load: `strict` (the default)
allows only the page's own files, `open` also allows outside scripts and calls
to outside sites over https. `strict` does not stop a page from sending what
it shows to an outside site (a script can move its own frame to any address),
so do not rely on it to keep a page's content in. The security details are in
[security.md](security.md#html-pages).

## Remote Access

By default, mdnest binds to `127.0.0.1` and is only accessible from the host machine. To access it from other devices, choose one of the following approaches.

### Option 1: Caddy (Built-in, Simplest)

mdnest includes built-in HTTPS support via [Caddy](https://caddyserver.com/). Caddy runs as a Docker container alongside the app and automatically provisions TLS certificates from Let's Encrypt.

**1. Point a DNS A record** at your server's public IP:

```
notes.yourdomain.com → 203.0.113.10
```

**2. Add to `mdnest.conf`:**

```ini
CADDY_DOMAIN=notes.yourdomain.com
FRONTEND_ORIGIN=https://notes.yourdomain.com
```

**3. Rebuild and start:**

```bash
./mdnest-server rebuild
```

Caddy listens on ports 80 and 443. HTTP requests are automatically redirected to HTTPS. The backend and frontend ports are no longer exposed to the host -- all traffic flows through Caddy.

> **Note:** Ports 80 and 443 must be open in your firewall / security group. Port 80 is required for Let's Encrypt HTTP-01 challenge validation.

### Option 2: Tailscale Serve

If you use [Tailscale](https://tailscale.com/), one `tailscale serve` command gives mdnest a trusted HTTPS address that only devices on your tailnet can reach, with no firewall ports opened. The [Tailscale guide](https://mdnest.dev/docs/tailscale) has the command and the steps for your phone.

### Option 3: Nginx Reverse Proxy + Certbot

Install nginx and certbot on the host, then create a proxy configuration:

```nginx
server {
    server_name notes.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3236;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Obtain a TLS certificate:

```bash
sudo certbot --nginx -d notes.yourdomain.com
```

Update `FRONTEND_ORIGIN` in `mdnest.conf` to `https://notes.yourdomain.com`, then re-run `./mdnest-server rebuild`.

### Option 4: Cloudflare Tunnel

```bash
cloudflared tunnel create mdnest
cloudflared tunnel route dns mdnest notes.yourdomain.com
cloudflared tunnel --url http://127.0.0.1:3236 run mdnest
```

Update `FRONTEND_ORIGIN` in `mdnest.conf` to `https://notes.yourdomain.com`, then re-run `./mdnest-server rebuild`.

---

## Environment Variables

These environment variables are set in the generated `.env` file and consumed by the Docker containers. You should not edit `.env` directly -- edit `mdnest.conf` and run `./mdnest-server rebuild` instead.

| Variable | Description |
|----------|-------------|
| `MDNEST_USER` | Login username |
| `MDNEST_PASSWORD` | Login password |
| `MDNEST_JWT_SECRET` | Secret for signing JWT tokens |
| `FRONTEND_ORIGIN` | URL where the frontend is served (used for CORS headers) |
| `GIT_AUTHOR_NAME` | Name for git-sync commits |
| `GIT_AUTHOR_EMAIL` | Email for git-sync commits |
| `AUTH_MODE` | Auth mode: `single` or `multi` |
| `DEFAULT_THEME` | Theme for users who have not chosen one: `auto`, `dark` or `light` |
| `NOTES_DIR` | Path to the notes root inside the container (set to `/data/notes` in `docker-compose.yml`) |
| `PORT` | Backend listen port inside the container (defaults to `8080`) |
| `POSTGRES_HOST` | PostgreSQL host (multi mode only) |
| `POSTGRES_PORT` | PostgreSQL port (multi mode only) |
| `POSTGRES_DB` | PostgreSQL database (multi mode only) |
| `POSTGRES_USER` | PostgreSQL user (multi mode only) |
| `POSTGRES_PASSWORD` | PostgreSQL password (multi mode only) |
| `ENABLE_PAGES`, `PAGES_DIR`, `PAGES_MAX_MB`, `PAGES_MAX_FILES`, `PAGES_NETWORK` | HTML pages, written only when `ENABLE_PAGES=true`. `PAGES_DIR` is the container path (`/data/pages`) |
| `PAGES_ORIGIN`, `PAGES_LISTEN_PORT` | Script mode only: the pages address, and the backend's internal port for it (`8081`) |

---

## Two-Factor Authentication (2FA)

### Enabling 2FA

Add to `mdnest.conf`:

```
REQUIRE_2FA=true
TOTP_ISSUER=YourOrg mdnest    # Name shown in authenticator app (optional)
```

Run `./mdnest-server rebuild`. All users will be required to set up 2FA on their next login.

### Sharing 2FA Across Multiple Servers

If you run multiple mdnest instances (e.g. `growth.mdnest.yourorg.com`, `docs.mdnest.yourorg.com`), users can use the **same authenticator entry** for all servers.

Set up 2FA on the first server, then export and import the secret:

```bash
# On server A (where 2FA is already set up)
./mdnest-server export-2fa ahsan

# Output:
#   TOTP Secret: JBSWY3DPEHPK3PXP
#   To import on another server:
#     ./mdnest-server import-2fa ahsan JBSWY3DPEHPK3PXP

# On server B, C, D...
./mdnest-server import-2fa ahsan JBSWY3DPEHPK3PXP
```

The same 6-digit code from the authenticator app now works on all servers. Use the same `TOTP_ISSUER` on all servers so the authenticator app groups them.

### Admin: Reset a User's 2FA

From the admin panel in the web UI, or via API:

```bash
curl -X POST https://your-server/api/admin/reset-2fa \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"userId": 5}'
```

The user will need to set up 2FA again on next login (if `REQUIRE_2FA=true`).

## Updating

To update mdnest to the latest version:

```bash
cd mdnest
./mdnest-server update
```

---

## Troubleshooting

### Empty namespace / no files showing up

- Verify the host directory exists and contains files.
- Check that the `MOUNT_` path in `mdnest.conf` is an absolute path.
- Re-run `./mdnest-server rebuild` to regenerate config and restart.
- Inspect the running container's volumes:
  ```bash
  docker compose exec backend ls /data/notes/
  ```

### Docker Desktop file sharing (macOS/Windows)

Docker Desktop requires explicit file sharing permissions for host directories. If your mounted directories appear empty inside the container:

1. Open Docker Desktop settings.
2. Go to **Resources > File Sharing**.
3. Add the parent directory of your notes folders.
4. Restart Docker Desktop and re-run `./mdnest-server rebuild`.

### `error getting credentials … docker-credential-desktop … not found`

Your `~/.docker/config.json` names a credential helper that isn't installed, usually `"credsStore": "desktop"` left behind after moving from Docker Desktop to Colima or OrbStack. Docker consults it before every image pull, so any build fails, not just mdnest's.

`mdnest-server` (v4.6.1+) detects this, prints a warning, and pulls anonymously for that run. To make the warning go away, remove the `credsStore` line (or the `credHelpers` entry) from `~/.docker/config.json`, or install the helper it names. A plain `docker compose build` outside `mdnest-server` still fails until you do.

### Port conflicts

If port `8286` or `3236` is already in use, change `BACKEND_PORT` or `FRONTEND_PORT` in `mdnest.conf` and re-run `./mdnest-server rebuild`.

### "invalid credentials" after changing password

After changing `MDNEST_PASSWORD` in `mdnest.conf`:

1. Re-run `./mdnest-server rebuild`.
3. Clear your browser's local storage for the mdnest site (the old JWT token is no longer valid).

### git-sync not pushing

- **Check the logs first:**
  ```bash
  ./mdnest-server sync-logs
  ```
- **"Permission denied (publickey)"** — your SSH key is likely passphrase-protected. The container has no SSH agent to decrypt it. Generate a dedicated deploy key (see [Git Sync](#git-sync) above).
- **"Bad configuration option: usekeychain"** — this happens with old configurations that mounted `~/.ssh` directly. The current setup uses `git-sync/keys/` instead. Re-run `./mdnest-server rebuild`.
- **Verify the deploy key** is added to your git provider with write access.
- **Ensure the notes directory** has a git remote configured:
  ```bash
  cd /path/to/your/notes
  git remote -v
  ```

### Container keeps restarting

Check the logs for the failing container:

```bash
./mdnest-server logs backend
./mdnest-server logs frontend
```

Common causes:

- Missing or invalid environment variables in `.env`.
- `NOTES_DIR` pointing to a path that does not exist inside the container.
- Port already in use on the host.

### Backend fails to start with "failed to connect to database"

This happens when `AUTH_MODE=multi` but Postgres is not reachable:

- Check that the `postgres` container is running: `./mdnest-server status`
- Check Postgres logs: `docker compose logs postgres`
- If using an external Postgres, verify `POSTGRES_HOST`, `POSTGRES_PORT`, and credentials in `mdnest.conf`
- Run `./mdnest-server migrate` to verify the database connection before starting
