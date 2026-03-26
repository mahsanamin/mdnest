# mdnest CLI

mdnest is a personal markdown notes system. Notes are plain `.md` files organized in namespaces. The `mdnest` CLI lets you read, write, search, and organize notes from the terminal.

## Setup

```bash
mdnest login <server-url> <api-token>
```

## Commands

### List namespaces or files

```bash
mdnest note list                          # list all namespaces
mdnest note list <namespace>              # list files in a namespace
```

### Read a note

```bash
mdnest note read <namespace> <path>
```

### Write (overwrite) a note

```bash
mdnest note write <namespace> <path> "content"
mdnest note write <namespace> <path> -    # read from stdin
```

### Create a new note

```bash
mdnest note create <namespace> <path> ["initial content"]
```

### Append to a note

```bash
mdnest note append <namespace> <path> "text to add at the end"
mdnest note append <namespace> <path> -   # read from stdin
```

### Prepend to a note

```bash
mdnest note prepend <namespace> <path> "text to add at the top"
```

### Delete a note or folder

```bash
mdnest note delete <namespace> <path>
```

### Move or rename

```bash
mdnest note move <namespace> <old-path> <new-path>
```

### Search

```bash
mdnest note search <namespace> "query"
```

## Other commands

```bash
mdnest login <url> <token>     # authenticate
mdnest logout                  # remove credentials
mdnest whoami                  # show server and token
```

## Notes

- Namespace = a top-level directory on the server (e.g. `personal`, `work`)
- Paths are relative within the namespace (e.g. `ideas/project.md`)
- Append/prepend create the file if it doesn't exist
- Write with `-` reads content from stdin, useful for piping
