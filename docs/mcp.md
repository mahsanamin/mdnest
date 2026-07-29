# MCP server (AI agents)

mdnest ships a [Model Context Protocol](https://modelcontextprotocol.io) server
that lets AI agents (Claude Desktop, Cursor, custom scripts, hosted assistants)
read, write, search, and organize your notes. It talks to the normal mdnest REST
API, so every action is authenticated and attributed exactly like a human user.

The server lives in [`mcp-server/`](../mcp-server/) and supports **two
transports**:

| Transport | Env | Best for |
|---|---|---|
| **stdio** (default) | `MCP_TRANSPORT=stdio` | A single desktop client on the same machine (Claude Desktop, Cursor). The client launches the process and talks over stdin/stdout. |
| **streamable-HTTP** | `MCP_TRANSPORT=http` | A shared/hosted endpoint that many clients (or a team) reach over the network. Runs as a long-lived service and exposes `POST /mcp`. |

> **Available tools:** `list_namespaces`, `list_tree`, `read_note`,
> `write_note`, `append_note`, `prepend_note`, `create_note`, `create_folder`,
> `delete_item`, `move_item`, `search_notes`.

---

## 1. Get an API token

Every mode needs mdnest credentials. The recommended credential is a long-lived
**API token**:

1. Open mdnest, go to **Settings (gear icon) → API Tokens**.
2. Create a token. It looks like `mdnest_xxxxxxxx…`.
3. Keep it secret — it grants the same access as your account.

The MCP server reads it from `MDNEST_TOKEN`. (As a fallback it can log in with
`MDNEST_USER` + `MDNEST_PASSWORD`, but a token is preferred and never expires
silently.)

---

## 2. stdio transport (local desktop client)

Install dependencies once:

```bash
cd mcp-server && npm install
```

Then point your MCP client at `index.js`. Example for Claude Desktop
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mdnest": {
      "command": "node",
      "args": ["/path/to/mdnest/mcp-server/index.js"],
      "env": {
        "MDNEST_URL": "http://localhost:8286",
        "MDNEST_TOKEN": "mdnest_your_token_here"
      }
    }
  }
}
```

The client spawns the process on demand; there is nothing to keep running.

---

## 3. streamable-HTTP transport (shared / hosted endpoint)

Run the server as a network service and clients connect to `POST /mcp`.

### Run it directly

```bash
cd mcp-server && npm install
MCP_TRANSPORT=http \
MCP_HTTP_PORT=3000 \
MDNEST_URL=http://localhost:8286 \
MDNEST_TOKEN=mdnest_your_token_here \
node index.js
```

### Run it as a container

The bundled [`Dockerfile`](../mcp-server/Dockerfile) **defaults to the HTTP
transport**:

```bash
docker build -t mdnest-mcp ./mcp-server
docker run --rm -p 3000:3000 \
  -e MDNEST_URL=http://host.docker.internal:8286 \
  -e MDNEST_TOKEN=mdnest_your_token_here \
  mdnest-mcp
```

### Endpoints

| Method / path | Purpose |
|---|---|
| `POST /mcp` | The MCP JSON-RPC endpoint (stateless streamable-HTTP; one request per POST). |
| `GET /healthz` | Liveness probe — returns `ok`. |
| `GET`/`DELETE /mcp` | `405` — server-initiated streams and session teardown are unused in stateless mode. |
| OAuth discovery routes | Only in OAuth mode (see below). |

### Point a client at it

For an HTTP-capable MCP client (service-token mode):

```json
{
  "mcpServers": {
    "mdnest": {
      "url": "http://your-host:3000/mcp"
    }
  }
}
```

---

## 4. Authentication modes (HTTP only)

The HTTP transport has two auth modes, selected with `MCP_AUTH_MODE`:

### `service` (default)

The server holds **one** mdnest token (`MDNEST_TOKEN`) and uses it for every
request. The `/mcp` endpoint itself is unauthenticated, so anyone who can reach
it acts as that token's user. Only expose it on a trusted network (loopback,
VPN, or behind a reverse proxy that adds auth). Simple; good for a single-user
or fully-trusted deployment.

### `oauth` (per-user, OAuth 2.1)

Each MCP client obtains the **calling user's own** mdnest JWT through your
corporate SSO, and the server forwards that token to the backend per request —
so every action is attributed to the real user, not a shared service account.
The server publishes OAuth 2.1 discovery + authorization endpoints and
challenges unauthenticated requests with `401`.

Requires all of:

| Env | Meaning |
|---|---|
| `MCP_AUTH_MODE=oauth` | Enable OAuth mode. |
| `MCP_PUBLIC_URL` | The externally-reachable base URL of this MCP server (e.g. `https://mcp.notes.example.com`). |
| `MCP_OAUTH_SECRET` | Secret used to sign the short-lived OAuth state/session. |
| `MCP_SSO_AUTHORIZE_URL` | mdnest's SSO authorize endpoint that mints the user JWT. |

In OAuth mode no process-wide `MDNEST_TOKEN` is needed. Cookies are marked
`Secure` automatically when `MCP_PUBLIC_URL` is `https://`.

---

## 5. Configuration reference

| Env | Default | Description |
|---|---|---|
| `MDNEST_URL` | `http://localhost:8286` | Base URL of the mdnest backend the MCP server calls. |
| `MDNEST_TOKEN` | — | Long-lived API token (preferred credential; required in `service` mode). |
| `MDNEST_USER` / `MDNEST_PASSWORD` | — | Fallback login if no token is set. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` (a.k.a. `streamable-http`). |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address (HTTP mode). |
| `MCP_HTTP_PORT` | `3000` | Listen port (HTTP mode). |
| `MCP_HTTP_PATH` | `/mcp` | Request path (HTTP mode). |
| `MCP_AUTH_MODE` | `service` | `service` or `oauth` (HTTP mode). |
| `MCP_PUBLIC_URL` | — | Public base URL of the MCP server (OAuth mode). |
| `MCP_OAUTH_SECRET` | — | Signing secret for OAuth sessions (OAuth mode). |
| `MCP_SSO_AUTHORIZE_URL` | — | mdnest SSO authorize URL (OAuth mode). |

---

## 6. Kubernetes / Helm

The Helm chart ships the MCP server as an **opt-in** component. Enable it with
`mcp.enabled=true` and configure the mode under the `mcp.*` values (see the
[chart README](../deploy/helm/mdnest/README.md)). The chart wires the same env
vars documented above.

---

## 7. Docker Compose (opt-in)

For self-hosted `docker compose` installs, the MCP server can be added as an
optional service. It is **disabled by default** and gated behind a compose
profile, so existing deployments are unaffected. Enable it in `mdnest.conf`:

```ini
# mdnest.conf
ENABLE_MCP=true
# Service-token mode: the token the MCP server uses for every request.
# Create it in Settings → API Tokens after the first boot, then set it here.
MCP_TOKEN=mdnest_your_token_here
# Optional: host port for the /mcp endpoint (default 3000)
# MCP_HTTP_PORT=3000
```

Then `./mdnest-server rebuild`. The endpoint is served at
`http://localhost:3000/mcp` and reaches the backend internally over the compose
network. Because the token is created in the running app, first boot is a
two-step flow: bring mdnest up, create the token, set `MCP_TOKEN`, then rebuild.

For OAuth mode set `MCP_AUTH_MODE=oauth` plus `MCP_PUBLIC_URL`,
`MCP_OAUTH_SECRET`, and `MCP_SSO_AUTHORIZE_URL` in `mdnest.conf`.
