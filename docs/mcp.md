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
> `delete_item`, `move_item`, `search_notes`, `list_tasks`, `create_task`,
> `move_task`, `edit_task`, `set_task_field`, `toggle_task`, `delete_task`,
> `search_tasks`, `create_excalidraw`, `draw_excalidraw`, `read_excalidraw`,
> `create_marp`, `add_marp_slide`, `list_marp_slides`, `read_marp_slide`,
> `edit_marp_slide`, `delete_marp_slide`, `move_marp_slide`.
>
> The `*_task` tools drive the [task board](tasks.md): `list_tasks` returns the
> board columns and every task (with the `path`/`line`/`raw` needed to mutate
> one); `create_task`/`edit_task` author a whole task (title, column, status,
> due, priority, workload, assignee, tags, relations, steps, notes);
> `set_task_field` edits one field, `toggle_task` checks/unchecks, `move_task`
> changes a task's column, `delete_task` removes it and `search_tasks` filters
> across a namespace (or all of them). `create_excalidraw`, `create_marp` and
> `add_marp_slide` scaffold drawing and slide-deck notes.

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
| `MCP_ALLOWED_REDIRECT_ORIGINS` | Comma-separated extra origins allowed to receive an authorization code. Loopback is always allowed; see below. |

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
| `MCP_ALLOWED_REDIRECT_ORIGINS` | *(empty)* | Extra origins allowed as an OAuth `redirect_uri` target, comma-separated. Loopback always allowed. |

---


### Where an authorization code may be delivered

An OAuth authorization code carries a live mdnest token, so the redirect target
is restricted — a code sent to an attacker-chosen URL is a stolen session, and
PKCE cannot prevent that (a malicious client that starts the flow holds its own
verifier, and client registration is public).

- **Loopback is always allowed** — `127.0.0.1`, `localhost`, `::1`. This is the
  native MCP client case and needs no configuration.
- **Any other origin is refused** unless you list it in
  `MCP_ALLOWED_REDIRECT_ORIGINS` (exact `scheme://host[:port]` match, HTTPS
  only). Set this only if a hosted client on a real domain must complete the
  flow — for example a hosted **MCP gateway** that federates this server and
  discovers its tools over an OAuth handshake: list the gateway's callback
  origin (e.g. `https://gateway.example.com`), otherwise its tool discovery
  fails with `400 invalid_request`.

`/oauth/authorize` returns `400 invalid_request` for anything else.

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

---

## 8. Task tools

The server exposes the [task board](tasks.md) so an agent can manage tasks, not
just notes. Tasks are plain markdown checkboxes in the notes, so these tools read
and rewrite that markdown.

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `list_tasks` | Board columns + every task in a namespace (or one note). Returns each task's `path`, `line` and `raw` — needed to mutate it. | `namespace`, `note?` |
| `create_task` | Append a whole task to a note (the note, else the board's default note; created if missing). | `namespace`, `title`, `note?`, `column?`, `status?`, `due?`, `priority?`, `workload?`, `assignee?`, `tags?`, `dependsOn?`, `blockedBy?`, `relatedTo?`, `notes?`, `steps?`, `defaultExpanded?` |
| `move_task` | Move a task to a column (sets its status; checks the box for the Done column). | `namespace`, `path`, `line`, `raw`, `column` |
| `edit_task` | Replace a task's whole definition (omitted fields are cleared; pass `ref` to keep the stable id). | `namespace`, `path`, `line`, `raw`, `title`, `ref?`, `column?`, `status?`, `due?`, `priority?`, `workload?`, `assignee?`, `tags?`, `dependsOn?`, `blockedBy?`, `relatedTo?`, `notes?`, `steps?`, `defaultExpanded?` |
| `set_task_field` | Set or clear a single field without resending the whole task. | `namespace`, `path`, `line`, `raw`, `key`, `value` |
| `toggle_task` | Check/uncheck a task or one of its steps (blocked with `422` if closing over open steps). | `namespace`, `path`, `line`, `raw`, `checked` |
| `delete_task` | Delete a task (checkbox + detail block). | `namespace`, `path`, `line`, `raw` |
| `search_tasks` | Filter tasks in a namespace, or across all of them with `global`. Filters are ANDed. | `namespace?`, `global?`, `note?`, `text?`, `column?`, `status?`, `priority?`, `assignee?`, `tags?`, `checked?`, `relatesTo?`, `dueBefore?` |

Relations (`dependsOn` / `blockedBy` / `relatedTo`) reference other tasks by
their stable `ref` (shown by `list_tasks`). `set_task_field` takes those same
keys as `depends-on` / `blocked-by` / `related-to` with a comma-separated value.

**Workflow.** Call `list_tasks` first to read the column ids and each task's
`path`/`line`/`raw`; pass those back to `move_task` / `edit_task` /
`set_task_field` / `toggle_task` / `delete_task`. The mutations
are optimistically concurrent — a `409` means the note changed under you, so
re-run `list_tasks` and retry. See the [task model](tasks.md) for the markdown a
task compiles to and the [API reference](api.md#task-board) for the underlying
endpoints.

## 9. Drawing & slide tools

Excalidraw drawings and Marp decks are ordinary notes with a specific layout, so
these tools scaffold a valid file that the app then renders.

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `create_excalidraw` | Create an empty, valid Obsidian-compatible `.excalidraw.md` drawing (suffix added if missing). | `namespace`, `path`, `background?` |
| `draw_excalidraw` | Author/edit a diagram from a high-level spec: `nodes` (labelled shapes) + `edges` (arrows). Compiles to a valid scene with bound labels and connected arrows. `replace` (default) or `append`. | `namespace`, `path`, `nodes?`, `edges?`, `mode?`, `background?` |
| `read_excalidraw` | Read a drawing back as `{ nodes, edges }` (with stable element ids) so an agent can inspect before editing. | `namespace`, `path` |
| `create_marp` | Create a Marp deck note (`marp: true` frontmatter + `---`-separated slides). | `namespace`, `path`, `title?`, `theme?`, `paginate?`, `slides?` |
| `list_marp_slides` | List a deck's slides (1-based index, first line, length) + its frontmatter. | `namespace`, `path` |
| `read_marp_slide` | Read one slide's markdown by index. | `namespace`, `path`, `index` |
| `add_marp_slide` | Add a slide — appended, or inserted before a 1-based `index`. | `namespace`, `path`, `content`, `index?` |
| `edit_marp_slide` | Replace one slide's markdown by index (frontmatter + other slides untouched). | `namespace`, `path`, `index`, `content` |
| `delete_marp_slide` | Delete one slide by index. | `namespace`, `path`, `index` |
| `move_marp_slide` | Reorder: move the slide at `from` to `to`. | `namespace`, `path`, `from`, `to` |

**Slides are CRUD.** A Marp deck is a note whose subject is a list of slides, so
the deck is editable both as a whole (the note tools) and per slide: `list_/
read_marp_slide` to inspect, `add_/edit_/delete_/move_marp_slide` to change one
slide by its 1-based index. Slide boundaries follow the same rule as the app's
preview (a blank-line-preceded `---` outside fenced code), so a `---` inside a
code block never splits a slide.

**Diagrams.** `draw_excalidraw` lets an agent build or edit a drawing without
touching Excalidraw's raw element schema: describe `nodes` (each with an `id`,
optional `text`, `shape`, position/size and colours) and `edges`
(`from`/`to` node ids, optional `text`/`dashed`/`arrowhead`). The server emits a
valid scene — shapes with centred labels, arrows bound to their endpoints, and
the searchable `## Text Elements` mirror. In `append` mode an edge may connect a
new node to an existing shape by the element id reported by `read_excalidraw`.
Omit `x`/`y` to auto-lay-out on a grid.

Both features are gated in the app by `ENABLE_EXCALIDRAW` / `ENABLE_MARP`; the
notes are still created and editable as plain markdown when a feature is off.
Edit an existing drawing/deck through `read_note` + `write_note` (keep the
`.excalidraw.md` scene block or the `marp: true` frontmatter intact).

> **Feature-gating.** At startup the server reads the backend's unauthenticated
> `GET /api/config` and only registers the tools for features mdnest has
> enabled: the `*_task` tools appear only when the task board is on, the Marp
> tools only when Marp is on, and `create_excalidraw` only when Excalidraw is
> on. A notes-only mdnest therefore exposes just the note/tree/search tools. If
> `/api/config` can't be read the server stays permissive and exposes
> everything. (Restart the MCP server after toggling a backend feature.)
