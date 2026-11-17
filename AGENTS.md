# mdnest: guide for AI coding agents

This is the one source of instructions for every agent working in this repo
(Claude Code, Codex, Gemini CLI and others). `CLAUDE.md` and `GEMINI.md` only
point here. Keep this file short: it loads in every session. Area rules live in
the `AGENTS.md` of that folder, and the long explanations live in `docs/dev/`.

## What mdnest is

A self-hosted Markdown knowledge base for teams and their AI agents. Notes are
plain files on disk. It runs in Docker, in single-user mode (no database) or
multi-user mode (PostgreSQL for users and permissions only).

| Folder / file | What it is | Read before changing it |
|---|---|---|
| `backend/` | Go server, standard library `net/http`, pgx for Postgres | `backend/AGENTS.md` |
| `frontend/` | React + Vite, Milkdown Crepe live editor | `frontend/AGENTS.md` |
| `mcp-server/` | Node MCP server over the REST API | `mcp-server/AGENTS.md` |
| `tests/` | shell, end-to-end and Playwright suites | `tests/AGENTS.md` |
| `deploy/`, `setup.sh`, `mdnest.conf.sample`, Dockerfiles | install, compose, Helm chart | `deploy/AGENTS.md` |
| `mdnest`, `mdnest-server` | client CLI and server CLI (bash) | `docs/dev/cli.md` |
| `docs/` | user docs; `docs/codemap.md` is the file-by-file map with the traps of each file | the codemap entries for the files you touch |

Some tools load a folder's `AGENTS.md` on their own, some do not. Either way,
read it before you edit files in that folder.

## Who you are working for

**An outside contributor (the usual case).** Work in your fork. Branch from the
latest `develop`, never from `main`. Open the pull request against `develop`
(GitHub suggests `main` by default, change it). Do not bump versions, edit
`CHANGELOG.md` release sections, tag or release: the maintainer does that.
Paths like `@srv-ahsan-mini/...` in the skills are the maintainer's private
notes server; skip any step that needs them.

**The maintainer.** The skills below also cover the maintainer-only steps
(merging into `develop` directly, the private backlog, releasing).

## Skills: use them for the recurring workflows

The skills live in `.agents/skills/<name>/SKILL.md` (`.claude/skills` is a link
to the same folder). When a request matches one, follow the skill, even if the
user asked in their own words. If your tool cannot run skills, open the
`SKILL.md` and follow it by hand.

| The task | Skill | Who |
|---|---|---|
| Add a feature or improvement | `md-add-improvement` | everyone |
| Fix a bug | `md-fix-bugs` | everyone |
| Work on a GitHub issue end to end | `md-issue-process` | everyone (reply/close steps: maintainer) |
| Review a contributor's pull request | `md-review-collab` | maintainer |
| Release, docs, website, version bump | `md-ship` | maintainer |

## Rules for every change

- **Keep the core lean.** A new feature must cost nothing to an install that does
  not use it: off by default behind a flag, no new required dependency, no new
  failure mode. Check `go.mod`, `package.json`, the gzipped bundle size, and
  whether `setup.sh`, `mdnest.conf.sample`, the Dockerfiles or `nginx.conf`
  changed.
- **Do not change what mdnest is without asking first.** Files are the source of
  truth for notes, namespaces come from mounted folders (never created at
  runtime), and single mode has no database. A change to any of these is a
  maintainer decision made before the code. Never remove something users rely
  on, and never narrow what a superadmin can do by default.
- **Solve only mdnest's part of a problem**, with the smallest change that fixes
  what the user sees. Do not over-engineer.
- **A config option must not exist before the code behind it.** The backend
  ignores env it does not read, so a knob with no code silently does nothing.
- **Security:** every file path goes through `SafePath()` and namespaces through
  `RequireNamespace()`; rendered HTML/SVG goes through `frontend/src/sanitize.js`;
  no hardcoded paths, credentials or secrets.
- **Every bug fix adds a test** at the layer that would have caught it, shown
  failing without the fix.
- **Public text** (README, `docs/`, CHANGELOG, release notes) follows
  [WRITING.md](https://github.com/mahsanamin/mdnest-website/blob/main/WRITING.md):
  plain English, no em or en dashes, no marketing words, promise only what the
  released code does, and label features the basic install does not turn on
  ("Optional" or "Needs team setup"). Do not change the pitch or the audience
  on your own; the long version is "Public wording" in `docs/dev/release.md`.
- **Commits:** clear messages in the repo's style, no AI co-author trailer or
  "Generated with" footer.
- **When you add, move or remove a file**, update `docs/codemap.md`. When you learn
  a trap worth keeping, put it on that file's line in the codemap or in the
  folder's notes in `docs/dev/`, not in this file.

## Testing

Run the level that fits the step (`bash tests/check.sh --level <level>`):

| Level | When | Rough time |
|---|---|---|
| `iterate` | while working; only what you changed, plus the browser specs you name in `MDNEST_E2E_SPECS` | under 5 min |
| `develop` | before opening the PR (or before the maintainer merges into `develop`) | 15 to 20 min |
| `ship` | release only (maintainer) | as long as it takes |

Needs Docker; the browser suites also need Node. If a suite cannot run on your
machine, say so in the PR instead of claiming it passed. Details:
`tests/AGENTS.md`.

## Debugging

- Read the error literally. "expected 12 not 11" means count your Scan args, not
  blame the Docker cache.
- Do not blame something external (cache, stale binary) without evidence.
- After two failed attempts, stop guessing and look at the real data: the running
  server's API, exact bytes (`python3 -c "print(repr(x))"`), `docker ps`.
- Ports and credentials come from `mdnest.conf` and `.env`, never from a guess.

## Where the long versions live

- `docs/codemap.md`: every file, what it does, its traps.
- `docs/dev/backend.md`, `docs/dev/frontend.md`, `docs/dev/cli.md`,
  `docs/dev/testing.md`: the full conventions behind each folder's `AGENTS.md`.
- `docs/dev/release.md`: release process, version scheme, branch protection and
  the security gate on `main` (maintainer).
- `docs/architecture.md`, `docs/api.md`, `docs/security.md`, `docs/setup.md`:
  how the system works.
