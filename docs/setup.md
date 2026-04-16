# Setup and Configuration

This guide covers installing, configuring, and running mdnest.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (version 20.10 or later)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2, included with Docker Desktop)
- Git (to clone the repository)

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/mdnest/mdnest.git
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
| `FRONTEND_ORIGIN` | `http://localhost:<FRONTEND_PORT>` | The full URL where the frontend is served. Used for CORS. Update this if you use a custom domain or reverse proxy. |
| `BACKEND_PORT` | `8286` | Host port mapped to the backend container (port 8080 internally) |
| `FRONTEND_PORT` | `3236` | Host port mapped to the frontend container (port 80 internally) |
| `GIT_AUTHOR_NAME` | *(none)* | Name used for git commits when git-sync is enabled |
| `GIT_AUTHOR_EMAIL` | *(none)* | Email used for git commits when git-sync is enabled |
| `AUTH_MODE` | `single` | Auth mode: `single` (file-based, no DB) or `multi` (Postgres-backed users & permissions) |
| `POSTGRES_HOST` | `postgres` | PostgreSQL host (only when `AUTH_MODE=multi`). Use `postgres` for the built-in container. |
| `POSTGRES_PORT` | `5432` | PostgreSQL port (only when `AUTH_MODE=multi`) |
| `POSTGRES_DB` | `mdnest` | PostgreSQL database name (only when `AUTH_MODE=multi`) |
| `POSTGRES_USER` | `mdnest` | PostgreSQL user (only when `AUTH_MODE=multi`) |
| `POSTGRES_PASSWORD` | *(none, required when multi)* | PostgreSQL password (only when `AUTH_MODE=multi`) |
| `SSH_KEY_PATH` | *(none)* | Path to SSH private key on the host. Mounted into the backend for git pull via sync button. Must be passphrase-free. |
| `CADDY_DOMAIN` | *(none)* | Domain name for automatic HTTPS via Caddy. When set, adds a Caddy container and makes backend/frontend ports internal-only. Requires a DNS A record pointing to the server. |
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

   Or manually add a `MOUNT_` line to `mdnest.conf`:
   ```
   MOUNT_projects=/home/ahsan/notes/projects
   ```

3. Re-run setup and restart:
   ```bash
   ./mdnest-server rebuild
   ```

### Removing a Namespace

```bash
./mdnest-server remove-namespace
```

Lists all namespaces, asks which to remove, cleans up config and deploy key. Files on disk are NOT deleted.

Or manually: remove the `MOUNT_` line from `mdnest.conf` and run `./mdnest-server rebuild`.

### Naming Rules

Namespace names (the part after `MOUNT_`) must be simple identifiers:

- No slashes or backslashes
- Must not start with a dot
- Should contain only alphanumeric characters and underscores

---

## Multi-User Mode

By default, mdnest runs in **single-user mode** -- one user, file-based auth, no database needed. This is the simplest setup and works for personal use.

**Multi-user mode** adds PostgreSQL-backed user management with roles and namespace-level access control. When enabled, `setup.sh` automatically adds a Postgres container to `docker-compose.yml`.

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
ssh-keygen -t ed25519 -f git-sync/keys/my_wego_brain -N "" -C "mdnest-sync"
ssh-keygen -t ed25519 -f git-sync/keys/personal     -N "" -C "mdnest-sync"
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

If you use [Tailscale](https://tailscale.com/), expose the frontend port:

```bash
tailscale serve --bg 3236
```

This gives you a `https://your-machine.tailnet-name.ts.net` URL accessible from any device on your Tailscale network. No additional configuration is needed.

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
| `NOTES_DIR` | Path to the notes root inside the container (set to `/data/notes` in `docker-compose.yml`) |
| `PORT` | Backend listen port inside the container (defaults to `8080`) |
| `POSTGRES_HOST` | PostgreSQL host (multi mode only) |
| `POSTGRES_PORT` | PostgreSQL port (multi mode only) |
| `POSTGRES_DB` | PostgreSQL database (multi mode only) |
| `POSTGRES_USER` | PostgreSQL user (multi mode only) |
| `POSTGRES_PASSWORD` | PostgreSQL password (multi mode only) |

---

## Two-Factor Authentication (2FA)

### Enabling 2FA

Add to `mdnest.conf`:

```
REQUIRE_2FA=true
TOTP_ISSUER=Wego mdnest    # Name shown in authenticator app (optional)
```

Run `./mdnest-server rebuild`. All users will be required to set up 2FA on their next login.

### Sharing 2FA Across Multiple Servers

If you run multiple mdnest instances (e.g. `growth.mdnest.wego.engineering`, `docs.mdnest.wego.engineering`), users can use the **same authenticator entry** for all servers.

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
