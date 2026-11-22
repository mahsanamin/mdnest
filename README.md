# mdnest

**Your team and your AI agents, working from the same notes.**

Self-hosted Markdown notes. Your team writes and comments in the browser, and
your coding agents read and update the same notes through the CLI or MCP.
Plain files, on your own server.

Stop pasting the same project context into every agent chat and every
teammate's DM.

Try it on your own machine first, then add your team. Requires Docker and
Compose. AI agents are optional; connect your own.

**Install:** see the [Quick Start](https://mdnest.dev/docs/quick-start#1-basic-setup)
(five commands, nothing to clone or build).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/dark-hero-team.webp">
  <img alt="The mdnest app with a team workspace open: a folder tree on the left, a project brief with a plan in the middle, and a teammate's comment beside one highlighted step" src="docs/images/light-hero-team.webp">
</picture>

<sub>A project brief in a team workspace, with a teammate's comment beside it (team setup).</sub>

### How it works

1. A teammate writes a project brief in mdnest.
2. Your connected agent reads the brief and adds a plan to the note, through the `mdnest` CLI.
3. Another teammate reviews the plan and leaves a comment beside it.

Your team and your agent work with the same saved note. Comments need team
setup. Alone, steps 1 and 2 work in the basic install.

### What you get

- 📝 **A real editor.** Markdown turns into rich text as you type, with tables,
  diagrams, math and images. Or switch to plain text.
- 📄 **Plain files.** Every note is a `.md` file in a folder on your server.
  Open it in any editor, `grep` it, or take the folder with you.
- 🤖 **Works with the agent you already use.** Agents use the `mdnest` CLI, or
  the optional MCP server, on the same files you do. mdnest includes no AI
  model and calls no AI service.
- 🔐 **Access per person and folder** *(needs team setup)*. Company sign-in
  through OIDC (Google Workspace, Okta, Microsoft Entra, Keycloak, Auth0),
  roles, groups, read-only or read-write access.
- 💬 **Comments, presence and chats** *(needs team setup for comments and
  presence)*. Comment beside the text, see who is in a note, and talk with
  teammates and agents in a chat that is itself a note.
- 🛟 **Optional git backup.** mdnest commits and pushes a workspace on a
  schedule, and you can browse and restore any note's history in the app.

The full feature list is on [mdnest.dev](https://mdnest.dev).

## Try it on your machine

You need [Docker](https://docs.docker.com/get-docker/) with Compose v2, `curl`
and `openssl`, and port 3236 free. The
[basic setup in the Quick Start](https://mdnest.dev/docs/quick-start#1-basic-setup) is five commands in a
terminal: download one compose file, write two secrets to `.env`, and run
`docker compose up -d`. Nothing to clone or build.

Open [http://localhost:3236](http://localhost:3236) and sign in as `admin`
with the password in `.env`. Your notes are plain `.md` files in `./notes`.
Every optional setting is explained in a comment in
[`docker-compose.yml`](deploy/compose/docker-compose.yml).

For multi-user mode, company sign-in, git backup, HTTPS and remote access, see
the [setup guide](https://mdnest.dev/docs/setup).

## Set it up with an AI agent

A coding agent such as Claude Code or Codex can do the setup for you.

**Just me, on this machine:** use the
[tested prompt in the Quick Start](https://mdnest.dev/docs/quick-start#or-let-your-coding-agent-do-it). The
agent runs the basic setup, and you create the API token and log in yourself,
so it never sees your password or token.

The prompts below are for larger setups. Each one tells the agent to read the
setup guide first and to ask you for anything it would otherwise have to guess.

**My team, with company sign-in**

```text
Set up mdnest (https://github.com/mahsanamin/mdnest) on this server for my team.
Read https://mdnest.dev/docs/setup and https://mdnest.dev/docs/sso-setup first.
Use multi-user mode with PostgreSQL and sign-in through our identity provider.
Ask me which provider we use, for the client ID and client secret, for the address
people will open mdnest at, and for the emails of the admins. Do not guess them.
Keep secrets in .env, not in docker-compose.yml. When it runs, show me how to give
a person or a group access to a workspace.
```

**Back up my notes to git**

```text
My mdnest server runs on this machine. Add git backup for its notes.
Read the "Git Sync" section of https://mdnest.dev/docs/setup first.
Ask me for the git repository to push to, and use a deploy key made for that
repository only, not my personal SSH key. When it is set up, make a change to a
note and show me the commit that reached the repository.
```

**Connect this machine to an existing mdnest server**

```text
Install the mdnest CLI on this machine and connect it to our mdnest server.
Read https://mdnest.dev/docs/cli first. Install it with:
curl -fsSL https://mdnest.dev/install.sh | bash
Ask me for the server address. Then ask me to create an API token in mdnest
(Settings, then API Tokens) and to run mdnest login <address> in my own
terminal. Never ask me for the token. Run mdnest servers -v to check it, then
show me how to read a note and append a line to one.
```

## Connect your agents

Install the CLI on any machine (macOS or Linux) and log in with an API token
from Settings, API Tokens. One machine can hold several servers:

```bash
curl -fsSL https://mdnest.dev/install.sh | bash
mdnest login @work https://notes.example.com mdnest_yourtoken
mdnest read @work/engineering/spec.md
```

The [CLI guide](https://mdnest.dev/docs/cli) has every command. For Claude,
Cursor and other MCP clients, see the [MCP guide](https://mdnest.dev/docs/mcp).

## Documentation

| Guide | What is in it |
|---|---|
| [Setup](https://mdnest.dev/docs/setup) | Install options, every setting, multi-user mode, git backup, remote access |
| [User guide](https://mdnest.dev/docs/user-guide) | Using the app day to day |
| [Company sign-in](https://mdnest.dev/docs/sso-setup) | Google Workspace, Okta, Microsoft Entra, Keycloak, Auth0 |
| [CLI](https://mdnest.dev/docs/cli) | The `mdnest` command for people, scripts and agents |
| [MCP](https://mdnest.dev/docs/mcp) | The optional MCP server for AI clients |
| [Tasks](https://mdnest.dev/docs/tasks) | The optional task board built from your notes |
| [Chat](https://mdnest.dev/docs/chat) | Chats for people and agents, kept as notes |
| [Security](https://mdnest.dev/docs/security) | Threat model, roles and access |
| [Kubernetes](https://mdnest.dev/docs/kubernetes) | The optional Helm chart |
| [API](https://mdnest.dev/docs/api) | The REST API |
| [Changelog](https://mdnest.dev/docs/changelog) | What changed in each release |

The same guides are in [`docs/`](docs/) in this repository.

## License

MIT. See [LICENSE](LICENSE).
