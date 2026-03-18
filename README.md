# mdnest

A self-hosted knowledge base for developers and technical people who want to own their notes.

Write in markdown. Files live on your disk as plain `.md` -- no database, no proprietary format, no cloud dependency. Edit from any browser, keep everything private on your own machine. Optionally sync to a private GitHub repo on your own schedule.

Built for the way technical people think: folders, files, code blocks, diagrams, tasks. Nothing more.

**Comfortable range: 1,000-5,000 notes out of the box.** For larger repositories (5,000-20,000+), tune the [search settings](#search) -- no architectural changes needed, just configuration.

## Quick Start

```bash
git clone https://github.com/mahsanamin/mdnest.git
cd mdnest
./setup.sh           # creates mdnest.conf from sample
# edit mdnest.conf   # set credentials, mount your directories
./setup.sh           # generates docker-compose.yml + .env
docker-compose up --build -d
```

Open [http://localhost:3236](http://localhost:3236)

## Configuration

Everything is driven by `mdnest.conf`. Run `./setup.sh` after any change.

| Setting | Description | Default |
|---|---|---|
| `MDNEST_USER` | Login username | `admin` |
| `MDNEST_PASSWORD` | Login password | `changeme` |
| `MDNEST_JWT_SECRET` | JWT signing secret | `changeme` |
| `BACKEND_PORT` | Backend API port | `8286` |
| `FRONTEND_PORT` | Frontend UI port | `3236` |
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

Configure in Claude Desktop or another MCP client:

```json
{
  "mcpServers": {
    "mdnest": {
      "command": "node",
      "args": ["/path/to/mdnest/mcp-server/index.js"],
      "env": {
        "MDNEST_URL": "http://localhost:8286",
        "MDNEST_USER": "ahsan",
        "MDNEST_PASSWORD": "changeme"
      }
    }
  }
}
```

## Remote Access

All ports bind to `127.0.0.1` by default -- mdnest is not reachable from the network. To access from other devices:

### Tailscale (recommended)

Tailscale creates a private mesh network between your devices. Install it on the host and on any device you want to access mdnest from.

```bash
# On the host machine — serve mdnest on a dedicated port with HTTPS
tailscale serve --bg --https 3236 http://127.0.0.1:3236
```

Access from any device on your tailnet:
```
https://<your-hostname>.tailnet-name.ts.net:3236
```

Using a specific port (`:3236`) keeps mdnest separate from other services on the same host.

To remove:
```bash
tailscale serve off       # removes all serve rules
```

To check what's being served:
```bash
tailscale serve status
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
