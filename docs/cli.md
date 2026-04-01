# mdnest CLI

The `mdnest` CLI lets you read, write, search, and organize notes from any terminal. Supports multiple servers with `@alias` paths.

## Install

One command, works on macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
```

No dependencies — just bash and curl.

## Login

### Single server

```bash
mdnest login https://myserver:3236 <api-token>
```

### Multiple servers

```bash
mdnest login @work https://work-server:3236 <token>
mdnest login @personal https://home-server:3236 <token>
```

Create API tokens in the web UI: Settings > API Tokens.

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
mdnest whoami                    # CLI version + all servers
mdnest logout @work              # remove one server
mdnest logout                    # remove all
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
