# mdnest CLI

The `mdnest` CLI lets you read, write, search, and organize notes from any terminal. Supports multiple servers with `@alias` paths.

## Install

One command, works on macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
```

**No dependencies — just bash and curl.** `python3`/`jq` are used when present (for prettier JSON), but the CLI falls back to pure-bash/awk so every command works without them. The installer downloads to a temp file and installs atomically (using `sudo` only if `/usr/local/bin` isn't writable, and falling back to `~/.local/bin` with a PATH hint if it can't) — so it never leaves a half-written binary or aborts mid-download on a fresh machine.

### Install from a specific branch

To try an unreleased build, point at that branch's installer and set `MDNEST_BRANCH`:

```bash
curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/develop/install-cli.sh | MDNEST_BRANCH=develop bash
```

`mdnest update` honours the same `MDNEST_BRANCH` (default `main`), so you can stay on a branch:

```bash
MDNEST_BRANCH=develop mdnest update --force
```

## Login

Every server you log into gets a short **alias** (`@work`, `@home`, etc). The alias appears in your paths (`@work/engineering/README.md`) and in copy-path URIs from the web UI.

### Pick the alias yourself

```bash
mdnest login @work     https://work-server:3236  <token>
mdnest login @personal https://home-server:3236  <token>
```

### Let the CLI use the server's own `SERVER_ALIAS`

If the server has `SERVER_ALIAS=work` set in its `mdnest.conf`, the CLI can pick that up automatically:

```bash
mdnest login https://work-server:3236 <token>
# → Logged in to @work (https://work-server:3236) (SERVER_ALIAS from /api/config)
```

If the server doesn't advertise a `SERVER_ALIAS`, the CLI refuses — you'll be told to either pass `@alias` explicitly or configure `SERVER_ALIAS` on the server. (There is no more silent `@default` — that hid which server was which.)

### Rename an existing alias

If you have an older `@default` alias from a previous CLI version, rename it:

```bash
mdnest rename @default @work
```

Create API tokens in the web UI: Settings → API Tokens. Tokens work regardless of how the server authenticates users (local password, SSO, Firebase) — the token authenticates *you* directly, no IdP round-trip.

API tokens inherit your current access at request time (v3.5.0+). If you're a SuperAdmin, your token has SuperAdmin scope. If you're a namespace admin of `growth`, your token can read/write within `growth` only. If your access is revoked or your namespace-admin row is removed, your token loses that access immediately on the next request.

## Path format

Every command uses a unified path:

```
@server/namespace/path/to/file.md
```

- **@server** — server alias (optional if only one server configured)
- **namespace** — workspace name on that server
- **path** — file or folder path within the namespace

The same format is used when you right-click → Copy Path in the web UI.

## Commands

### List namespaces or files

```bash
mdnest list                              # namespaces on default server (one per line)
mdnest list @work                        # namespaces on @work
mdnest list @work/engineering             # files in namespace, as a tree
mdnest list @work/engineering/Architecture  # scoped to one folder
mdnest list --json @work/engineering      # raw API JSON, for scripts
```

A namespace listing is rendered as a tree with a count at the end:

```
engineering
├── Architecture/
│   ├── system-overview.md
│   └── decisions/
│       └── 001-storage.md
└── README.md

2 folders, 3 files
```

Pass `--json` (or set `MDNEST_JSON=1`) to get the raw `/api/tree` payload
instead — the shape scripts were parsing before the tree rendering existed.

### Read a note

```bash
mdnest read @work/engineering/Architecture/system-overview.md
mdnest read engineering/docs/api.md      # single server (no @)
```

### Write (overwrite) a note

```bash
mdnest write @work/engineering/log.md "New content"
mdnest write @work/engineering/draft.md -    # read from stdin
echo "piped" | mdnest write engineering/draft.md -
```

### Create a new note

```bash
mdnest create @work/engineering/new-doc.md "# Title"
echo "# Title" | mdnest create @work/engineering/new-doc.md -   # read from stdin
```

`create` takes content the same way as `write`/`append`: an inline string, or
`-` to read from stdin. It exits non-zero if no content is supplied (rather than
silently creating an empty file), and fails if the note already exists — use
`write` to overwrite an existing note.

### Append / Prepend

```bash
mdnest append @work/engineering/log.md "## $(date) - Meeting notes"
mdnest prepend @work/engineering/log.md "Important update"
echo "from pipe" | mdnest append engineering/log.md -
```

### Delete

```bash
mdnest delete @work/engineering/old-doc.md
```

### Move / Rename

```bash
mdnest move @work/engineering/old-name.md new-name.md
```

### Search

```bash
mdnest search @work/engineering "database"
mdnest search engineering "meeting"
```

## Server management

```bash
mdnest servers                   # list servers + version (and build commit, e.g. 3.11.0 (a1b2c3d))
mdnest servers -v                # also list namespaces per server
mdnest whoami                    # CLI version + all servers
mdnest logout @work              # remove one server
mdnest logout                    # remove all
mdnest rename @old @new          # rename a server alias (updates the default pointer too)
```

## Legacy commands (backward compatible)

The old `mdnest note <action> <namespace> <path>` format still works:

```bash
mdnest note list
mdnest note read engineering Architecture/system-overview.md
mdnest note append engineering log.md "text"
```

## Configuration

Server configs are stored in `~/.config/mdnest/servers/`. Each server has its own file.

To set the server alias that appears in Copy Path from the web UI, add to `mdnest.conf`:

```
SERVER_ALIAS=work
```

This makes Copy Path produce `@work/namespace/path` which the CLI can use directly.

## Version compatibility

The CLI checks the server version on login. If major versions don't match, you'll see a warning. Update with:

```bash
curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
```
