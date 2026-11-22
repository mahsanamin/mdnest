---
name: mdnest
description: Use for any work with mdnest notes through the mdnest CLI. That covers reading, creating, writing, editing, appending, moving, listing or searching notes on an mdnest server, opening an mdnest:// link or an @alias/namespace/path.md path, and reading or posting in mdnest chats and crews. Use it whenever the user mentions mdnest or their mdnest notes, pastes an mdnest link, or asks to save something to their notes when mdnest is the notes tool.
---

# mdnest

Before you run any `mdnest` command in this session, run:

```bash
mdnest docs agents
```

Read what it prints and follow it. The guide ships with the installed CLI, so
it always matches the version you are using. Do not rely on what you remember
from an older guide.

If the `mdnest` command is not found, tell the user to install the CLI:
`curl -fsSL https://mdnest.dev/install.sh | bash`. If `mdnest docs agents`
prints the general help instead of the guide, the CLI is older than 4.8.17:
ask the user to run `mdnest update`.
