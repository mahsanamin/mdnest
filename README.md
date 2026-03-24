# mdnest

Your notes. Your machine. Accessible from anywhere.

Deploy on a spare machine, a home server, or a cheap VPS. Access your notes from your laptop, phone, tablet -- or let AI agents read and write to your knowledge base directly. Everything stays yours.

### Why mdnest?

- **Host once, access everywhere.** Set up on any always-on machine and reach it securely from all your devices via Tailscale -- phone, laptop, tablet, any browser.
- **AI-native.** Built-in MCP server lets Claude, Cursor, and other AI agents read, write, search, and organize your notes. Your knowledge base becomes context for your AI workflows.
- **API-first.** Full REST API with token auth. Build scripts, automations, or integrations on top of your notes.
- **Plain files, no lock-in.** Notes are `.md` files in directories on disk. No database, no proprietary format. `cat`, `grep`, `git` -- your notes work with every tool you already use.
- **Private by default.** Binds to localhost. No cloud, no third-party services, no telemetry. Add Tailscale for encrypted remote access only to your devices.
- **Git backup on your terms.** Optionally auto-commit and push to a private GitHub repo. You control when and where.

### Who is this for?

Developers and technical people who:
- Want a personal knowledge base that runs on their own hardware
- Need their notes accessible from multiple devices and AI tools
- Don't want to trust a SaaS with their private notes
- Think in markdown, folders, code blocks, and diagrams

**Comfortable range: 1,000-5,000 notes out of the box.** For larger repositories (5,000-20,000+), tune the [search settings](#search) -- just configuration, no architectural changes.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- Git
- [Tailscale](https://tailscale.com/download) (free, for remote access)

## Quick Start

### 1. Set up the server

```bash
git clone https://github.com/mahsanamin/mdnest.git
cd mdnest
./mdnest-server setup
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

Then build and start:

```bash
./mdnest-server rebuild
```

Open [http://localhost:3236](http://localhost:3236)

### 2. Enable remote access

Install Tailscale on the host and on your phone/laptop, then:

```bash
tailscale serve --bg --https 3236 http://127.0.0.1:3236
```

Access from any of your devices: `https://your-server.tailnet.ts.net:3236`

Encrypted, private, no ports opened to the internet. See [Remote Access](#remote-access) for more options.

## Accessing Your Notes

Once the server is running, there are three ways to access your notes:

### Web UI (browser)

Open `http://localhost:3236` (or your Tailscale URL) in any browser. Works on desktop and mobile.

### CLI (terminal)

Install the `mdnest` CLI on any machine:

```bash
# Download the CLI
curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/mdnest -o /usr/local/bin/mdnest
chmod +x /usr/local/bin/mdnest
```

Then authenticate with a token from the web UI (Settings > API Tokens):

```bash
mdnest login https://your-server:3236 <your-api-token>
```

Now use it from anywhere:

```bash
mdnest note list                                    # list namespaces
mdnest note list personal                           # list files in a namespace
mdnest note read personal ideas.md                  # read a note
mdnest note write personal ideas.md "New content"   # overwrite a note
mdnest note append personal log.md "New entry"      # append to a note
mdnest note prepend personal log.md "Top entry"     # prepend to a note
mdnest note create personal new-note.md             # create a new note
mdnest note delete personal old-note.md             # delete a note
mdnest note search personal "search query"          # search notes
echo "piped content" | mdnest note write personal draft.md -  # pipe from stdin
```

Run `mdnest note help` for the full list.

### MCP Server (AI agents)

AI agents can read, write, search, and organize your notes via the bundled MCP server.

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

**Available tools:** `list_namespaces`, `list_tree`, `read_note`, `write_note`, `append_note`, `prepend_note`, `create_note`, `create_folder`, `delete_item`, `move_item`, `search_notes`

## Server Management

All server commands use `mdnest-server` and must be run from the project directory:

```bash
./mdnest-server start              # start all services
./mdnest-server stop               # stop all services
./mdnest-server restart            # restart all services
./mdnest-server rebuild            # rebuild after code or config changes
./mdnest-server logs               # view logs (all services)
./mdnest-server logs backend       # view backend logs only
./mdnest-server sync-logs          # view git-sync logs
./mdnest-server status             # show running containers
```

After editing `mdnest.conf`, always re-run:
```bash
./mdnest-server rebuild
```

## Updating

```bash
./mdnest-server update
```

## Configuration

Everything is driven by `mdnest.conf`. Run `./mdnest-server rebuild` after any change.

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

## Namespaces

Each `MOUNT_<name>=<host_path>` entry in `mdnest.conf` mounts a host directory as a namespace. Namespaces are isolated -- separate trees, separate files. Add or remove by editing `mdnest.conf` and running `./mdnest-server rebuild`.

## Git Sync (Optional)

Your notes are private by default. Nothing leaves your machine unless you choose to enable sync.

To back up to a private GitHub repo:

1. Initialize each namespace directory as a git repo with a remote
2. Add an SSH key (passphrase-protected keys won't work inside Docker):
   ```bash
   mkdir -p git-sync/keys
   # Option A: single key for all repos
   ssh-keygen -t ed25519 -f git-sync/keys/default -N "" -C "mdnest-sync"
   # Option B: one key per namespace (required for GitHub deploy keys)
   ssh-keygen -t ed25519 -f git-sync/keys/<namespace> -N "" -C "mdnest-sync"
   ```
3. Add the `.pub` key to your Git provider (GitHub: Settings > Deploy Keys, enable write access)
4. Rebuild:
   ```bash
   ./mdnest-server rebuild
   ```

Git sync starts automatically when keys are found in `git-sync/keys/`. No keys = no sync.

The sync interval is configurable (default: every 10 minutes):

```
GIT_SYNC_INTERVAL=900    # sync every 15 minutes
```

The git remote is a **backup destination** — let mdnest be the only thing pushing to it. Don't commit to the same repo from other tools. See [docs/setup.md](docs/setup.md) for full setup details.

## Remote Access

All ports bind to `127.0.0.1` by default. To access from other devices:

### Tailscale (recommended)

Tailscale creates an encrypted private network between your devices. No ports opened, no public IP needed.

**Option A: Dedicated port (multiple services on the host)**

```bash
tailscale serve --bg --https 3236 http://127.0.0.1:3236
```

Access: `https://<your-hostname>.tailnet-name.ts.net:3236`

**Option B: Default HTTPS (host dedicated to mdnest)**

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

- [docs/security.md](docs/security.md) -- Security Model
- [docs/api.md](docs/api.md) -- API Reference
- [docs/setup.md](docs/setup.md) -- Setup and Configuration
- [docs/user-guide.md](docs/user-guide.md) -- User Guide
- [docs/architecture.md](docs/architecture.md) -- Architecture

## License

MIT. See [LICENSE](LICENSE).
