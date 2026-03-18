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

# 2. Run the setup script (creates mdnest.conf from the sample on first run)
./setup.sh

# 3. Edit mdnest.conf with your settings
#    - Set your username and password
#    - Add MOUNT_ entries for your note directories
#    - Optionally configure git sync

# 4. Run setup.sh again to generate docker-compose.yml and .env
./setup.sh

# 5. Start the containers
docker compose up --build -d
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

2. Add a `MOUNT_` line to `mdnest.conf`:
   ```
   MOUNT_projects=/home/ahsan/notes/projects
   ```

3. Re-run setup and restart:
   ```bash
   ./setup.sh
   docker compose up --build -d
   ```

### Removing a Namespace

1. Remove the corresponding `MOUNT_` line from `mdnest.conf`.
2. Re-run `./setup.sh` and restart with `docker compose up --build -d`.

The files on disk are not deleted -- only the mount into the container is removed.

### Naming Rules

Namespace names (the part after `MOUNT_`) must be simple identifiers:

- No slashes or backslashes
- Must not start with a dot
- Should contain only alphanumeric characters and underscores

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

The git-sync container mounts your host's `~/.ssh` directory read-only. Ensure:

- You have an SSH key that can push to your notes repo:
  ```bash
  ssh-keygen -t ed25519 -C "mdnest"
  ```
- Add the public key to your Git hosting provider (GitHub, GitLab, etc.).
- The remote host is in your `known_hosts`:
  ```bash
  ssh-keyscan github.com >> ~/.ssh/known_hosts
  ```

**3. Configure git identity in `mdnest.conf`:**

```
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
```

**4. Start with the sync profile:**

```bash
docker compose --profile sync up --build -d
```

Without `--profile sync`, only the backend and frontend containers start. The git-sync container is excluded by default.

### How It Works

The sync loop runs every 600 seconds (10 minutes):

1. Stages all changes (`git add -A`)
2. Commits if there are staged changes (message: `sync: <timestamp>`)
3. Pulls with rebase from the remote
4. Pushes to the remote

If a pull or push fails, it logs an error and retries on the next cycle.

---

## Remote Access

By default, mdnest binds to `127.0.0.1` and is only accessible from the host machine. To access it from other devices, choose one of the following approaches.

### Option 1: Tailscale Serve (Simplest)

If you use [Tailscale](https://tailscale.com/), expose the frontend port:

```bash
tailscale serve --bg 3236
```

This gives you a `https://your-machine.tailnet-name.ts.net` URL accessible from any device on your Tailscale network. No additional configuration is needed.

### Option 2: Nginx Reverse Proxy + Certbot

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

Update `FRONTEND_ORIGIN` in `mdnest.conf` to `https://notes.yourdomain.com`, then re-run `./setup.sh` and restart.

### Option 3: Cloudflare Tunnel

```bash
cloudflared tunnel create mdnest
cloudflared tunnel route dns mdnest notes.yourdomain.com
cloudflared tunnel --url http://127.0.0.1:3236 run mdnest
```

Update `FRONTEND_ORIGIN` in `mdnest.conf` to `https://notes.yourdomain.com`, then re-run `./setup.sh` and restart.

---

## Environment Variables

These environment variables are set in the generated `.env` file and consumed by the Docker containers. You should not edit `.env` directly -- edit `mdnest.conf` and re-run `./setup.sh` instead.

| Variable | Description |
|----------|-------------|
| `MDNEST_USER` | Login username |
| `MDNEST_PASSWORD` | Login password |
| `MDNEST_JWT_SECRET` | Secret for signing JWT tokens |
| `FRONTEND_ORIGIN` | URL where the frontend is served (used for CORS headers) |
| `GIT_AUTHOR_NAME` | Name for git-sync commits |
| `GIT_AUTHOR_EMAIL` | Email for git-sync commits |
| `NOTES_DIR` | Path to the notes root inside the container (set to `/data/notes` in `docker-compose.yml`) |
| `PORT` | Backend listen port inside the container (defaults to `8080`) |

---

## Updating

To update mdnest to the latest version:

```bash
cd mdnest
git pull
./setup.sh
docker compose up --build -d
```

If you are using git-sync:

```bash
docker compose --profile sync up --build -d
```

---

## Troubleshooting

### Empty namespace / no files showing up

- Verify the host directory exists and contains files.
- Check that the `MOUNT_` path in `mdnest.conf` is an absolute path.
- Re-run `./setup.sh` to regenerate `docker-compose.yml` with the correct mounts.
- Inspect the running container's volumes:
  ```bash
  docker compose exec backend ls /data/notes/
  ```

### Docker Desktop file sharing (macOS/Windows)

Docker Desktop requires explicit file sharing permissions for host directories. If your mounted directories appear empty inside the container:

1. Open Docker Desktop settings.
2. Go to **Resources > File Sharing**.
3. Add the parent directory of your notes folders.
4. Restart Docker Desktop and re-run `docker compose up --build -d`.

### Port conflicts

If port `8286` or `3236` is already in use, change `BACKEND_PORT` or `FRONTEND_PORT` in `mdnest.conf` and re-run `./setup.sh`.

### "invalid credentials" after changing password

After changing `MDNEST_PASSWORD` in `mdnest.conf`:

1. Re-run `./setup.sh` to regenerate `.env`.
2. Restart the backend: `docker compose up --build -d`.
3. Clear your browser's local storage for the mdnest site (the old JWT token is no longer valid).

### git-sync not pushing

- Verify SSH keys are in `~/.ssh/` on the host and the public key is added to your git provider.
- Check that the remote host is in `~/.ssh/known_hosts`.
- Inspect git-sync logs:
  ```bash
  docker compose --profile sync logs git-sync
  ```
- Ensure the notes directory has a git remote configured:
  ```bash
  cd /path/to/your/notes
  git remote -v
  ```

### Container keeps restarting

Check the logs for the failing container:

```bash
docker compose logs backend
docker compose logs frontend
```

Common causes:

- Missing or invalid environment variables in `.env`.
- `NOTES_DIR` pointing to a path that does not exist inside the container.
- Port already in use on the host.
