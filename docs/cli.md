# mdnest CLI

The `mdnest` CLI lets you read, write, search, and organize notes from any terminal. Supports multiple servers with `@alias` paths.

## Install

One command, works on macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
```

No dependencies — just bash and curl.

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

Create API tokens in the web UI: Settings → API Tokens.

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
mdnest list                              # namespaces on default server
mdnest list @work                        # namespaces on @work
mdnest list @work/engineering             # files in namespace
```

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
mdnest create engineering/new-doc.md
```

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
mdnest servers                   # list all configured servers + versions
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
