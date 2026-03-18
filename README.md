# mdnest

A private, self-hosted knowledge base for your personal notes.

Everything runs on your machine. Notes are plain `.md` files on disk -- no database, no cloud, no third-party services. Only you have access. The app binds to `127.0.0.1` by default, meaning it's not reachable from the network unless you explicitly enable remote access via Tailscale or a reverse proxy.

Built for developers and technical people who want markdown, folders, code blocks, mermaid diagrams, and task lists -- without the bloat. Optionally sync to a private GitHub repo on your own schedule.

**Comfortable range: 1,000-5,000 notes out of the box.** For larger repositories (5,000-20,000+), tune the [search settings](#search) -- no architectural changes needed, just configuration.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- Git
- A directory (or directories) on your machine where you want to store notes

## Quick Start

```bash
git clone https://github.com/mahsanamin/mdnest.git
cd mdnest
./setup.sh
```

This creates `mdnest.conf` from the sample. Open it and set:

1. **Credentials** -- change `MDNEST_USER`, `MDNEST_PASSWORD`, and `MDNEST_JWT_SECRET`
2. **Mounts** -- add at least one `MOUNT_<name>=<path>` pointing to a directory on your machine

Example:
```
MDNEST_USER=ahsan
MDNEST_PASSWORD=mysecurepassword
MDNEST_JWT_SECRET=some-random-string

MOUNT_personal=/home/ahsan/notes
MOUNT_work=/home/ahsan/work-notes
```

Then generate and start:

```bash
./setup.sh                       # generates docker-compose.yml + .env
docker-compose up --build -d     # build and start
```

Open [http://localhost:3236](http://localhost:3236)

## Managing

```bash
docker-compose up -d             # start
docker-compose down              # stop
docker-compose restart           # restart
docker-compose up --build -d     # rebuild after code changes
docker-compose logs -f           # view logs
docker-compose logs -f backend   # view backend logs only
```

After editing `mdnest.conf`, always re-run:
```bash
./setup.sh && docker-compose up --build -d
```

## Updating

```bash
git pull
./setup.sh
docker-compose up --build -d
```

## Configuration

Everything is driven by `mdnest.conf`. Run `./setup.sh` after any change.

| Setting | Description | Default |
|---|---|---|
| `MDNEST_USER` | Login username | `admin` |
| `MDNEST_PASSWORD` | Login password | `changeme` |
| `MDNEST_JWT_SECRET` | JWT signing secret | `changeme` |
| `BACKEND_PORT` | Backend API port | `8286` |
| `FRONTEND_PORT` | Frontend UI port | `3236` |
| `BIND_ADDRESS` | Network bind address | `127.0.0.1` |
| `MOUNT_<name>` | Map a host directory as a namespace | -- |

### Search

Filename filtering is instant (client-side). Content search runs server-side with concurrent file reads, a cached file index, and early termination.

| Setting | Description | Default |
|---|---|---|
| `SEARCH_MAX_RESULTS` | Max results per query | `30` |
| `SEARCH_MAX_FILE_SIZE` | Skip files larger than this (bytes) | `1048576` (1 MB) |
| `SEARCH_WORKERS` | Parallel file readers | `8` |
| `SEARCH_CACHE_TTL` | File list cache lifetime (seconds) | `30` |

For 10,000+ notes: set `SEARCH_WORKERS=16` and `SEARCH_CACHE_TTL=60`.

See [docs/setup.md](docs/setup.md) for full details.

## Namespaces

Each `MOUNT_<name>=<host_path>` entry in `mdnest.conf` mounts a host directory as a namespace. Namespaces are isolated -- separate trees, separate files. Add or remove by editing `mdnest.conf` and re-running `./setup.sh`.

## Git Sync (Optional)

Your notes are private by default. Nothing leaves your machine unless you choose to enable sync.

To back up to a private GitHub repo, initialize each namespace directory as a git repo with a remote, then start with the sync profile:

```bash
docker-compose --profile sync up --build -d
```

The sync interval is configurable (default: every 10 minutes):

```
GIT_SYNC_INTERVAL=900    # sync every 15 minutes
```

See [docs/setup.md](docs/setup.md) for SSH key setup.

## MCP Server

AI assistants (Claude, etc.) can read, write, and search your notes via the bundled MCP server.

```bash
cd mcp-server && npm install
```

Create an API token in Settings (gear icon) > API Tokens, then configure your MCP client:

```json
{
  "mcpServers": {
    "mdnest": {
      "command": "node",
      "args": ["/path/to/mdnest/mcp-server/index.js"],
      "env": {
        "MDNEST_URL": "http://localhost:8286",
        "MDNEST_TOKEN": "<your API token>"
      }
    }
  }
}
```

## Remote Access

All ports bind to `127.0.0.1` by default -- mdnest is not reachable from the network. To access from other devices:

### Tailscale (recommended)

Tailscale creates a private mesh network between your devices. Install it on the host and on any device you want to access mdnest from.

**Option A: Dedicated port (if you run multiple services on this host)**

```bash
tailscale serve --bg --https 3236 http://127.0.0.1:3236
```

Access: `https://<your-hostname>.tailnet-name.ts.net:3236`

**Option B: Default HTTPS on port 443 (if this host is dedicated to mdnest)**

```bash
tailscale serve --bg http://127.0.0.1:3236
```

Access: `https://<your-hostname>.tailnet-name.ts.net`

**Manage:**

```bash
tailscale serve status    # see active rules
tailscale serve off       # remove all rules
```

### Other options

- **Nginx + Certbot** -- traditional reverse proxy with free TLS. See [docs/setup.md](docs/setup.md).
- **Cloudflare Tunnel** -- no open ports, works behind NAT. See [docs/setup.md](docs/setup.md).

## Documentation

- [docs/api.md](docs/api.md) -- API Reference
- [docs/setup.md](docs/setup.md) -- Setup and Configuration
- [docs/user-guide.md](docs/user-guide.md) -- User Guide
- [docs/architecture.md](docs/architecture.md) -- Architecture

## License

MIT. See [LICENSE](LICENSE).
