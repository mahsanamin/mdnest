# mdnest

Self-hosted markdown notes app.

Plain `.md` files on disk, no database. Runs in Docker with a Go backend and React frontend. Optional git-based backup and sync.

## Quick Start

```bash
git clone https://github.com/mdnest/mdnest.git
cd mdnest
./setup.sh           # creates mdnest.conf from sample
# edit mdnest.conf   # set credentials, mount directories
./setup.sh           # generates docker-compose.yml + .env
docker-compose up --build -d
```

Open [http://localhost:3236](http://localhost:3236)

## Configuration

Everything is driven by `mdnest.conf`. Run `./setup.sh` after any change to regenerate `docker-compose.yml`.

| Setting | Description | Default |
|---|---|---|
| `MDNEST_USER` | Login username | `admin` |
| `MDNEST_PASSWORD` | Login password | `changeme` |
| `MDNEST_JWT_SECRET` | JWT signing secret | `changeme` |
| `BACKEND_PORT` | Backend API port | `8286` |
| `FRONTEND_PORT` | Frontend UI port | `3236` |
| `MOUNT_<name>` | Map a host directory as a namespace | -- |

See [docs/setup.md](docs/setup.md) for full details.

## Namespaces

Each `MOUNT_<name>=<host_path>` entry in `mdnest.conf` mounts a host directory into the container as a namespace. Namespaces appear as top-level sections in the sidebar. Add or remove them by editing `mdnest.conf` and re-running `./setup.sh`.

## Git Sync

Optional auto-commit and push for all mounted namespaces. Each namespace directory should be its own git repo with a remote configured.

Set up an SSH key that can push to your remotes, then start with the sync profile:

```bash
docker-compose --profile sync up --build -d
```

See [docs/setup.md](docs/setup.md) for SSH key setup and sync configuration.

## MCP Server

AI assistants (Claude, etc.) can read, write, and search notes via the bundled MCP server.

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

See [docs/](docs/) for the full tool list.

## Remote Access

- **Tailscale Serve** -- zero-config HTTPS on your tailnet. See [docs/setup.md](docs/setup.md).
- **Nginx + Certbot** -- reverse proxy with free TLS. See [docs/setup.md](docs/setup.md).
- **Cloudflare Tunnel** -- expose via Cloudflare without port forwarding. See [docs/setup.md](docs/setup.md).

## Documentation

- [docs/api.md](docs/api.md) -- API Reference
- [docs/setup.md](docs/setup.md) -- Setup and Configuration
- [docs/user-guide.md](docs/user-guide.md) -- User Guide
- [docs/architecture.md](docs/architecture.md) -- Architecture

## License

MIT. See [LICENSE](LICENSE).
