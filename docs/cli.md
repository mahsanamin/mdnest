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

### When login refuses

Every failure names the actual cause and prints a command you can paste as-is.

**"Couldn't reach ... to ask what it calls itself"** — the server never answered,
so nothing about its config is known yet. The message says why (DNS, connection
refused, timeout, TLS) and offers to name the server yourself instead. This is
distinct from the server answering and having no `SERVER_ALIAS` set; only the
latter is a reason to go and edit the server's `mdnest.conf`.

**"'x' is not a URL — an alias needs a leading `@`"** — the most common slip.
Without the `@`, every argument shifts along: your URL is read as the token and
your token is dropped. The fix is printed back with that one character added:

```bash
$ mdnest login work https://work-server:3236 mdnest_abc123
Error: 'work' is not a URL — an alias needs a leading '@'.

Run:
  mdnest login @work https://work-server:3236 mdnest_abc123
```

Nothing is written to disk when login is refused — an unusable URL can never
become your saved default server.

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

The CLI and the server ship from the same repo at the same version number, so
the server you are talking to is the reference point for whether your CLI is
current.

**On a major mismatch** (`4.x` CLI against a `3.x` server, or the reverse) you
get a compatibility warning at login — the two may genuinely disagree about the
API.

**On a same-major mismatch** — your CLI older than the server — you get one
line telling you so, wherever you are already looking at versions
(`mdnest servers`, `mdnest whoami`, `mdnest login`):

```
  Your mdnest CLI is v4.3.1; @work is running v4.3.2.
  Update it with:  mdnest update
```

This exists because nothing pushes CLI updates to you. `mdnest update` is
pull-only, and before v4.3.2 the *only* check was the major-version one — so a
client could sit on a stale (or broken) point release indefinitely with no
signal at all. The notice is deliberately not printed on every command: the CLI
keeps no update cache, and checking on every read would cost a request each
time.

Two things it does not do, on purpose:

- It does not contact GitHub. The version comes from the `/api/config` call the
  CLI already makes, so there is no extra network round-trip and no new failure
  mode. The trade-off is that if **your server** is also out of date, nothing
  tells you — update the server and the CLI notice follows.
- It never nags a pre-release about its own release. `4.3.2-dev` is treated as
  older than `4.3.2` and newer than `4.3.1`, matching the in-app update banner.

### Updating

The app shows this too: **Settings → CLI → Keeping it up to date** names the
version your server is running, so you have something concrete to compare
`mdnest version` against.

```bash
mdnest update                 # self-update from main
mdnest update --force         # re-download even if the version matches
MDNEST_BRANCH=develop mdnest update --force   # track an unreleased build
```

Or reinstall from scratch:

```bash
curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
```

`mdnest update` reads the script straight from the `main` branch on GitHub, so
a CLI fix reaches you as soon as it lands there — independent of the tag and
the GitHub Release, which drive the in-app *server* update banner instead.
