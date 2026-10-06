# Changelog

All notable changes to mdnest are documented here.

---

## Unreleased

### Added

- **Role templates in Connect an agent.** Main Leader, Spec Expert, Analyzer,
  Lead Coder, Coder, Lead QA and QA. Picking one fills a suggested name and a
  one-line trait (both editable) that goes into the prompt. Lead Coder and
  Lead QA start helper agents as their own sub-agents, who join the same chat
  and leave when their lead says they are done; the prompt now says when an
  agent may leave.
- **Twelve more reaction images**: question, heart, laugh, clap, fire, rocket,
  bug, idea, warning, sad, thanks and hourglass, animated like the first
  eight. `question` is the signal an agent posts when it is waiting for a
  human, so you can see where you are needed.
- **A shorter, clearer Connect an agent prompt.** Three parts (Join, Loop, How
  to behave). It tells the agent to read the chat once, which saves its
  place, and then only wait for what is new instead of re-reading the whole
  chat; to set a working status before longer work; to ask a human with
  `@name` plus the question image; to answer only what is addressed to it or
  is its part and not repeat what another agent already said; and that emoji
  and reaction images are fine.
- **See what agents in a chat are doing, with no CLI update.** The chat
  window shows one quiet line above the message box: "codxu is working:
  reviewing the PR · 3 min", "codxu is thinking", "lead-qa and qa-1 are
  listening". Listening and thinking are worked out by the server from the
  polls every `mdnest chat wait --as NAME` already makes (any CLI since chat
  shipped, and MCP `wait_chat`): polling means listening, and a poll that
  delivered new messages means thinking until the agent posts. An agent says
  what it is working on by posting `/status reviewing the PR` with the
  ordinary `chat post`; the server handles it and never adds it to the chat.
  Agent behaviours are built this way on purpose, inferred from existing
  calls or a slash command in a post, so new ones need no CLI update. The
  line keeps its height so the conversation never jumps, your own presence is
  not shown back to you, and `chat read` lists who is busy. In memory only;
  a status lasts 2 minutes unless repeated, and the agent's next post clears
  it. Also `POST /api/chat/status`, `mdnest chat status` and the MCP tool
  `set_chat_status`.
- **Search in Move to… and Copy to….** The folder picker has a search box,
  focused when it opens. Every word you type must appear in the folder's
  path, so `proj api` finds `Projects/backend/api`. Results show their full
  path, exact names come first, and Enter picks the top match. Finding a
  destination no longer means scrolling a long tree.
- **Connect an agent: say what the agent is for.** Under the agent's name
  there is now a box for what it should do in this chat. The text goes into
  the prompt as "Your job in this chat", the same way the name does, so the
  agent starts with its task instead of asking for one. The panel also has a
  close button, and Esc closes it.
- **Agents get a thumbnail nobody else has.** `mdnest chat avatar --pick auto`
  takes the first built-in avatar that no one else in the workspace is
  wearing (and shares one, saying so, only when all are taken). The agent
  prompt now uses it, so several agents in one chat no longer all show up as
  the robot. The MCP tool `set_chat_avatar` takes `pick: "auto"` too.
  `tests/cli-chat-avatar-auto.sh` and `mcp-server/test_avatar.mjs` pin it.

### Changed

- **The right-click menu is arranged in groups.** It shows the item's name at
  the top, then: create (New note, folder, drawing, chat, Paste here), organize
  (Rename, Move to…, Copy to…), share (Download, Copy for another mdnest, Copy
  path for CLI), info (History, Authors), admin (Manage access), and Delete last on its
  own in red. Every item has an icon. Before, Delete sat in the middle of the
  file menu and the copy actions were split up. Authors is now offered only in
  multi-user mode, where it works, and "Make it a chat" is gone: a chat is made
  with New chat. "Copy path" is now "Copy path for CLI": it copies an
  `mdnest://` address for the CLI and agents, which the old name did not say.
  The order is pinned in `contextMenuItems.test.js`.

### Fixed

- **No more false "modified by another user" warnings, and no lost last
  words.** Two autosaves could overlap on a slow link: the second left before
  the first returned, with the same version, and the server rejected it. On a
  remote server every second save failed, the warning appeared with nobody
  else editing, and when the last save was the rejected one the final words
  never reached the server. Saves now run one at a time, and a rejected save
  first checks whether the server already holds the same text before warning.
- **The conflict and restore notices float in the corner.** They used to be
  a row above the editor that pushed the whole document down when they
  appeared. Pinned in `tests/browser/autosave-conflict.spec.js`.
- **Selecting text with comments on no longer makes the note flicker.** On a
  server with live collaboration, selecting shows a Comment button. It was
  positioned by adding the editor's scroll offset to a box that does not
  scroll, so in a scrolled note it landed far below the screen. That box then
  grew a scrollbar, the editor lost about 8 px of width and every line
  rewrapped, then snapped back when the button went away. The button now sits
  just under the selection, moves with the text as you scroll, and the box
  around the editor can no longer scroll. Found with the reporter's own
  console trace; pinned in `tests/browser/live-select-scroll.spec.js`.
- **Typing in a chat is fast again.** Every keystroke re-rendered every
  message in the conversation (markdown and sanitizing), so a long chat
  lagged: about 66 ms a key with 300 messages. The conversation now renders
  only when its messages change, and a key paints in one frame.
- **Grammar-checking extensions stay off mdnest's editors.** The Live and
  Basic editors, the chat box, comments, Mermaid source, stickies and task
  notes carry the attributes Grammarly and similar tools honour, so their
  overlays no longer sit on top of the editing surface. The browser's own
  spell-check is unaffected.
- **Selecting text in the Live editor no longer moves it or adds empty space
  under the note.** Crepe hides its block handle (the "+" and grip beside
  each block) by making it transparent, but leaves it parked where it makes
  the scroll area about 52 px taller. As the handle hid and showed (a
  selection, the next click) the scroll area grew and shrank, and on a note
  that just fitted a scrollbar came and went, so every line rewrapped. A
  hidden handle now takes no space, and the editor keeps room for its
  scrollbar so the text width never changes. Pinned in
  `tests/browser/live-select-scroll.spec.js`, which turns on real scrollbars.
- **Right-click works on a chat in the chat list.** It opened the browser's
  own menu; it now shows mdnest's, with Open as note, Copy path for CLI and
  Delete chat. Deleting a chat from the list no longer closes a different
  chat you have open.
- **A roomier chat message box.** The composer is one box in the style of
  Slack: the text area spans the full width and grows with what you type,
  wrapped lines included (it used to grow only on Shift+Enter, so a long
  message scrolled out of sight), and the posting name, GIF and Send sit in
  a bar inside it. Message text is a little larger with more line spacing.
- **The chat's GIF picker shows its images whole.** In a short window the
  picker was squashed to a thin strip that cut every image in half; the
  message list now gives up the room instead. Pinned in `chat.spec.js`.
- **Mermaid labels keep their colour when you zoom or open full screen.** A
  label on a dark node (white text in light mode) turned dark-on-dark after a
  zoom click, and always in the full-screen viewer. The colours are now
  re-applied after every redraw, and the viewer's sanitized copy, whose label
  wrappers are stripped, is coloured too. Edge labels keep the normal ink.
  Pinned in `tests/browser/mermaid-zoom-color.spec.js`.
- **`mdnest chat wait` no longer stops listening after one failed poll.** A
  dropped connection, an empty reply, a timeout or a proxy's 502/503/504
  (what a server restart looks like from the client) used to exit 1 at once,
  so an agent waiting on a chat silently stopped hearing it. `wait` now
  retries those with a growing pause (up to 30 s) until `--timeout`, says
  when it starts retrying and when the server is back, and exits 1 only on a
  real error (401, 404, bad host) or a server that stays down. Other commands
  keep their exit codes. `tests/cli-chat-wait-retry.sh` pins it against a
  fake backend and runs in the pre-push hook.
- **The ⋯ menu (and Settings in it) stays in the top-right corner.** A long
  note name, a wider sidebar or the stickies panel made the toolbar wrap, and
  the ⋯ menu dropped to a second or third row on the left, so Settings seemed
  to disappear on some screen sizes. The note path now has a fixed starting
  width and shortens with "…" instead of wrapping the row, and the ⋯ menu
  keeps to the right edge on any row it does wrap onto. Pinned in
  `tests/browser/toolbar-fit.spec.js`.
- **Selecting text in the Live editor no longer sets the gutter handle
  sliding.** The "+" and drag handle beside each block follows the mouse and
  animates there, so during a drag selection it glided up and down next to the
  selected text, which looked like the text was jumping. It is now hidden
  while the mouse button is held for a selection and comes back on the next
  hover. Dragging a block by its handle is unchanged. Pinned in
  `tests/browser/live-select-handle.spec.js`.

---

## v4.7.0 — Move, copy and download across workspaces

Move and copy notes and folders between namespaces, download a file or a
whole folder, and carry a note from one mdnest server to another
(issue #114).

### Added

- **Move to… / Copy to… another namespace.** The tree's right-click menu
  (long-press on a phone) opens one picker for a namespace, a folder and a
  name. Each choice is checked with the server (a dry run) before Confirm is
  enabled, so a name that is already taken, a missing right or an oversized
  folder shows up while choosing.
  - Nothing is ever overwritten.
  - A move keeps each note's identity, so its comments travel with it. A
    copy starts fresh, with no comments.
  - Between namespaces, the original is removed only after the copy has been
    verified.
  - The editor follows a moved open note.
  - **+ New folder** in the picker. The folder is created on confirm, so
    cancelling leaves nothing behind.
  - For a folder, the picker says how much will move ("37 files, 12 MB")
    before you confirm, warns when it is large, and shows the elapsed time
    while it runs.
- **Download / Download as zip.** A file downloads as itself and a folder as
  a zip that keeps its folders. Hidden files and empty folders are included;
  `.git`, `.mdnest` and symbolic links are left out. Folders over the limits
  are refused up front with the real counts, and a running download can be
  cancelled.
- **Copy for another mdnest / Paste here.** Puts one note on the clipboard
  as a small payload that any mdnest's **Paste here** turns into a note,
  even on another server.
  - It works over plain HTTP; paste only ever reads a real paste event.
  - It is limited to 1 MB of UTF-8, with a Download hint above that.
  - You are warned about linked images and attachments that do not travel.
  - A name that is already taken is offered as "(copy)", never applied
    silently.
- **API:**
  - `POST /api/transfer` (`mode` move|copy, `?dryRun=1`) and
    `GET /api/download`.
  - `GET /api/namespaces?detail=1` (`canRead`/`canWrite` at each root); the
    plain form is unchanged.
- **MCP:** `move_item` takes an optional `targetNamespace`, and there is a
  new `copy_item`.
- **CLI:** `mdnest move` accepts another namespace (`@alias/ns/path` or
  `--to-ns`), plus new `mdnest copy` and `mdnest download`.
- **Config:** `DOWNLOAD_MAX_FILES` (500), `DOWNLOAD_MAX_MB` (100) and
  `DOWNLOAD_MAX_CONCURRENT` (2 zip downloads server-wide, one per user), in
  `mdnest.conf`, the plain compose file and the Helm chart (`download.*`).

### Changed

- **An autosave that finds its note gone** (moved or deleted elsewhere) shows
  a banner with "Copy my text" instead of failing silently. It never
  re-creates the note at the old path.

### Security

- Download is guarded by path-scoped read (like reading a note), not by
  namespace access, so a grant on one folder cannot zip another. Transfer
  checks both namespaces in the handler before writing anything.
- Download and transfer go through the v4.6.2 checks, which authorise a
  symbolic link for the file it reaches and refuse `.git`/`.mdnest` paths. A
  zip leaves links out, and a transfer refuses a folder that holds one.
- Commit-body annotations cannot carry a newline, so a file name cannot forge
  a commit trailer.
- A move never writes into a comment thread that already exists at the
  destination, and carries only valid comment lines.
- Folder downloads and transfers stop counting once past a limit, and each
  takes a concurrency slot (dry runs excepted), so neither can be used to
  make the server walk a huge tree over and over.

---

## v4.6.3 — Security release: saving a note can no longer tie up the server

A security release. **Upgrading is recommended for every install.**

### Security

- **A few requests could keep the server's CPU busy for minutes.** *Who is
  affected:* any install where someone you do not fully trust can write
  notes, through the web app, the CLI, the MCP server or an API token, in
  either auth mode. When a note is created, saved, appended to, prepended
  to, or posted to as a chat, mdnest removes its own hidden note-ID lines
  from the incoming text. That cleanup took time that grew with the square
  of the input, so one large, specially shaped request could occupy a CPU
  core for many minutes, and a handful of them could make the server
  unresponsive for everyone. No note is read, changed or exposed by this:
  the effect is slowness only, and it ends when those requests finish. The
  cleanup now runs in one pass, in time proportional to the size of the
  note, with the same result as before. A regression test checks that the
  result is unchanged and that four times the input costs about four times
  the time.

---

## v4.6.2 — Security release: protect repository internals, enforce 2FA and folder grants

A security release. **Upgrade every install now.** The first fix applies
to every install, in both single-user and multi-user mode. The rest apply
to multi-user installs (`AUTH_MODE=multi`), each with the setup it affects
named below.

### Security

- **A user who could edit notes could run commands on the server.** *Who
  is affected:* every install, in either auth mode. The risk is highest when
  git runs inside a namespace (git-sync, or `STORAGE_BACKEND=git`). The notes
  API accepted paths inside a namespace's `.git` folder, so anyone with
  write access could change the repository's configuration. Git runs
  commands named there the next time it touches the tree, and mdnest's
  background commit and the git-sync sidecar both do that, so a writer
  could run commands in the backend or git-sync container. Anyone with
  read access could also read `.git/config`, which can hold the remote's
  credentials. Every request path is now refused if any folder in it is
  `.git` or `.mdnest` (mdnest's own comment and board data), whatever the
  case or spelling tricks a filesystem may ignore. This applies to notes,
  files, uploads (the folder and the file name), folders, moves, history,
  comments, tasks, chat and live collaboration. A symbolic link is held to
  the same rule by what it points at, and the storage layer refuses anything
  that reaches `.git` or leaves the namespace on its own, as a second layer.
  **After upgrading:** check
  each namespace's `.git/config` and `.git/hooks` for entries you did not
  add (for example `fsmonitor`, `hooksPath` or `sshCommand`). Rotate any
  git remote credentials stored in `.git/config`, because a reader could
  have seen them.
- **Two-factor sign-in could be skipped with the password alone.** *Who is
  affected:* multi-user installs where people use TOTP two-factor
  sign-in, or where an admin forces a password change. After the password
  is accepted, the server hands out a short-lived token for the next step.
  That token was accepted as a full session by every API, so the second
  factor never stopped anyone. The same step token could also enrol a new
  authenticator over the old one, or change the password without the code.
  Step tokens now work only at the one endpoint for their own step. A
  forced password change on an install that requires 2FA now leads to 2FA
  setup instead of straight into the app.
- **Folder grants did not cover every endpoint.** *Who is affected:*
  multi-user installs that give people access to a folder rather than a
  whole namespace (per-user or group grants). Several endpoints checked
  only that a user had some access to the namespace. Search returned notes
  and snippets from other folders. The global task board listed their
  tasks. Comments, note history (including a note's full content at any
  past version) and edit attribution were served for any note, and anyone
  with write on one note could replace the task board's columns for the
  whole namespace. Each one now checks the right path, and listings filter
  every result.
- **Symbolic links could carry access across a folder grant.** *Who is
  affected:* the same multi-user installs, where a namespace contains
  symlinks (they arrive through git-sync, git storage or edits on the
  host; mdnest never creates them). A link inside a granted folder that
  pointed into another folder let a user read, and with write access
  overwrite, the file behind it, and a link out of the namespace could
  show another namespace's file in search results. A link is now checked
  for the file it reaches as well as its own name, and a link that leaves
  the namespace is never followed. Links that stay inside what you may
  read keep working. On the multi-replica app tier, linked paths are not
  served at all.
- **Live collaboration had no access check.** *Who is affected:* multi-user
  installs with `ENABLE_LIVE_COLLAB=true`. Anyone signed in could join any
  note's live session, see the text other people were typing, and push
  text into their editors. Joining now needs read access to the note, and
  only users with write access can send edits or cursor positions.
- **An API token without an owner had full access.** *Who is affected:*
  multi-user installs that were once single-user installs and still have
  an API token created back then. After the switch, such a token reached
  the server as no user at all, which the permission layer treated as
  single-user mode (everything allowed). It is now refused. Create a new
  token under **Settings → API Tokens**, which ties it to your account.
- **A note could take another note's comment thread.** *Who is affected:*
  multi-user installs with live collaboration (comments). A note's hidden
  ID marker decides which comments belong to it. Creating a note, or
  adding text to the start or end of one, kept an ID marker included in
  the text, so a writer who knew another note's ID could read and post in
  that note's thread. Incoming markers are now removed on every write path
  (create, edit, append, chat post), and a note keeps exactly its own ID. A
  forced-password-change step can also be used only once.
- **Git sync status no longer shows the remote's credentials, or other
  workspaces.** *Who is affected:* multi-user installs with git-sync. Any
  signed-in user could read any namespace's sync status, including a
  remote URL that may contain a token. The status now needs access to
  that namespace, and credentials are removed from the URL it shows.
- **Smaller fixes.** File names and display names are kept to one line in
  git commit messages, so a crafted name cannot add a line such as a
  `Co-authored-by` trailer. A namespace admin no longer sees the full file
  tree of a different namespace where they only have a folder grant.

### Upgrading

Nothing to configure. Single-user installs behave exactly as before,
apart from the `.git`/`.mdnest` path rule.

---

## v4.6.1 — Rebuild works after leaving Docker Desktop

### Fixed

- **`./mdnest-server rebuild` (and `start`, `update`, `reload`) no longer
  fails with `error getting credentials … docker-credential-desktop:
  executable file not found in $PATH`.** Docker asks the credential helper
  named in `~/.docker/config.json` before every image pull, and a helper that
  isn't installed is a hard error. The usual cause is `"credsStore":
  "desktop"` left behind after moving from Docker Desktop to Colima or
  OrbStack. Nothing in mdnest changed, but the build broke anyway.
  `mdnest-server` now spots a missing helper (`credsStore` or any
  `credHelpers` entry), warns once naming the entry to remove, and pulls
  anonymously for that run. Your Docker config is never modified. See
  *Troubleshooting* in `docs/setup.md`.

---

## v4.6.0 — Chat: people and agents in one room

Any note can now be a chat room, where you, your team and your AI agents
plan and hand off work together. Claude Code, Codex, or any agent with a
shell or MCP joins from the terminal, and the room stays a plain Markdown
file that search, git-sync and any text editor treat like any other note. Chat is on by default and works in
single-user mode too.

### Added

- **File-based chat**, on by default in single and multi mode
  (`ENABLE_CHAT=false` turns it off; the multi-replica app role keeps it off
  unless set to true). Any note becomes a chat
  channel with one frontmatter tag, `mdnest-chat: true`. Messages are appended
  to the note as plain markdown (`#### author · time`), so the chat is an
  ordinary file: no database, no sidecar, no index. **Chats** in the toolbar
  lists the chats in the current workspace, with unread counts. You can
  create a chat, convert a note into one (right-click → **Make it a chat**),
  and talk in a familiar chat window.
- **Agents can talk to each other, and to you.** There are new CLI commands,
  `mdnest chat new|post|read|wait|list`. `wait --after N` blocks until someone
  replies, which is what lets two Claude sessions hold a conversation. The MCP
  server adds `list_chats`, `create_chat`, `read_chat`, `post_chat` and
  `wait_chat`. In multi mode `--as` is only a label: a post from an agent on
  your token reads `claude-api (via you)`.

- **@mentions, and agents that stay in the conversation.** `@name` (or
  `@all`) addresses someone. Mentions are highlighted, and typing `@` offers
  the people in the chat. `mdnest chat wait --as NAME` remembers where NAME
  left off and never returns NAME's own posts, so an agent loop is just
  wait → post → wait. `--mentions` wakes only for `@NAME`. **Connect an
  agent** gives a ready-to-paste prompt: one name, read the whole
  conversation first, and keep looping.
- **Chat images.** An animated reaction set ships with mdnest (nod,
  thumbs-up, wave, thinking, celebrate, eyes, done, oops). Post one by name
  with `![nod](gif:nod)`, or use the **GIF** button. Each workspace can add
  or override images in its own `ChatGifs/` folder, and `avatar-NAME.svg`
  there is shown beside NAME's messages. Agents can make animated SVGs.
  `mdnest chat gifs` and MCP `list_chat_gifs` list what is available.
- **A thumbnail for everyone in a chat.** Without an avatar, a poster shows
  their initial in their name colour. Six animated avatars ship with mdnest
  (robot, owl, cat, alien, ghost, fox). `mdnest chat avatar --as NAME
  --pick owl` (or `--file my.svg`, or MCP `set_chat_avatar`) sets one, and
  the agent prompt makes it a numbered step, because agents skipped it
  when it said "optional".

### Changed

- **A tidier toolbar.** Theme, Settings and Manage users move into a ⋯ menu
  at the top right, on every screen size. The Chats, Board and Stickies
  buttons have distinct icons, and the toolbar no longer overflows at
  narrow widths. On a phone the ⋯ menu also holds the file actions and
  Basic / Live / Preview, and the task board's header fits on one screen.
- **The Stickies button no longer shows a count.**
- **The sidebar footer stays on one line**, truncating a long host name.

### Security

- **Agent avatars and reaction images are served inert.** They are SVG, so
  the built-in set (`/api/chat/gifs/builtin/`) is served with the same
  `nosniff` and sandboxing `Content-Security-Policy` that v4.5.5 added to
  `/api/files/`, which covers a workspace's own `ChatGifs/`. Chat labels are
  stripped of control and bidi characters, and a body line that looks like a
  message header is escaped, so nobody can forge another poster's message.

### Fixed

- **Concurrent appends no longer lose text.** `PATCH /api/note` (append and
  prepend) read the note, added the text and wrote it back with no lock, so two
  writers racing (two agents, or `mdnest append` against a web-UI save) could
  silently drop one. Appends, chat posts and the `If-Match` check on `PUT` now
  run under a per-note lock. A regression test fails without the lock: 40
  concurrent posts kept 2.

---

## v4.5.5 — Path-scoped grants hold

A security release. The main fix is for **multi-user installs**
(`AUTH_MODE=multi`) that give people access to part of a namespace: a grant
on a folder rather than the whole namespace. Single-user installs have no
grants and are not affected by that one. A second fix, for how uploaded
files are served, applies to **every install**. Upgrading is recommended
for everyone.

### Security

- **A request could reach notes outside a folder grant.** The permission
  check looked at the path exactly as the client sent it, while the server
  then acted on the cleaned-up path. A path that entered a granted folder
  and then stepped back out of it with `..` passed the check, so someone
  granted one folder could read, change or delete notes elsewhere in the
  same namespace. The check now runs on the same cleaned path the server
  acts on, and a path that cannot be cleaned (absolute, or leaving the
  namespace) is refused. Grant matching also refuses any path that still
  contains `.` or `..` segments, as a second layer. This applies to
  per-user grants and to group grants.
- **Uploads are checked where they land.** An upload was authorised for the
  path in the request but saved next to it, which could be outside the
  grant (for example, at the top of the namespace). The server now checks
  write access on the file it is about to write.
- **Uploaded files can no longer run script in mdnest's origin.** Files
  are served from `/api/files/` on mdnest's own origin, and an SVG or HTML
  file can contain script. Anyone able to write a note could save such a
  file, and if someone else opened it directly, its script could read that
  person's session and act as them. Every served file is now marked
  `nosniff`, and formats that can run script (SVG, HTML, XML, JavaScript)
  are served with a sandboxing Content-Security-Policy, so opening one
  directly runs nothing. A file with no recognised extension is no longer
  treated as a web page based on its contents. This affects every install, single-user included.
  Images shown in notes are unaffected.

### Under the hood

- The rule for cleaning a namespace-relative path lives in one small
  package (`backend/relpath`) used by both the permission layer and the
  handlers, so the path that is checked and the path that is used cannot
  drift apart again. Regression tests cover each permission wrapper, grant
  matching, and the upload destination.
- Bumped `go.opentelemetry.io/otel/sdk` to v1.45.0 (an indirect dependency
  of the Firebase client) to clear advisory GO-2026-6505, which the backend
  security scan flagged as reachable.
- Pinned `@grpc/grpc-js` to 1.13.6 or later in the frontend (it arrives
  through the Firebase SDK) to clear a high-severity npm audit advisory.
- Overrode `sass` to 1.105.1 or later in the frontend to clear a
  high-severity advisory in `braces`, which has no fixed release. It
  arrived only through the drawing editor's pinned `sass` and is not in
  any shipped bundle; newer `sass` no longer depends on `braces` at all.

---

## v4.5.4 — SSO that is safe to put on the internet

SSO sign-in (`USER_PROVIDER=sso`) was built for an install behind a company
proxy. Put on a public hostname with nothing in front of it, the OIDC
callback and the login endpoint are the whole gate, and they had gaps. This
release closes them without changing anything for an install that was
working, on any IdP. mdnest stays plain OIDC: Google, Okta, Microsoft Entra,
Keycloak, Auth0 and now Clerk all go through the same code, with no
provider SDK.

### Security

- **An email the IdP has not verified is refused.** `email_verified` was
  read but never checked, so an unverified address matching an invited user
  got in. A token that says `email_verified: false` is now refused for every
  IdP. A token without the claim is refused for Google, which always sends
  it, and still accepted elsewhere, because Microsoft Entra ID leaves it out
  by default.
- **For Google, a personal account on a company address no longer passes
  `SSO_ALLOWED_DOMAINS`.** That setting checks the email's domain, and anyone
  can register a personal Google account on their work address. Such an
  account has no `hd` (Workspace) claim, so with an allowlist set, Google
  sign-ins must now carry one. Two setups that work today keep working:
  `gmail.com` in the allowlist (personal Gmail never has `hd`), and a
  Workspace user on a secondary domain (`hd` is the org's primary domain, so
  it is required to be present, not to be in the list).
- **Password login can be switched off in SSO mode.** The web UI shows only
  the SSO button, but `POST /api/auth/login` kept accepting a username and
  password: a password prompt on the internet that skips the IdP and its MFA.
  Set `SSO_DISABLE_PASSWORD_LOGIN=true` (Helm: `sso.disablePasswordLogin`)
  and it answers `403` to every password attempt, right or wrong. It is off
  by default. SSO sign-in, API tokens and existing sessions are unaffected;
  an MCP server using `MDNEST_USER`/`MDNEST_PASSWORD` must switch to
  `MDNEST_TOKEN`.

### Fixed

- **`SSO_AUTOPROVISION_USERS` and `OIDC_GROUPS_CLAIM` now work on `setup.sh`
  installs.** `setup.sh` never copied either into `.env`, so both were
  silently ignored. The SSO on/off switches are now also checked at setup
  time: a value other than `true` or `false` stops setup and names the
  setting, rather than quietly meaning "off".
- **Sign-in works on IdPs that send `email_verified` as a string.** Some IdPs
  send `"true"` rather than `true`, which made the whole token unreadable, so
  sign-in failed outright. Both forms are now accepted.

### Added

- **Clerk setup steps** in `docs/sso-setup.md`, next to Google, Okta and
  Entra. Clerk needs no code change: it is a standard OIDC provider. The
  guide notes the one difference, that Clerk does not pass Google's `hd`
  through, so behind Clerk the allowlist and invite-only users carry the
  gate.

---

## v4.5.3 — Install with one compose file

Installing mdnest meant cloning the repo, running a setup script and building
both images on your own machine. That's a lot of ceremony for anyone who
already runs their own networks, reverse proxy and certificates, and wants a
compose file they can read and edit. GitHub issue #112 said so plainly, after
30 minutes in the docs without a running install. There is now one file,
nothing to build and nothing to clone.

### Added

- **A plain `docker-compose.yml`.** `deploy/compose/docker-compose.yml` pulls
  the published images and runs single-user mdnest with your notes as plain
  files in `./notes`:

  ```bash
  mkdir mdnest && cd mdnest
  curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/mahsanamin/mdnest/main/deploy/compose/docker-compose.yml
  echo "MDNEST_PASSWORD=$(openssl rand -base64 18)"  > .env
  echo "MDNEST_JWT_SECRET=$(openssl rand -hex 32)"  >> .env
  docker compose up -d
  ```

  Every optional setting is a comment in the file: extra namespaces, the task
  board, drawings and slides, a reverse-proxy network, and a multi-user block
  with Postgres. If a secret is missing, compose refuses to start and names
  the variable, rather than booting with a default password.
- **A `docker run` version, and a guide to both.** `docs/setup.md` now opens
  with this install. It covers the usual changes in one table, the upgrade
  command (`docker compose pull && docker compose up -d`), and which
  `mdnest.conf` keys only mean something to the guided setup. The README
  Quick Start offers it as option A. The guided `setup.sh` path is unchanged
  as option B.

### Fixed

- **The published images now run on ARM.** They were amd64 only, so pulling
  them on Apple silicon, a Raspberry Pi or an ARM cloud host failed with "no
  matching manifest for linux/arm64". Releases now publish `linux/amd64` and
  `linux/arm64`. The builds cross-compile natively rather than under
  emulation, and local `setup.sh` builds are unaffected.
- **The clone URL in `docs/setup.md`** pointed at the wrong GitHub owner.

### Tests

- `tests/compose-example.sh` runs in the pre-push hook. It checks that every
  setting the compose file offers is one the backend actually reads, that
  nginx's proxy target `backend` is a service in it, that both images share a
  tag, that the file isn't gitignored, that releases publish arm64, and that
  the documented one-liner downloads the right path. With Docker present, it
  also checks the missing-secret refusal. Each check was confirmed to fail
  when its condition is broken.

---

## v4.5.2 — A task board that does what you meant

Dragging a card between columns worked for exactly one gesture: grab the thin
title strip, release squarely over another column's cards. Everything else
failed quietly or, worse, landed somewhere you didn't aim. The second move
from the same note was thrown away with a flash of "Loading tasks…". A
refresh on the board dropped you back into the editor, and switching to the
List view on a big workspace froze the app for ten seconds. All of that is
fixed, along with one byte the CLI added to every note it read.

### Fixed

- **Grab a card anywhere.** Only the title strip used to start a drag,
  although the whole card wore a grab cursor. The whole card is the handle
  now; its buttons and step checkboxes still click.
- **The column under the pointer is the target.** It used to be the column
  the card's rectangle overlapped most, and a column is only as tall as its
  cards — so a release below a short column's last card, or on the collapsed
  Done strip, hit nothing and the card snapped back. Anywhere in a column's
  lane counts now.
- **The board no longer slides sideways mid-drag.** dnd-kit measured its
  auto-scroll edge zone against the *source column's* box while scrolling the
  board, so leaving the starting column counted as "at the edge" and the card
  landed one column over. Its auto-scroll is off; the board scrolls only when
  you hold a card at its own left or right edge.
- **The second drop from a note lands too, without a reload flash.** A move
  writes a `status:` line under the task, shifting every task below it; the
  board kept the old line numbers, the server rightly refused the next move,
  and the board answered with a full reload that discarded it. A refused
  move now re-finds the task and retries quietly, moves save one at a time in
  drop order, and cards keep a stable identity across refreshes — a refresh
  landing mid-drag used to bind the drag to a different card.
- **The task board has a URL** — `#!board/<workspace>/<note>` — so a refresh
  keeps you on it, and a board can be bookmarked or shared. The link keeps
  the note underneath, so the back button and *This note* scope survive a
  reload.
- **The List view is instant on a big workspace.** It put every task into
  the page (6,327 rows, ~39k elements on the sample project) and froze the
  app for ~10 seconds. It now shows 200 at a time with a **Show more**
  button, like the Kanban columns' 100. Filters still cover every task.
- **`mdnest read` prints a note byte for byte.** It always appended a
  newline, so a note that already ended in one — anything saved by `write`
  or the web UI — read back with an extra blank line, and `mdnest read |
  diff - note.md` failed after every write though nothing had changed.

### Security

- **gRPC bumped to v1.83.2** (GO-2026-6443, GO-2026-6441, GO-2026-6348, all
  in `google.golang.org/grpc@v1.82.1`, published after v4.5.1; v1.83.1 fixes
  two of them, 6443 needs v1.83.2). gRPC arrives indirectly through the
  Firebase / Google Cloud client libraries; the bump pulls matching minor
  versions of OpenTelemetry, genproto and `golang.org/x/{crypto,net,sys,
  sync,text}` with it. `govulncheck -mode=binary` (what CI and the pre-push
  hook run) reports no vulnerable code reachable from mdnest after it.

### Tests

- `board-drag.spec.js` drags by the title (both scopes), by the card body,
  into the empty lane, onto collapsed Done, to an off-screen column via the
  edge, and three cards from one note back to back. Every case also fails if
  any *other* task anywhere changed — an early flaky version of the
  back-to-back case moved real cards in the dev instance's sample data, and
  nothing noticed.
- `board-deep-link.spec.js`, a List paging case in `board-scale.spec.js`, and
  a byte-exact `read` check in `cli-smoke-test.sh`.
- `tests/e2e-browser.sh` and `tests/e2e-docker.sh` mount their throwaway
  notes directory from inside the repo instead of the system temp dir, which
  Colima does not share — the run died at "could not seed note" before a
  single test ran.

---

## v4.5.1 — The CLI installer survives GitHub's CDN

`curl -fsSL https://raw.githubusercontent.com/.../install-cli.sh | bash` was
returning `503` and nobody could install the CLI. The repo was fine, GitHub was
fine, and the network was fine — the 503 came from Fastly's own edge:
`Backend.max_conn reached`, served by one POP, which takes out every install in
that region for as long as it lasts. Both the installer and `mdnest update`
were hardcoded to that single host with no fallback and no retry, and reported
the failure as "check your network" — sending people to look at the one thing
that was working.

The install command is now:

```bash
curl -fsSL https://mdnest.dev/install.sh | bash
```

The GitHub URL is the same script and keeps working.

### Fixed

- **The installer and `mdnest update` try three independent hosts, twice
  each** — GitHub raw first, then jsDelivr, then `mdnest.dev`. GitHub stays
  first deliberately: it publishes the instant a fix lands on `main`, whereas
  jsDelivr caches a branch ref for hours, and the CLI is pull-only so an
  update that arrives half a day late is its own problem.
- **A failure now names itself.** Every source's actual HTTP status is
  printed, plus a line saying that a 503 from `raw.githubusercontent.com` is
  GitHub's CDN rather than your network or the repo. Same rule as
  `curl_reason` and the pre-push audit check: keep the reason when the reason
  is what the reader has to act on.
- **A downloaded CLI is verified before it replaces a working one.** The old
  check was a shebang, which a captive-portal page and a truncated download
  both pass; it now also requires the `MDNEST_CLI_VERSION` marker. `mdnest
  update` also downloads once instead of twice — it used to fetch the file to
  read the version and fetch it again to install it, doubling the exposure to
  exactly this outage and leaving room for the two to disagree.
- **`mdnest.dev` mirrors the CLI**, pulled from `main` by the site's own
  deploy step rather than copied by hand — a mirror that can drift would hand
  people a stale CLI precisely when the canonical source is unreachable and
  nobody could tell.
- **The installer's closing hint is pasteable.** It printed
  `mdnest login <server-url> <api-token>`, and `<server-url>` is a shell
  redirection — the instruction meant to get you started was the next thing to
  fail. The project already had this rule for CLI output and the web UI; the
  installer sat outside both.

### Security

- **Two transitive **high** advisories, neither from this change.** They are
  here because `--audit-level=high` is a required check on `main`, so they
  blocked the hotfix outright.
  - `js-yaml` 4.3.1 -> 4.3.2 (GHSA-2883-xcg3-v3hh), reached via
    `@marp-team/marpit`. An in-range lock-file bump, no `package.json` change.
  - `@xmldom/xmldom` forced to `^0.9.12` with an `overrides` entry
    (GHSA-6gmq-8vp8-gcm6 and twelve siblings), reached via
    `speech-rule-engine`. v4.4.0 deliberately left this one alone while it was
    *moderate* — below the gate — because the override then made the tree
    invalid to npm's legacy quick-audit endpoint. The re-rating to high met the
    stated condition for revisiting it, and under CI's actual environment
    (`node:20`, npm 10.8.2) the override no longer breaks the audit.
    `speech-rule-engine@4.1.4` still pins `0.9.10` exactly and both
    `marp-core` and `mathjax-full` are already at their latest, so there is no
    other route.

    Two things made it safe to take rather than merely necessary: `xmldom` and
    `speech-rule-engine` are tree-shaken out of every shipped chunk, so the
    browser bundle does not change at all; and Marp still renders — verified
    by rendering a deck with front-matter, pagination and math through
    `marp-core` in Node, since the unit tests cover our own Marp detection and
    not marpit's YAML parsing, which is what the `js-yaml` bump touches.

### Notes

- `tests/cli-unit.sh` gains a source-chain suite: there must be more than one
  source, they must be on genuinely different hosts, GitHub must stay first,
  `mdnest.dev` must not be offered for a non-`main` branch, and the two copies
  of the list — the CLI's and the installer's, which cannot share code because
  the installer is fetched on its own — must match. The errexit lint now covers
  `install-cli.sh` too, since it runs under `set -e` and is no longer a
  straight-line script.

---

## v4.5.0 — Stickies

A personal sticky board, kept beside your notes and never mixed in with them.
Open it as a drawer on the right to jot something down without leaving the note
you are reading, or full screen as a corkboard where cards are dragged and
resized freely. Each card is a title, some free text, and a checklist — all
optional, so the same card covers a scribbled reminder and a small to-do list.

Stickies are deliberately **not** notes. They never appear in a namespace and
never reach a git remote: they live in mdnest's secrets volume (Postgres in
multi mode), which the git-sync sidecar cannot see. That storage location *is*
the privacy guarantee, which is why there is nothing to encrypt and no key to
manage. The tradeoff is stated plainly in the app and the docs — a sticky has
no git history and no off-server copy, so anything you would be upset to lose
belongs in a real note.

Nothing about the default install changes: no new dependency, no new
environment variable, no new failure mode for an operator who never opens it.

### Added

- **Sticky notes** — `GET`/`PUT /api/stickies`, available in both auth modes.
  Each user gets exactly one board, keyed server-side from the authenticated
  identity: there is no user id, path or namespace in the request, so reading
  someone else's board is not a check that can be forgotten, it is not
  expressible. Boards are stored in Postgres (`user_stickies`, migration 016)
  in multi mode and in `stickies.json` in the secrets volume in single mode —
  the same volume as `auth.json` and `tokens.json`, so a board survives
  `./mdnest-server rebuild` and stays invisible to git-sync.
- **The drawer** — a right-edge panel sharing geometry and remembered width
  with the comments sidebar; only one of the two is open at a time. Its open
  state is remembered per browser, so a refresh keeps it, but it stays out of
  the URL: a shared note link should never force someone else's stickies open.
- **The full board** — a corkboard at `#!stickies` with its own URL, so a
  refresh returns to the board rather than to the last note. Drag a card
  anywhere, resize it by its bottom-right corner, or use **Tidy up** (which
  asks first) to put everything back on the grid. On a phone it falls back to
  a flowing grid; free positioning on a 380px screen is a board you have to
  pan around to read.
- **Checklists** — "done" lives on the item, not the card. A single card-level
  flag forces "buy milk, call bank, post form" to be either three separate
  notes or one note you can only tick when all of it is finished. Enter opens
  the next line, Backspace on an empty one removes it, and long to-dos wrap.
- **Limits, enforced server-side** — 200 stickies per board, 200 bytes of
  title, 4 KB of text and 50 checklist items per card, a five-colour enum, and
  a 150–600px card width. The endpoint is writable by any authenticated user,
  so without them a board is an unbounded per-user blob store; this is the
  same reasoning that gave preferences a key allowlist.

### Notes for operators

- **No configuration.** There is no flag to turn stickies on, no env var to
  set, and `setup.sh`, `docker-compose.yml`, the Dockerfiles, `nginx.conf` and
  `mdnest-server` are untouched. The cost to an install that never uses the
  feature is +1.7 KB of JavaScript and +0.7 KB of CSS, gzipped, and one
  Postgres table in multi mode.
- **Boards are not backed up.** This is deliberate and is the flip side of the
  privacy guarantee: a sticky has no git history and no off-server copy. It
  survives a rebuild because the secrets volume is declared, but not the loss
  of that volume.
- **A board that cannot be read is an error, never an empty board.** Because a
  board is written back whole, a "gentle" empty result on a failed read would
  be replaced by the next keystroke. Both the client and the server refuse to
  save until a read has actually succeeded, so unreadable data is left in
  place to be recovered by hand.

---

## v4.4.0 — Edits that don't overwrite someone else

Changing one line in a note used to mean rewriting the whole file. Both surfaces
agents reach mdnest through — the MCP server and the CLI — could only replace a
note wholesale, so the only way to edit part of one was to read it, rebuild it,
and write it back. Anything saved in that window by the web UI, git-sync, or
another agent was silently overwritten, and the write reported
`{"status":"ok"}` while doing it.

Both now have an exact-string `edit` that carries the version it read, so a
concurrent save comes back as a 409 with nothing lost. Plus the Preview pane
renders images again.

### Added

- **`edit_note` MCP tool** — replace an exact string in a note instead of
  rewriting the whole file. Zero matches, or more than one without
  `replace_all`, is an error naming the count rather than a guess; the
  replacement is spliced literally, so `$&` and `$1` in a pasted shell snippet
  stay as written; and the write carries `If-Match`, so a save that landed
  since the read surfaces as a 409 instead of being clobbered. Contributed by
  **Luigi Lotito (@lglot)** (#107).
- **`mdnest edit` in the CLI** — the same capability, for the same reason, on
  the surface that had the same gap. Changing one line used to mean `read`,
  rebuild the note, `write` it back, which silently overwrote anything the web
  UI, git-sync or another agent had saved in the meantime — and reported
  `{"status":"ok"}` while doing it. `edit` matches literally, refuses an
  ambiguous match unless you pass `--replace-all`, and guards the write with
  the version it read. See `docs/cli.md`.

### Fixed

- **Preview showed every image broken.** A relative `![](shot.png)` resolved to
  `/api/files/…` but carried no `?token=`, and a browser `<img>` GET cannot send
  an `Authorization` header — so each one 401'd. The Live editor had always
  appended the token; the Preview renderer never did. The token is attached
  only for our own `/api/files` path and never rides along to a foreign host.
  Contributed by **@bilal-wego** (#108).
- **An image whose filename began with a scheme name never loaded in Preview.**
  The absolute-URL test was a `startsWith('http')` prefix check, so an ordinary
  uploaded `http-flow.png` was treated as an external URL, never got its
  `/api/files/` prefix, and rendered broken in Preview while working fine in
  the Live editor. Both renderers now share the Live editor's test, which also
  covers `blob:` and uppercased schemes.
- **A note whose content started with `@` could not be written at all.** The
  CLI passed note bodies to `curl -d`, where a leading `@` means *read this
  file* — so `mdnest create`/`write`/`append`/`prepend` on a note beginning
  `@mention …` failed with curl's exit 26, reported as "couldn't reach the
  server". Present since v1.0. Now `--data-raw`, which is `-d` without that
  special case.
- **The pre-push hook called an npm outage a vulnerability.** `npm audit` exits
  non-zero both when it finds advisories and when it cannot reach the
  advisories endpoint, and the hook discarded stderr and treated every non-zero
  exit as `VULNERABILITIES FOUND` — so a run of 503s from
  `/-/npm/v1/security/advisories/bulk` blocked the push while naming the wrong
  cause, and `npm audit fix` silently applied nothing for the same reason. An
  unreachable endpoint now SKIPs with the reason stated, the way the hook
  already handles govulncheck without a host Go toolchain; CI's required checks
  remain the authoritative gate. A real finding still blocks — all seven
  outcomes are probed in `tests/pre-push-audit.sh`.
- **Four transitive security advisories.** `qs` 6.15.2 -> 6.16.0 and `fast-uri`
  3.1.5 -> 3.1.7 (mcp-server), `browserslist` 4.28.2 -> 4.28.8 (frontend) — all
  three in-range lock-file updates, no `package.json` change. None of these came
  from this release's own changes — they are newly published advisories against
  dependencies that were already there, and both `npm audit` jobs are required
  checks, so `browserslist` (the only **high**) would have blocked the release
  PR to `main` outright.

  `@xmldom/xmldom` (moderate, GHSA-6gmq-8vp8-gcm6, reached via
  `speech-rule-engine`) is knowingly **left in place**. There is no
  semver-compatible fix — `speech-rule-engine` declares it as exactly `0.9.10` —
  and an `overrides` entry forcing `0.9.12` was tried and reverted: it makes the
  tree invalid to npm's legacy quick-audit endpoint, which then refuses the whole
  audit (`400 Bad Request … Invalid package tree`). That trades one moderate
  advisory for losing the audit signal entirely, which is strictly worse. Both
  audit jobs run `--audit-level=high`, so a moderate is below the gate by
  deliberate policy (see the severity note in `security-audit.yml`). Revisit if
  it is ever rated high or `speech-rule-engine` relaxes the pin.
- **The errexit lint flagged arithmetic as a command substitution.** `c=$((c +
  1))` is arithmetic expansion and carries its own exit status, but the lint's
  pattern saw the leading `$(` and reported it. Its self-proof now includes an
  arithmetic line, so a relapse shows up as a miscount.

---

## v4.3.3 — Instructions that survive a paste

A short one, entirely about the second half of the v4.3.2 report: someone hit a
CLI bug, and nothing in the product told them their CLI was stale or how to fix
it. v4.3.2 taught the CLI to say so. This does the same for the app.

### Fixed

- **The commands in Settings → CLI can be pasted.** Nine of them carried
  `<your-token>` or `<namespace>`, and `<` is a shell **redirection** — pasting
  `mdnest login https://notes.example.com <your-token>` into zsh or bash gives
  `no such file or directory: your-token`. Every one of those blocks has a Copy
  button that reproduces the text verbatim, so the instruction meant to get
  someone started was the next thing that broke for them. They use literal
  stand-ins now (`mdnest_yourtoken`, `notes`).

  The CLI learned this in v4.1.3 and `tests/cli-unit.sh` has asserted it for
  CLI *output* ever since. The web UI was simply never covered by that rule —
  which is the more interesting failure: the convention existed, was written
  down, and had a test, and the surface that most needed it sat outside the
  test's reach.

### Added

- **"Keeping it up to date" in Settings → CLI.** It states the thing nobody
  had been told: the CLI does not update itself and nothing pushes to it — it
  is a script on your machine. It shows `mdnest update` and `mdnest version`,
  and names the version *this server* is running, so there is something
  concrete to compare against rather than a vague suggestion to check.

### Guarding it

`frontend/src/__tests__/pasteable-commands.test.js` fails the build on a new
bracketed command. Two things it has to get right, both found by testing the
guard itself against the pre-fix file rather than trusting it:

- A shell block is checked **in full**, not line-by-line from a
  `mdnest`-prefixed start. The Copy button copies the whole block, and one of
  the nine offenders began `echo "text" | mdnest append <namespace>/log.md` —
  which a "line starts with mdnest" rule walks straight past.
- **JSON config blocks are excluded.** The MCP tab's
  `claude_desktop_config.json` mentions `node` and `mdnest`, but it is pasted
  into a *file*, not a shell, where `<your token>` is a perfectly good
  placeholder. Flagging it would have been a false positive that teaches people
  to ignore the check.

Verified both directions: all nine flagged against the old file, and the false
positive stays quiet.

---

## v4.3.2 — The CLI stops dying quietly

One bug report, one root cause, five places it was hiding. `mdnest servers`
printed the table header and then nothing at all — no rows, no error — and
exited with curl's `28`, any time a registered server was unreachable. Since
the server list is globbed alphabetically, one dead server also hid every
healthy server sorting after it, so a `mdnest login` that had worked perfectly
looked like it had failed.

Nothing was wrong with the networking, and nothing was wrong with the error
handling either: the labels, the hint, and the messages had all been written.
They were simply unreachable code. The CLI runs under `set -e`, and in bash a
plain assignment from a command substitution takes the substitution's exit
status — so `cfg=$(curl ...)` killed the whole script the moment curl could not
connect, mid-loop, before the first row. The leaked exit code was the tell: a
command that should always exit `0` was handing back curl's `28`.

The same shape turned up in four more places, each one silently killing the CLI
in place of an error message that already existed.

### Fixed

- **`mdnest servers` lists every server when one is unreachable.** The probe
  assignment is guarded (`... || curl_rc=$?`), so the loop survives a failed
  connection and prints the row it was always meant to: the URL, the
  `unreachable (DNS | refused | timeout | TLS)` label naming the actual reason,
  and the "works in your browser?" recovery hint. A dead server no longer hides
  the ones after it, and the command exits `0`. The trailing `curl_rc=$?` is
  deliberately gone — left in place it overwrites the real curl code with the
  status of the now-successful assignment and reports `unreachable (curl 0)`.
- **Reads and writes against an unreachable server say so.** `api()` had the
  identical unguarded assignment, so `mdnest read @unreachable/ns/x.md` printed
  nothing whatsoever and exited `28`. Its three error messages — can't resolve
  the host, connection refused, connection timed out — now actually run.
- **`mdnest servers -v` survives a failed namespace probe** rather than aborting
  partway through the listing.
- **A broken `jq` yields an empty field, not a dead CLI.** `json_top_string`'s
  jq tier returned jq's exit status from a bare `return`, which aborted the
  caller's assignment instead of falling through to an empty value.
- **`mdnest list <missing-folder>` reports the missing folder on a fresh
  machine.** The pure-awk tier — the one that runs when neither python3 nor jq
  is installed — signals "not found" with `exit 3`, and unguarded that killed
  the CLI two lines before the `path not found in namespace` message. It
  printed nothing and exited `3`. Same for the jq tier.

### Testing

- `tests/cli-unit.sh` gains an unreachable-servers suite that runs the real CLI
  against a throwaway `HOME` pointed at two closed loopback ports — instant, no
  network, no Docker — and pins the exit status, one row per registered server,
  the label, the hint, and `api()`'s error text. Ten of its eleven checks fail
  against the unpatched CLI. The eleventh exists to catch the *partial* fix that
  guards the assignment but leaves the stray `curl_rc=$?` behind.
- `tests/cli-smoke-test.sh` now requires the missing-subfolder case to say
  *why* it failed, not merely to exit non-zero. The bare `assert_fails` passed
  the entire time the awk tier was dying silently — a reminder that asserting a
  non-zero exit proves nothing about whether the error path ran.
  `tests/e2e-docker.sh` runs this suite in a bare alpine with neither parser
  installed, which is where that tier gets exercised.

### Added

- **The CLI tells you when it is out of date.** One line, wherever you are
  already looking at versions — `mdnest servers`, `mdnest whoami`,
  `mdnest login` — naming both versions and the exact command:

  ```
    Your mdnest CLI is v4.3.1; @work is running v4.3.2.
    Update it with:  mdnest update
  ```

  This is here because of what the bug above revealed rather than the bug
  itself. `mdnest update` is **pull-only** — nothing pushes it, and the in-app
  banner tracks the *server*, not the CLI. The only version check the CLI ever
  had was a **major**-version mismatch at login, so a client could sit on a
  stale point release indefinitely without a word. That is precisely how a bug
  introduced in v1.0 stayed invisible through 47 releases: everyone running it
  was told nothing.

  Three deliberate limits, stated rather than discovered later. It is **not**
  printed on every command — the CLI keeps no update cache, and a check on
  every read would be its own bug. It **does not contact GitHub**; the version
  comes from the `/api/config` call the CLI already makes, so there is no extra
  round-trip and no new failure mode — the trade-off being that if *your
  server* is also out of date, nothing tells you. And it never nags a
  pre-release about its own release: `4.3.2-dev` is older than `4.3.2` and
  newer than `4.3.1`, matching the in-app banner's `isVersionNewer`.

  `version_gt()` is pure bash — no python3, no jq, and no `sort -V`, which
  busybox sort does not have — so it works on the same fresh-machine tier as
  everything else in the CLI.

### Guarding against the next one

The bug above was one root cause in five places, and it had been in the
codebase since the first release. Two things now make a sixth harder.

- **Every plain command-substitution assignment in the CLI is guarded**, and
  `tests/cli-unit.sh` fails the build on a new unguarded one. The lint proves
  itself against a probe file — one unguarded form flagged, three guarded forms
  not — because a green lint that cannot fail is worse than no lint. It exempts
  `local x=$(...)`, which was *verified* against bash rather than assumed:
  `local` is a builtin, so the assignment's status is the builtin's own and
  errexit does not fire.
- **The lint is scoped to `mdnest`, not everything.** That is the script
  downloaded onto other people's machines, where a silent death is invisible.
  `mdnest-server` runs on the operator's own box and still has unguarded sites
  — a separate audit, named here so it is a known gap rather than a quiet one.

A third bug fell out of building the notice, and it is worth naming because it
had been sitting there quietly: `mdnest login` read the server's version with
`grep -o '"version":"[^"]*"'`, and `/api/config` carries **two** matches —
the top-level `version` and `latestRelease.version`, the nested one emitted
first. The value was two lines, not one. Nothing noticed, because the only
consumer was `${SERVER_VER%%.*}`, which still yields `4` from a doubled string.
The moment this release started *printing and comparing* that value, login
began reporting `is running v4.3.1\n4.3.1.` and the comparison read the third
field as `14`, telling a 4.3.2 CLI to update to a 4.3.1 server. `json_top_string`
is the depth-aware parser written for exactly this — its own header comment
names `latestRelease.version` as the trap — and the login path simply was not
using it. Fixed at the source, and `version_gt` now takes only the first line
of each argument so a sloppy caller cannot fabricate an upgrade either way.

Worth recording, because it is the honest result: while writing the update
notice, the same class of bug was **reintroduced inside the fix for it** — a
trailing `[ -n "$x" ] && …` as a function's last statement, where a false test
becomes the return value and `set -e` exits the CLI with `1`. The lint did not
catch it; a lint cannot see that shape. The unreachable-servers suite added
earlier in this release caught it within a minute. Which is the actual lesson:
the behavioural test is the guard, and the lint is the cheap second net.

Reported against v4.3.1 on Linux. Not platform-specific — it is shell
semantics, and it reproduces anywhere with a server pointed at a blackhole
address.

---


## v4.3.1 — Text you can actually read

v4.3.0 added a light theme. Shipping a second theme turns out to reveal every
place the first one was getting away with something, and this release is the
cleanup: four separate cases where mdnest drew text you could not read, three of
them found by simply looking at the app in the other theme.

The Mermaid ones are the worst of them. A diagram with an author's own
`classDef fill:` — the ordinary way anyone colours a flowchart — rendered its
labels in the light ink while in dark mode, so the text was near-invisible on
its own node. That is not a subtle miscalculation; the brightness maths was
right all along, and the walk that fed it was measuring the wrong shape.

### Fixed

- **Mermaid labels are readable on coloured nodes, in both themes.** Mermaid
  nests an empty `<rect>` spacer inside every flowchart node's label group. It
  paints nothing, but it inherits the themed `mainBkg` — `#313244` in dark — and
  that was the first shape the contrast pass found. So a pale `#cfe4ff` node was
  told its background was dark and got light ink. Light mode was correct only by
  luck, because its `mainBkg` happens to be bright too. The pass now measures
  each candidate before trusting its colour and skips anything with zero area.
  Measured on a pale node, the ink/fill luminance gap goes from **20 to 193** in
  dark and **144** in light.
- **Mermaid edge labels too.** An edge label has no shape at all — Mermaid
  paints it with a CSS `background-color` on the HTML inside the foreignObject,
  which the pass never looked at, so it climbed past the chip to an unrelated
  node. Brightness is now composited over the diagram's own ground as well,
  because that chip is half-transparent and judging the declaration instead of
  the pixel got the answer right only by accident. Gap: **20 to 173**.
- **Commented text is no longer white on yellow in light mode.** A commented
  passage is painted with `--highlight` (a bright yellow in *both* themes) and
  was inked with `--text-inverse`, which means "text that sits on the accent" —
  `#1e1e2e` in dark, `#ffffff` in light. So the light theme put white on yellow
  at **1.32:1**. The ink has its own token now.
- **The toolbar no longer draws its controls on top of each other.** On a narrow
  editor — a 13" laptop, or any window once the comment panel takes its 330px —
  the bar ran past its container and painted the filename over the comment
  button, and Rename/Delete over the theme and settings icons. It is a single
  non-wrapping flex row whose groups are all `flex-shrink: 0`, so the only thing
  that could give was the path in the middle, and it could not. The filename now
  ellipsizes, the path clips instead of painting outside itself, and the bar
  wraps rather than overflowing.

### Documentation

- **The README leads with what mdnest is** rather than a feature list, and every
  screenshot is new — taken at the size it renders, and shipped light *and* dark
  through `<picture>` so it follows the reader's theme. It also gains a diagram
  of the browser, the CLI and an AI agent all reaching the same files, because
  most people meet mdnest as a web app and never learn there is a CLI.
- **The CLI section teaches the current syntax.** It documented
  `mdnest note list`, the legacy form, which hides the whole point: one machine
  holds as many servers as you like and addresses them as `@work/…` and
  `@home/…` from the same shell.

### Testing

- `mermaid-contrast.test.js` and `theme-contrast.test.js` pin the decisions
  behind the fixes above; `tests/browser/mermaid-contrast.spec.js` and
  `toolbar-fit.spec.js` pin the rendered result in a real browser, in both
  themes. Each was confirmed to fail against the pre-fix code rather than
  assumed to.
- Two notes for whoever writes the next one of these. The overlap check skips
  nested pairs — Rename and Delete live *inside* `.toolbar-path`, and a parent
  enclosing its children is not a collision — and it confirms each overlap by
  hit-testing the intersection, because a control clipped by an
  `overflow: hidden` ancestor still reports its full rectangle while painting
  nothing.
- The browser E2E stack now sets `ENABLE_LIVE_COLLAB`, and its Mermaid fixture
  carries a pale-filled node and a labelled edge — the two shapes that were
  broken.

---

## v4.3.0 — Light mode

mdnest has been dark-only since the first commit. Some people don't want that,
and until now the only answer was "use a different app after sunrise".

This release adds a light theme that follows your operating system by default,
a toggle that takes one click, and — the part that matters more than it sounds —
a choice that is stored against your **account** rather than your browser. Pick
light on your laptop and your phone agrees.

It also takes a pass at the top toolbar, which had quietly become a wall of
equally-spaced buttons.

### Added

- **A light theme.** Catppuccin Latte alongside the existing Mocha, covering the
  whole app: sidebar, editors, task board, drawings, diagrams, modals, and the
  native scrollbars and date pickers the browser draws for us.
- **It follows your system by default.** New installs start on `auto`, which
  tracks your OS light/dark setting and changes with it live — no reload.
- **A toggle in the toolbar.** The sun/moon button top-right flips light and
  dark; the icon shows the theme you would switch *to*.
- **Settings → Appearance** carries the full three-way choice — Match system,
  Light, Dark — because "follow my system" is a third state one button cannot
  express without becoming a menu.
- **Your theme follows you, not your browser.** It is stored server-side: in
  Postgres in multi-user mode, in the secrets volume in single mode. A new
  browser, a phone, or a fresh private window gives you the theme you picked.
- **`DEFAULT_THEME` in `mdnest.conf`** (`auto` | `dark` | `light`) sets the
  starting point for people who have never chosen. It is a default, not a lock —
  any user's own choice overrides it. Also available as `ui.defaultTheme` in the
  Helm chart, and rejected at install time if it isn't one of the three.
- **`GET`/`PATCH /api/preferences`** — per-user UI settings, available in both
  auth modes.

### Changed

- **Drawings follow the app theme** instead of remembering their own, and
  repaint as soon as you change it. The canvas had its own light/dark button,
  which existed because mdnest was dark-only and a drawing had no other way to
  be light. Now that the app has a theme, that button was a second control
  doing almost the same job a few centimetres from the first, so it is gone.
- **The toolbar groups its controls.** Every button used to sit the same 8px
  from its neighbour, so "Rename" was no more visibly related to "Delete" than
  to the filename beside it. Related controls now sit close together with wider
  space between groups, and two dividers separate the actions that change a file
  from the ones that just navigate to it. No buttons were added or removed.
- **Slide decks keep their own theme.** A Marp deck is something you authored to
  look a particular way, and it renders that way regardless of your app theme.

### Fixed

- **`@milkdown/crepe` is now a declared dependency.** The Live editor imported it
  directly while it resolved only as a transitive dependency of
  `@milkdown/react`. A lockfile regeneration or a Milkdown bump could have
  removed it and broken the editor build with an error pointing at
  `node_modules` rather than at the missing declaration.
- **The Settings tab row wraps** instead of pushing "Credentials" off the edge of
  the dialog.

### Under the hood

- Colour is now a **two-layer token system** (`frontend/src/theme.css`): a raw
  palette, and semantic tokens that every stylesheet uses. 930 hex literals were
  replaced. The indirection is what makes a second theme possible at all —
  mdnest used `#313244` as a background 78 times and as a border 102 times, and
  in a light theme those must diverge, since a border has to be darker than what
  it encloses while a raised surface stays lighter than the page.
- **The light palette is measured, not eyeballed.** Stock Latte tunes its accents
  for use *as* accents; mdnest uses them as body text. Latte yellow measures
  2.31:1 on the page background against a 4.5:1 AA floor. Five hues are darkened
  to the first step that clears AA both as text and under white. 63 contrast
  assertions run in the test suite, including one that light is never less
  readable than dark for the same pair.
- New tests: theme resolution and its precedence, the token layer's
  completeness, contrast in both themes, that `setup.sh` actually delivers
  `DEFAULT_THEME` to the container, and six browser specs — one of which clears
  the browser entirely and proves the theme still comes back.
- `tests/setup-marp-themes.sh`, added in v4.2.0 but never invoked by anything,
  now runs in the pre-push hook alongside the new setup test.

**Upgrading:** nothing to do. Existing installs keep dark unless a user chooses
otherwise or you set `DEFAULT_THEME`. Multi-user installs pick up one new table
(`user_preferences`) automatically on first start.

---

## v4.2.2 — A board you can actually use

Almost all of this release came out of running the task board on a real project
with roughly 12,000 checkboxes, where it went from useful to unusable. None of
it was where it looked: the server answered in ~100 ms, and the cost was the
browser being handed every card at once.

The rest is the board finally saying what it is. It has been a third button
inside the Basic/Live control, then a row in the sidebar, and is now one button
that names where it takes you — with no way out of it until this release, which
is the part that should not have shipped in the first place.

### Fixed

- **One toolbar button now swaps between your note and the board.** On a note
  it reads **Board**; on the board it reads **Editor** and brings you back — the
  label always names where it will take you. Previously the board was a third
  button inside the Basic/Live control, where all three read as one choice,
  even though Basic and Live are ways of editing the file you have open while
  the board leaves the file entirely. Basic/Live are hidden while the board is
  open, since there is no note on screen for them to act on, and so is the "No
  file selected" placeholder. The board's own header still starts with a back
  button naming the note you came from. The sidebar is now purely your files.
- **The sidebar's create buttons read Folder, Note, Drawing** — containers
  before the things that go inside them.
- **Card order is now yours to choose, which matters once a column pages.**
  Tasks arrive in note order, so with a column painting 100 cards at a time an
  overdue task in a late-alphabet file sat on page 64 with no way to know it was
  there. A *Sort* control in the filter bar offers **due date, then priority**,
  and remembers the choice. The default stays note order deliberately: it is
  what the board has always shown, it mirrors the files the tasks live in, and
  most boards never page at all — quietly reshuffling them would be its own kind
  of broken. Sorting adds no measurable cost (typing measured at 86 ms in note
  order and 74 ms by urgency on a 12,000-task board).
- **The task scan is cached, so the board stops re-reading every note.** Every
  board request read and parsed every note in the namespace. Measured on 420
  notes holding ~12,000 checkboxes: walking the tree costs ~6 ms while reading
  and parsing costs ~100 ms, so the parse is now remembered and only the walk
  repeats — a warm request drops from ~130 ms to ~20 ms, and "All workspaces"
  to ~18 ms. It cannot go stale on its own: every request still walks the
  namespace and a cached answer is used only when the file set, sizes, newest
  timestamp and column layout are all unchanged, so an edit from the API, the
  CLI, git-sync or an editor on the host invalidates it without being told.
  Refresh sends `refresh=1` and re-scans regardless. The cache lives in memory,
  not in a file under your notes — a cache file there would be synced by
  git-sync and destroyed by a rebuild.
- **"All workspaces" asks before it scans.** It reads every note in every
  workspace you can see, which is the one board action that can visibly pause
  on a large install. It now explains that before starting, with a *Don't show
  this again* that is remembered.
- **Presence no longer flickers, and no longer moves your work.** With more
  than one person on a note, collaborators appeared and disappeared repeatedly.
  Two separate faults. Departures were applied the instant they arrived, so any
  momentary gap — a reconnect, a presence snapshot racing a join — read as
  someone leaving and immediately returning; a departure is now held for a few
  seconds and cancelled outright if they come back, so a blip never reaches the
  screen while a real exit still registers. And the presence bar sat in the
  document flow as a full-width strip, so each of those blips reflowed
  everything below it — the editor, a Mermaid diagram, a drawing canvas all
  jumped. It is now an overlay pinned inside the content area, so presence can
  come and go without the page moving. This affected every note, not just
  drawings.
- **The task board stays usable on a big project.** Enabling the board on a
  namespace with ~12,000 checkboxes made it crawl. The server was not the
  problem (it answers in ~100 ms); the browser was being handed every card at
  once. A column rendered its entire contents, so ~6,300 cards and **50,649 DOM
  nodes** went onto the page, and every keystroke in the filter box re-filtered
  and re-rendered the lot — **456 ms per key**. Columns now paint 100 cards at a
  time with a *Show more* button, cards are memoised so one change no longer
  re-renders its neighbours, and filtering follows a deferred value so typing
  stays responsive. The column header still reports the true total, so nothing
  is hidden silently. Measured on the same 11,994-task namespace: board opens
  **1,802 ms → 844 ms**, DOM **50,649 → 950 nodes**, filter keystroke
  **456 ms → 87 ms**.
- **The task board has a visible way out.** It replaces the editor pane, and its
  `onClose` was accepted but never rendered — so once you were on the board, the
  only way back to your note was the toolbar's Basic/Live pair, which says
  nothing about the board. The header now starts with a back button naming the
  note you came from, and the sidebar entry toggles the board closed again.
- **A missing build asset now 404s instead of being served the app shell.** The
  SPA fallback also caught `/assets/`, so a content-hashed chunk that no longer
  existed was answered with `index.html` and a `200`. A tab still running a
  previous deploy asked for filenames that had been replaced, received HTML
  where it expected a JavaScript module, and broke in a confusing half-alive way
  instead of failing cleanly — and the chunk retry could not rescue it, because
  the cache-busted URL returned the same HTML. Unknown *routes* still serve the
  app shell; only `/assets/` is strict.

---

## v4.2.1 — Nothing silently disappears

A bug-fix release with one theme: mdnest should never lose your work or hide it
somewhere you can't reach. Every fix here is something that failed quietly —
no error, no indication anything had gone wrong.

### Fixed

- **A drawing no longer loses its last strokes when you switch files.** Opening
  another note cancelled the previous file's queued autosave outright, so any
  edit made inside the debounce window was discarded. Drawings hit this on
  almost every switch: the canvas debounces its own scene for 500ms before
  handing it to the app, and you stop drawing at exactly the moment you reach
  for the next file — a newly created drawing could stay 0 bytes on disk. The
  pending save is now flushed rather than dropped, before the next note loads
  (the etag is shared, so the order matters). The drawing canvas hands over its
  own debounced scene at the same point, and a stray post-unmount timer that
  could push one file's content at another is cleared.
- **A failed code-split chunk no longer blanks the whole app.** A lazily-loaded
  editor whose chunk didn't download threw during render, reached React's root
  and unmounted everything — no sidebar, no toolbar, no way to open another
  note. Only the Live editor was guarded; drawings, the task board and the slide
  renderer had a bare `<Suspense>`, which handles a *pending* import but not a
  *rejected* one. They now show an error with a way out, and a failed import is
  retried — the last attempt with a cache-busting query, which recovers from a
  proxy that cached an error response for an immutable asset URL.
- **Dropping a file into an open folder puts it in that folder.** Only the
  folder's own row accepted a drop; its expanded contents area had no handlers,
  so a drop there bubbled up and was treated as "move to the namespace root" —
  aiming carefully *inside* a folder moved the file out of it. Dropping onto a
  file did nothing at all, because a file row swallowed the event before
  bailing.
- **The task board scrolls sideways instead of hiding columns.** With enough
  columns the right-hand ones became unreachable, with no scrollbar. The board
  panel had no `min-width`, so it refused to shrink below the intrinsic width of
  its columns, grew past the viewport, and was clipped by its container — the
  scroll container was never smaller than its own contents.

### Changed

- **"+ Note", "+ Drawing" and "+ Folder" create where you are.** They always
  created at the namespace root, however deep in the tree you were. Clicking a
  folder now aims them at it — shown in the tree and named in each button's
  tooltip, since the destination was otherwise invisible — and opening a file
  hands the target back to that file's folder.
- **"Basic" now does something on a drawing.** A `.excalidraw.md` is a real
  markdown file, but the canvas short-circuited the editor entirely and the
  Basic/Live buttons sat there inert. The toggle now offers the two views a
  drawing actually has: the canvas, or the markdown behind it. Live is
  deliberately not offered — the rich editor would reformat the scene JSON, the
  same hazard that already forces Marp decks to raw editing.
- **Drawings open in dark mode**, matching the rest of the app, with a toggle to
  light. Theme is a viewing preference: it is stored per browser and never
  written into the note, so the file stays portable and two people can view one
  drawing differently.
- **The task board moved out of the toolbar's Basic/Live control into the
  sidebar.** Those are two different things — Basic/Live is how you edit the
  open file, the board is a namespace-level destination — and sharing one
  segmented control made all three read as the same kind of choice.

### Security

- **Replaced `github.com/lib/pq` with `pgx`.** govulncheck reports seven
  advisories against lib/pq (GO-2026-6166, 6168, 6170–6173) — a malformed-frame
  panic, unbounded SCRAM iteration, and GSS authentication completing without
  mutual proof. All are `Fixed in: N/A`: v1.12.3 is affected too, so there is no
  patched release to move to, and lib/pq is in maintenance mode. Only the
  Postgres driver changes; the connection string, the SQL, and single mode
  (which never opens a database) are untouched. `golang.org/x/text` is bumped to
  v0.39.0 to clear the one transitive advisory pgx introduced. The backend now
  scans clean.

### Fixed (continued)

- **The namespace root is a row in the tree.** Aiming the create buttons at the
  selected folder (above) made selecting one a one-way trip — nothing pointed
  them back at the top level — and left the root with no drop target beyond
  whatever blank space remained under the tree, which is none once the tree
  fills the panel. Click the root row to create at the top level, or drop onto
  it to move something there.

### Testing

- Browser regression specs for every fix above, each written to fail on the
  previous build.
- The E2E stack now enables drawings (`ENABLE_EXCALIDRAW`). It only set
  `ENABLE_TASK_BOARD`, so every drawing spec skipped — including the one pinning
  the data-loss bug. A regression test that never runs in the gate is not a
  gate.

---

## v4.2.0 — Drawings, access groups, and per-note authorship

The largest release since v4.0.0, and almost all of it is contributed work. Three
new opt-in capabilities — Excalidraw drawings, a centralized Marp theme catalog,
and role-based access Groups — plus per-note authorship, a task board grown up
enough to run a week on, and an MCP server that can now edit slides, tasks and
drawings rather than only note bodies.

Every new capability is off by default. An operator who wants none of them carries
no new service, no new required env var, and ~1.8 KB more in the frontend entry
bundle; the drawing engine and the deck exporter are code-split and download only
when something actually needs them.

One fix here matters more than its size suggests: in the git-native HA topology a
**move could look like data loss**. See below.

### Added

- **Excalidraw drawings (opt-in — `ENABLE_EXCALIDRAW=true`).** A `.excalidraw.md`
  note opens on a full [Excalidraw](https://excalidraw.com/) canvas, and any note
  can embed a drawing read-only with an `![alt](path.excalidraw.md)` image embed.
  The file is Obsidian-compatible: the scene is stored as a JSON block and the
  drawing's text is mirrored into a `## Text Elements` section so it stays
  searchable and readable, so drawings reuse the same history, restore, comments
  and search as any note. Off by default; the (large) editor bundle is code-split
  and only loads when a drawing is opened. Operators can preload organisation-wide
  shape libraries via `EXCALIDRAW_LIBRARIES` (Helm `excalidraw.libraries`), a list
  of `.excalidrawlib` URLs. Concurrent editing is last-write-wins with a conflict
  warning. See [docs/excalidraw.md](docs/excalidraw.md).
- **Centralized Marp themes (opt-in — `ENABLE_MARP_THEMES=true`, on top of
  `ENABLE_MARP`).** Decks can reference a shared theme by name (`theme: <name>`
  in the frontmatter) instead of embedding a large per-deck `style:` block, so
  presentation styles are managed and evolve in one place. Themes live in a
  reserved, hidden namespace (auto-created, git-versioned locally, and never
  mirrored to a per-workspace git remote), are readable by every deck in any
  namespace, and are edited by superadmins from a new **Marp Themes** admin tab.
  A neutral `starter` theme is seeded on first start when the catalog is empty.
- **Export a Marp deck as a real, standalone presentation.** From the deck view,
  export to a single self-contained `.html`: a genuine Marp *bespoke* deck
  (keyboard/touch navigation, fullscreen and presenter view) that opens offline
  in any browser. Rendered entirely in the browser with marp-core and wrapped in
  marp-cli's bespoke player (vendored, MIT) — no server dependency and nothing
  added to the backend image. Centralized themes are resolved and images inlined,
  so the file is fully self-contained.
- **Role-based access "Groups" (multi mode).** A new superadmin-managed
  **Groups** admin tab lets you define named groups whose members are mdnest
  users and/or IdP (OIDC) group IDs, and grant those groups read/write access
  to namespaces (with the same path scoping as per-user grants). A user's
  effective access is the **union** of their own grants and the grants of every
  group they belong to — directly, or through an OIDC group ID carried in their
  login token. OIDC-group membership is read from a configurable ID-token claim
  (`OIDC_GROUPS_CLAIM`, e.g. `groups` on Entra ID) and snapshotted at login, so
  a change at the IdP applies on the member's next sign-in. **Note for
  operators:** because the OIDC-group snapshot lives in the session token,
  removing a user from an IdP group (e.g. offboarding) does not revoke their
  mdnest access until that token expires — bounded to the SSO session lifetime
  (12 hours). Direct user membership, by contrast, takes effect immediately
  (added and revoked live).
  Each OIDC-group member can carry an
  optional display label (reference only — matching is always on the group ID).
  Fully additive and opt-in: with no groups defined and `OIDC_GROUPS_CLAIM`
  unset, behaviour is unchanged.
- **Per-note authorship attribution (multi mode).** A note now carries an
  internal activity trail — who created it, who last edited it, and everyone who
  has contributed — surfaced from the note's context menu as an **Attribution**
  panel. Every save is recorded in a Postgres-backed `note_activity` table
  (migration `014`), and contributors are cross-checked against the note's git
  history so authorship stays accurate even for edits made outside the app.
  Multi mode only and fully nil-safe: a single-mode install has no user
  identities to attribute, so nothing is recorded, the `/api/note/attribution`
  route is never registered, and the UI entry stays hidden.
- **Task relations, filters and a cross-workspace board.** Tasks can declare
  `depends-on`, `blocked-by` and `related-to` relations (rendered on the card and
  resolvable to other tasks by their stable `ref`), carry an `assignee`, and be
  narrowed with a filter bar over title, tags and assignee (All / Me /
  Unassigned / a member). A new **All workspaces** scope aggregates tasks from
  every workspace you can access, each card showing where it came from — access
  is enforced per request, and the view serves nothing rather than everything if
  its namespace filter is ever left unwired. Plus board polish: a mobile layout,
  task delete, manual refresh, and cards whose title gets its own full-width
  line.
- **Closing a task is blocked while its sub-tasks are unresolved.** Checking a
  parent done, dragging it into a Done column, or saving an edit that moves it
  there are all refused (HTTP 422) until every sub-step is ticked, with the
  reason surfaced in the UI rather than failing silently. Enforced in the
  backend, so it holds for API and MCP callers too, not just the board.
- **MCP: subject-level CRUD for tasks, Marp decks and drawings.** The MCP server
  now manages the things inside a note, not just note bodies: full task CRUD
  (including relations, assignee, the close guard and cross-workspace search),
  per-slide Marp operations (list/read/edit/delete/move/insert, with slide
  splitting that ignores a `---` inside a fenced code block), and Excalidraw
  authoring — compile a high-level `nodes`+`edges` spec into a real scene with
  bound labels and connected arrows, then read and edit individual elements with
  cascade delete and automatic re-flow. Tools are registered based on the
  backend's enabled features, so a notes-only deployment exposes only the
  note/tree/search tools.

### Fixed

- **A move no longer looks like data loss on HA replicas.** In the git-native HA
  topology (stateless app replicas + a single durability writer), app replicas
  read exclusively from the Redis working set. The writer applied a rename to the
  durable tree and then evicted **both** ends from the working set — the source
  correctly, the destination wrongly — and never re-populated it. Because a
  replica cannot re-hydrate from the durable tree on a cache miss, and the
  enqueuing replica had already dropped the source, every read of the moved file
  (or the moved directory's whole subtree) returned 404 until the next full
  hydrate: `POST /api/move` reported success and the note then appeared to be
  gone. The destination is now re-hydrated from the durable tree after the
  rename, for both a single file and a moved subtree. Single-box installs were
  never affected.

- **The Marp theme editor's Save button is styled** to match the rest of the
  admin panel (a primary button with a proper disabled state) instead of the
  default browser control.

### Security

- **Go 1.26.6 and refreshed `golang.org/x/*`.** The backend image built on
  go1.26.5, whose standard library carried reachable advisories in `crypto/tls`,
  `net/http`, `encoding/asn1` and `net`; `golang.org/x/text` v0.38.0 was also
  reachable, from `HandleNoteAt` through `ReverseProxy` into `norm.Form`. The go
  directive and the builder image move to **1.26.6**, `x/net` to v0.56.0 and
  `x/text` to v0.39.0. `govulncheck` reports zero vulnerabilities affecting
  mdnest's code.
- **Frontend dependency advisories cleared.** v4.1.3 bundled `nanoid` 3.3.16
  (high — GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8) plus moderate advisories in
  `mermaid` 11.15.0 and `dompurify` 3.4.12. All are transitive, none were
  reachable from a code path mdnest calls directly, but they are gone: `nanoid`
  → 5.1.16, `mermaid` → 11.16.1, `dompurify` → 3.4.13, and `npm audit` reports
  zero for both the frontend and the MCP server. The new Excalidraw dependency
  pulled its own vulnerable `nanoid` and `lodash-es` copies in transitively;
  those are pinned up via `overrides` rather than shipped.

---

## v4.1.3 — comments, Marp safety, and four papercuts that made mdnest look broken

Alongside the comment-editing and Marp work, this release clears a batch of
reported bugs that shared a shape: mdnest was working correctly but not *saying*
so, so each one read as a malfunction. A DNS failure blamed the server's config
file. A namespace added to `mdnest.conf` simply never appeared. A file created on
disk sat invisible in the sidebar until you clicked Refresh. Diagram text
couldn't be copied at all.

### Added

- **Task assignees, filtering, and a cross-workspace view** (task board only,
  still behind `ENABLE_TASK_BOARD`). Tasks carry an `assignee:` metadata field
  picked from the workspace's members; a filter bar narrows the loaded tasks by
  title, tags and assignee (All / Me / Unassigned / a member); and a new "All
  workspaces" scope aggregates tasks from every workspace you can access, with
  each card showing which workspace it came from. The cross-workspace view
  enforces access per request and serves nothing if its namespace filter is
  ever left unwired.
- **Edit your own comments.** The author (and only the author) can now revise a
  comment's text inline from the comment panel; an "(edited)" marker is shown
  once a comment has been changed. Resolve/reopen stays open to everyone.
- **Resizable comment panel.** Drag the panel's left edge to widen or narrow it
  (persisted per browser), and the comment/reply/edit text areas can be resized
  vertically.

### Changed

- **The comment panel is usable in any view.** Opening comments no longer forces
  you out of preview-only into the Live editor — you can review Marp slides and
  leave general comments side by side. Selection-anchored comments and
  highlights still require the Live editor.
- **The preview now makes room for the comment panel** instead of being covered
  by it, so slides stay fully visible while commenting.
- **Comment text preserves line breaks** instead of collapsing multi-line
  comments into a single block.

### Fixed

- **`mdnest login` now diagnoses the actual problem and prints a fix you can
  paste.** Four bugs in one code path. An unreachable server was reported as
  "this server has no SERVER_ALIAS configured" — a claim about an `mdnest.conf`
  the CLI never managed to read, which sent people off to edit and rebuild a
  blameless server; the two cases are now distinguished and the real reason is
  named (DNS, refused, timeout, TLS). The recovery hint was rebuilt from the raw
  positional arguments, so it kept whatever bad argument you typed and dropped
  your token entirely. That hint's placeholder was `@<name>`, and `<name>` is a
  shell redirection, so pasting the suggested fix errored in both zsh and bash —
  every command mdnest tells you to run now uses literal placeholder words. And
  an argument that wasn't a URL was saved to disk anyway with only a warning,
  becoming the *default* server on a fresh machine so every later command aimed
  at garbage. The common root cause — an alias written without its leading `@`,
  which shifts every argument along — now gets the same command back with that
  one character fixed.
- **The file tree refreshes itself for writes that never went through the API.**
  A file appearing on disk stayed invisible in the sidebar until you pressed
  Refresh. The `tree-changed` event is emitted only for changes that arrive
  through the API, so git-sync pulling another machine's commits (or an editor on
  the host) produces no event at all — and the polling fallback was skipped
  entirely whenever the live-collab websocket was connected, treating "the socket
  is up" as "the tree is current". Exactly the installs running both collab and
  git-sync got no automatic update at all. The poll now always runs, at 30s
  instead of 60s, and silently: no spinner or indicator bar for a refresh you
  didn't ask for.
- **Mermaid diagram text can be selected and copied.** In the inline preview the
  rule making labels selectable was attached to a CSS class nothing had applied
  since click-anywhere-to-expand was replaced by the expand button, so it matched
  nothing. In the fullscreen viewer it was impossible by construction: the canvas
  suppresses selection so a drag pans, and every mousedown started that pan —
  including one on a label. A drag beginning on text now selects instead of
  panning, and both modes gained a **Copy text** button that puts the whole
  diagram's labels on the clipboard, the same affordance code blocks already had.
- **Adding a namespace tells you it isn't live yet.** Namespaces are Docker
  volume mounts, so writing a `MOUNT_` line only changes the desired state — the
  running backend keeps serving the mounts it was created with. Nothing surfaced
  that gap, so an added namespace was just absent from the UI and the API.
  `add-namespace` now offers to reload for you (defaulting to yes), and
  `mdnest-server status` compares `mdnest.conf` against what the running
  container actually serves, reporting either direction: configured but not live,
  or still served but no longer in the conf.
- **Comments no longer vanish when a note is deleted and recreated**
  (`STORAGE_BACKEND=git` only). A note's identity (its hidden `mdnest:` marker,
  which links it to its `.mdnest/comments/<id>.jsonl` sidecar) is now reconciled
  on write: a recreated or marker-stripped note recovers the marker the path
  previously carried in git history, so its comments stay attached instead of
  being orphaned. A note's marker is also snapped back if an overwrite tries to
  change it. The default `local` backend is unaffected by this change — a
  delete+recreate there still starts a fresh comment thread.
- **Marp decks are no longer corrupted by the Live editor.** A note whose
  frontmatter declares `marp: true` is now always edited as raw text — the
  Live/WYSIWYG editor is disabled for it, because round-tripping the markdown
  through the editor's document model rewrote the frontmatter (`---` → `***`)
  and slide separators and silently broke the deck on autosave. The Basic
  editor (with the live slide preview alongside) is forced, and the "Live"
  toggle is disabled with an explanatory tooltip while a Marp note is open.
- **Helm: StatefulSet upgrades no longer stall on an immutable-field diff.**
  `volumeClaimTemplates` carried the full `mdnest.labels` set, which includes
  `helm.sh/chart` and `app.kubernetes.io/version` — both change on every
  release. Because `volumeClaimTemplates` is an immutable part of the
  StatefulSet spec, each upgrade became an illegal update to an immutable
  field: a server-side-apply dry-run failed and Argo CD (or `helm upgrade`)
  stalled with a perpetual out-of-sync diff. The claim templates now carry only
  the release-invariant `mdnest.selectorLabels`, so upgrades apply cleanly.
  Chart version bumped to 0.3.1 (template-only change).

---
- **Per-note authorship attribution (multi mode).** A note now carries an
  internal activity trail — who created it, who last edited it, and everyone
  who has contributed — surfaced from the note's context menu as an
  **Attribution** panel. Every save is recorded in a Postgres-backed
  `note_activity` table (migration `014`), and contributors are cross-checked
  against the note's git history (blame) so authorship is accurate even for
  edits made outside the app. Multi mode only and fully nil-safe: single-mode
  installs have no user identities to attribute, so nothing is recorded, the
  `/api/note/attribution` route is not registered, and the UI entry is hidden.

---

## v4.1.2 — `mdnest list` you can actually read

Patch release fixing GitHub issue #87, reported from Fedora 44. Both halves of
that report were the CLI's fault, and both are fixed. Nothing outside the
`mdnest` CLI changed.

### Fixed

- **A broken python3 install no longer pollutes CLI output** (#87). The
  reporter had a stale `matplotlib` `.pth` in `~/.local`, which makes *every*
  python3 start print a traceback to stderr. Because the CLI shells out to
  python3 for percent-encoding and JSON parsing, that traceback landed in the
  middle of mdnest's own output and `mdnest list <workspace>` looked like it had
  crashed. Every python3 call now goes through one guarded helper that passes
  `-S` (skip site initialisation, so the user's `.pth` files are never
  processed) and `-E` (ignore `PYTHON*` env vars), drops python's stderr, and
  reports failure so a python3 that is present but *broken* degrades to the
  pure-bash/awk fallback each call site already had, instead of silently
  returning an empty value. `mdnest servers -v` and the JSON field parser now
  fall through the same way, rather than reporting an unreachable server or an
  empty field when python3 misbehaves.

- **`mdnest list` renders a tree instead of dumping raw JSON** (#87). Listing a
  namespace printed the entire `/api/tree` payload as one long line of compact
  JSON — unreadable for a namespace of any size — and `mdnest list` with no
  namespace printed a raw JSON array. Namespaces now print one per line, and a
  namespace or folder prints as a tree with a folders/files count:

  ```
  engineering
  ├── Architecture/
  │   ├── decisions/
  │   │   └── 001-storage.md
  │   └── system-overview.md
  └── README.md

  2 folders, 3 files
  ```

  Pass `--json` (or set `MDNEST_JSON=1`) to get the exact previous payload, so
  anything scripted against it keeps working — including the client-side
  subfolder scoping. The renderer is deliberately awk-only, with no python3/jq
  tier: awk is on every machine mdnest supports, so a listing looks identical
  everywhere and a broken python install cannot garble it. Verified byte-for-byte
  on gawk, mawk and busybox awk.

- **The legacy `mdnest note read <ns> <path>` form returns the note again.** It
  tried a tree lookup first, so for any file that actually existed it printed
  that file's `{"name","type","path"}` tree entry instead of its content — the
  note body only came back for a *missing* path. The flat `mdnest read` form was
  never affected.

### Chores

- Lock-file-only dependency bumps to clear advisories published since v4.1.1:
  `undici` 7.28.0 → 7.29.0 (frontend, dev-only via jsdom) and
  `@modelcontextprotocol/sdk` 1.27.1 → 1.30.0 (pulling `hono` 4.13.0,
  `ip-address` 10.4.0, `fast-uri` 3.1.5). Both audits report zero
  vulnerabilities.

### Tests

- `tests/cli-unit.sh` gained two passes that reproduce the issue #87 environment
  through a PATH shim — a python3 that is noisy-but-working and one that exits
  non-zero — asserting correct values *and* a clean stderr in both, plus unit
  coverage of the tree/namespace rendering (run twice, with and without a parser
  present, since the two must agree).
- `tests/cli-smoke-test.sh` now asserts that a listing contains tree connectors
  and **no** JSON keys, that `--json` still returns the scoped payload, and that
  legacy `note read` returns a note body. All of it passes in the bare
  no-python3/no-jq alpine container of `tests/e2e-docker.sh`.

---

---

## v4.1.1 — The conflict banner learns whose save it is

Patch release fixing GitHub issue #82.

### Fixed

- **Editing your own note in multi mode no longer flashes "This file was
  modified by *you*. Your changes may conflict."** (#82). The v4.0.0 fix
  remembered the etags this tab's saves produced and suppressed matching
  `file-changed` echoes — but it learned each etag from the PUT *response*,
  while the backend broadcasts the echo *before* it writes that response. The
  echo therefore usually arrived first, found nothing to match, and popped the
  conflict banner naming the editing user on nearly every autosave — reflowing
  the document up and down while typing. The suppression now lives in a pure
  `echo-gate` module with an in-flight-save window: broadcasts that arrive
  while this tab's own PUT is outstanding are deferred and re-checked once the
  save settles, by which point the response has registered its etag and the
  echo is recognized and dropped. A genuine change by another user — or by the
  same user through the CLI/MCP — is still delivered after the save settles,
  and deferred messages are discarded on file switch so they can't replay
  against the wrong note. Regression-pinned in
  `frontend/src/__tests__/echo-gate.test.js`, covering the exact race from the
  issue, the late-echo ordering the old ring handled, and the
  remote-change-during-save path.

---

## v4.1.0 — Marp slides, Git Workspaces admin, and the image v4.0.0 forgot

A short cycle on top of v4.0.0, and it starts with an apology: **v4.0.0 shipped
without its `mdnest-mcp-server` image**, so any Kubernetes install with
`mcp.enabled=true` hit `ImagePullBackOff` on a tag that was never built. This
release publishes it and makes that class of mistake impossible to repeat.

### Fixed

- **v4.0.0 published no `mdnest-mcp-server` image** ([#76]). The release
  workflow's build matrix and the chart had drifted apart: the matrix entry was
  removed in a hotfix while the MCP server had no Dockerfile, re-added once it
  did — and then silently lost again when the release branch merged into `main`
  (the branch's file matched the merge base exactly, so git took the other
  side's removal and nothing warned). All three images are published for this
  release. The workflow now **reconciles every image the chart references
  against the registry and refuses to publish** if one is missing, so a release
  can no longer ship a chart pointing at nothing.
- **Version History was broken on every namespace of a git-native HA install.**
  App replicas hold no git tree — only the writer does — so the history
  endpoints reported "git-sync is not configured" for everything. They now
  proxy to the writer, exactly as attachments already did. Single-box and
  writer roles are unchanged.
- **Deleting a Git Workspace no longer destroys notes that exist nowhere else.**
  Decommissioning purges a namespace from storage only when a mirror
  demonstrably holds the current copy (mirroring on, last sync succeeded).
  Without one, access is revoked and the config removed but the bytes stay put
  — which matters most for a namespace that came from a `MOUNT_`, where the
  purge would have emptied a bind-mounted host directory.
- **Mirror status stops claiming "ok" for a workspace that has never synced.**
  Four honest states — `off` / `pending` / `ok` / `error` — driven by whether a
  sync actually happened, with push-to-create on a fresh remote classified as a
  benign `pending` rather than a red error.
- Personal workspaces no longer appear in the Access Grants and Namespace
  Admins pickers; they are managed by their owner, not administered by others.
- Deleting a workspace or group now revokes the namespace's grants and
  namespace-admins instead of leaving them orphaned.

### Added

- **Marp slide rendering (opt-in — `ENABLE_MARP=true`).** A note whose
  frontmatter declares `marp: true` renders as a slide deck in the Preview
  pane, so the note you drafted an idea in is the deck you present from — no
  second copy in Slides or PowerPoint to keep in sync. The source stays plain,
  diff-able, git-mirrored Markdown. Slides render per-slide in a fully
  sandboxed `<iframe sandbox="">`, which is what makes it safe to honour the
  inline HTML real decks use. Off by default; the engine is a lazy chunk, so an
  install that doesn't want slides carries **1.6 KB**, not the engine.
- **Git Workspaces admin management** — workspace groups, discovery of
  operator-provisioned sub-projects, and per-group project add/enable/remove,
  all in the Admin panel.

### Notes for operators

- If you are on **v4.0.0 with `mcp.enabled=true`**, upgrade to v4.1.0 — the
  image your chart references now exists. Nothing else about v4.0.0 needs
  action.
- `ENABLE_MARP` is plumbed through `mdnest.conf` / `setup.sh` as well as the
  chart, so it works on the single-box path too.

Thanks again to [@ecthelion77](https://github.com/ecthelion77), who found the
missing image, diagnosed it, and sent the fix.

[#76]: https://github.com/mahsanamin/mdnest/issues/76

---

## v4.0.0 — Task board, git-native HA, and bring-your-own-repo durability

The first release built substantially with outside contributions, and the
largest change to what mdnest can be deployed as since it started. Notes are
still plain Markdown files in a git repo you own — that hasn't moved, and most
of this release exists to keep it true at scales where it previously wasn't.

**A single-box install is unchanged.** The generated `docker-compose.yml` is
byte-identical to v3.11.7's, and `.env` gains exactly one line
(`ENABLE_TASK_BOARD=false`). Everything below is either opt-in or invisible
unless you run multi-user mode.

Major version because two changes require operator action on upgrade — see
Breaking changes. Huge thanks to [@ecthelion77](https://github.com/ecthelion77)
(Olivier Gintrand), who wrote most of what follows.

### Breaking changes

- **Superadmins no longer have implicit read access to note content.** A
  superadmin administers every namespace — users, grants, namespace lifecycle —
  but that authority no longer doubles as ambient access to the notes. Data
  access now flows through grants for every role. **On an existing multi-user
  install**, namespaces a superadmin never held a grant in will disappear from
  their sidebar, tree and file APIs until they self-grant; the admin surfaces
  are unchanged and still list every namespace to administer. Single-user mode
  is unaffected. This is arguably the change that makes multi-user mode
  trustworthy rather than merely functional: administering a workspace and
  reading people's notes are different powers.
- **The Helm chart runs the backend as a StatefulSet** with per-pod
  `volumeClaimTemplates` instead of a Deployment plus standalone PVCs (chart
  `0.1.0` → `0.2.x`). Upgrading an existing chart install **without action would
  delete the Deployment-era notes PVC**, so the chart now refuses that upgrade
  and tells you to adopt the volume with
  `persistence.notes.existingClaim: <release>-notes`. Fresh installs need
  nothing.

### Added

- **Task board (opt-in — `ENABLE_TASK_BOARD=true`).** A per-namespace kanban
  built on the `- [ ]` checkboxes already in your notes. **No new datastore**: a
  task *is* a line in a note, the note stays the source of truth, and every
  board action is a plain line-level edit — so anything you type in a note shows
  up on the board and vice versa. Tasks can carry an indented detail block
  (`status`, `due`, `priority`, `tags`, `steps`, `notes`) that remains readable
  Markdown you wouldn't mind seeing in a diff. Column layout lives in the
  namespace's `.mdnest/board.json` sidecar (the same convention as
  `.mdnest/comments`, and likewise hidden from the tree and from search). Adds
  four MCP tools — `list_tasks`, `create_task`, `edit_task`, `move_task`. Off by
  default: the routes aren't registered and the UI chunk isn't loaded until you
  turn it on. See `docs/tasks.md`.
- **Git-native HA — multiple replicas without ReadWriteMany storage.** A new
  `git` storage backend keeps the same on-disk layout but owns git history
  in-process (one repo per namespace), replacing the git-sync sidecar and
  debouncing commits on writer idle so an editing session becomes one commit
  rather than one per tick. Add `REDIS_URL` and it splits into N stateless
  **app** replicas plus a single **writer** that owns the git tree, with Redis
  as the coherence tier. Git stays the durable source of truth — `git log`,
  `grep` and `cp -r` all still work. **Read `docs/kubernetes.md` before choosing
  it**: on an app replica a save is acknowledged once it's on the queue, not
  once the writer has committed it, so an acknowledged write can be lost and
  Redis becomes a durability component that needs AOF. A single box, or the
  `git` backend without Redis, has an RPO of zero.
- **Per-workspace git remotes (multi mode).** Any namespace can mirror to its
  own repository rather than one operator-wide remote, and a user can point
  their personal workspace at a repo they control — so "your notes are a git
  repo you own" survives contact with a multi-team install. Credentials (HTTPS
  PAT or SSH key) are sealed with AES-256-GCM, never returned by the API, and
  never placed in argv or a URL; mdnest refuses to store one at all unless a
  non-default `MDNEST_ENCRYPTION_KEY` is set. Optional
  `GIT_REMOTE_ALLOWED_HOSTS` bounds where they can be used.
- **MCP server over streamable HTTP, with optional per-user OAuth 2.1.** The
  bundled MCP server can now be a shared network endpoint instead of a local
  stdio process, and in OAuth mode each client signs in through your existing
  SSO so actions are attributed to the real user rather than one shared token.
  **stdio remains the default and a first-class path** — with `MCP_TRANSPORT`
  unset, no listener is bound and no OAuth code is even imported.
- **Opt-in Redis backplane for live collaboration** (`REDIS_URL`), so presence
  and edits stay in sync across replicas. With it unset the hub is exactly the
  in-process one it always was — no goroutine, no allocation per event.
- **Opt-in SSO user auto-provisioning** (`SSO_AUTOPROVISION_USERS=true`): an
  unknown but IdP-authenticated email is created as a least-privilege
  collaborator with **no grants**, instead of being rejected. Off by default.
- **Task-board support in the Helm chart** — `taskBoard.enabled`.

### Changed

- **API tokens live in PostgreSQL in multi mode** (single mode keeps
  `tokens.json`, and gains no database). Existing tokens are imported from
  `tokens.json` on first start, so an upgrade doesn't invalidate them. This is
  what finally removed the last ReadWriteMany requirement for running multiple
  replicas.
- **A namespace-scoped `storage.Storage` interface** now sits between the
  handlers and the filesystem, which is what made the `git` backend possible
  without rewriting request logic — and made the handlers testable.
- Note history and namespace listing move through the storage layer, and
  `/api/files/` keeps range requests and conditional GETs (so image caching and
  media seeking still work).

### Fixed

- **Ticking a task off in the Live editor now sticks.** The box changed, the
  file didn't, and a refresh brought the tick back — so a card moved to Done
  couldn't be un-done from the note. The editor's save gate stayed armed until
  a keypress or a click landed inside the document, and ticking a checkbox
  produces neither (ProseMirror handles it internally), so every checkbox edit
  in a freshly opened note was dropped for the whole session. The gate is now
  scoped to the document injection it exists for. Pinned by a new
  `tests/browser/kanban.spec.js` — six specs covering the board, task parsing
  and both checkbox directions, asserted against the bytes on disk.
- **Editing your own note no longer raises a conflict banner or jumps the
  cursor.** The backend fans `file-changed` to every connection on a note
  including the tab that just saved; the handler now recognises its own echo.
  Broadcast latency made this near-constant on a multi-replica deployment. A
  same-user write from the CLI or MCP still propagates.
- A namespace created for a personal workspace is materialised only once it
  actually mirrors somewhere, so it can't exist as an undurable directory.
- The task board and the live editor are both lazy-loaded, so neither is on the
  critical path for someone who doesn't open them.

### Security

- **Command execution via a crafted git remote URL** *(unreleased code)*.
  `remote_url` and `branch` were passed to `git` as positional arguments, so a
  value starting with `-` was parsed as an option — `--upload-pack=<cmd>`
  executes `<cmd>`. Any authenticated user could reach it through their own
  personal workspace, giving command execution in the writer, the process
  holding the sealing key and every workspace's credentials. Now blocked at the
  API boundary *and* with `--end-of-options` at the exec site; each layer was
  verified to stop it alone.
- **OAuth authorization codes could be delivered to an attacker-chosen host**
  *(unreleased code)*. `/oauth/authorize` accepted any HTTPS `redirect_uri`
  without checking it against a registered client, and PKCE doesn't help when
  the malicious client starts the flow. Delivery is now restricted to loopback
  plus origins explicitly listed in `MCP_ALLOWED_REDIRECT_ORIGINS`.
- Superadmin implicit read access removed — see Breaking changes.
- API-token list and revoke ownership scoping is now pinned by tests; nothing
  covered it before.

---

## v3.11.7 — XSS hardening, cross-namespace file leak fixed, Helm chart, build CI

_First release with outside contributions. Thanks to [@ecthelion77](https://github.com/ecthelion77) (Olivier Gintrand) for the sanitization hardening, the `/api/files/` authorization fix, the Helm chart, and the CI workflows._

### Security

- **Rendered markdown, release notes, and mermaid SVG are now sanitized before they reach the DOM.** Note bodies are user-authored and shared between users in multi-user mode, and marked passes raw HTML through by design — so a note containing `<img src=x onerror=…>` or a `javascript:` link href executed when anyone previewed it. All three injection points now run through a single `frontend/src/sanitize.js` module (DOMPurify): event-handler attributes and dangerous URI schemes are stripped, and `<a target="_blank">` gets `rel="noopener noreferrer"` so external links can't reach back into the opener. The Preview's own post-passes are unaffected — `class`, `data-*`, and task-list checkboxes all survive sanitization.
- **A signed-in user could read files from namespaces they had no grant for.** `GET /api/files/<ns>/<path>` — the endpoint that serves uploaded images and attachments — carried its namespace in the URL path rather than the `?ns=` query param, so it couldn't use the query-param permission middleware and was registered with authentication only. Any authenticated principal, including an API token, could fetch any file in any namespace by guessing the URL. It now enforces the same per-namespace read check as every other content endpoint. Single-user mode is unaffected.
- **`google.golang.org/grpc` bumped to v1.82.1 for [GO-2026-6061](https://pkg.go.dev/vuln/GO-2026-6061)** — vulnerabilities in the xDS RBAC authorization engine and the HTTP/2 transport server. It arrives transitively through the Firebase/Google Cloud SDK, and `govulncheck` confirmed reachable symbols in the built binary, so it's a real exposure rather than an unused-code advisory. Caught by CI on the release PR — the local pre-push hook skips `govulncheck` when Go isn't installed on the host, which is precisely why the CI check is the authoritative gate.
- **Four npm advisories cleared, two of them high severity.** `postcss` ≤8.5.17 ([GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), arbitrary `.map` disclosure via source-map auto-loading) and `fast-uri` ([GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6), host confusion via failed IDN canonicalization) were both failing the Security Audit on `main` — and because that audit is a required check with no bypass, the red gate blocked every merge. Also picks up `dompurify` ([GHSA-c2j3-45gr-mqc4](https://github.com/advisories/GHSA-c2j3-45gr-mqc4)) and `protobufjs`. All transitive, so lockfile-only — no `package.json` change and no new packages.

### Kubernetes

- **An opt-in Helm chart for clusters, alongside the usual Docker Compose install.** `deploy/helm/mdnest` deploys the backend, the nginx frontend, and an optional git-sync sidecar as standard Kubernetes resources — no CRDs, no operator, PostgreSQL never bundled. Ingress, TLS, resource limits, probes, PVCs, and a ServiceAccount are all configurable; `helm lint`, both renders, and `kubeconform -strict` run in CI. Nothing about the Compose path changed: `setup.sh`, `mdnest.conf`, `docker-compose.yml`, and the Dockerfiles are untouched, and the chart is inert unless you use it. Supported today is single-replica `single` or `multi` mode with live collaboration, git-sync, ingress, and TLS. Three options are documented but **rejected at install time** because their code isn't in this release — `storage.backend=s3`, `collab.redis.*`, and `mcp.enabled` — so the chart fails loudly instead of coming up `Ready` while writing notes to the wrong place or splitting collaboration state across pods.

### CI

- **Build and test now run server-side on every push and PR, not just in a local pre-push hook.** `.github/workflows/ci.yml` runs the backend build, `go vet`, and `go test -race`; the frontend build and unit tests; the Helm chart lint/render/validate; and a build of the backend and frontend images. The pre-push hook still exists as fast local feedback, but it can be skipped with `--no-verify` and silently omits `govulncheck` on a host without Go — so the authoritative gate is CI.
- **A release workflow publishes container images and the Helm chart on version tags.** `v*` pushes build and push `mdnest-backend`, `mdnest-frontend`, and `mdnest-mcp-server` to `ghcr.io/<owner>/`, then package and push the chart as an OCI artifact. Everything is parameterized by repository owner, so a fork publishes under its own namespace with no edits.
- **The Security Audit now also runs on PRs into `develop`.** It was scoped to `main`, so a contribution integrated on `develop` wasn't scanned until the release PR — which is when the two advisories above were found, well after the code had landed. `main`'s required checks are unchanged; this only moves the signal earlier.

### Bug fixes

- **Mermaid diagrams rendered as blank boxes once SVG sanitization was added.** DOMPurify's SVG profile doesn't allow `<foreignObject>`, and mermaid renders every flowchart node label inside one — so sanitizing deleted the text of every label while the boxes and arrows still drew. Nothing threw and no console error appeared; the diagram simply looked empty. `foreignObject` is now allowed, which doesn't weaken the sanitizer: scripts, iframes, objects, embeds, forms, and every `on*` handler inside it are still stripped, and each of those is pinned by a test.
- **The Helm chart shipped pointing at the contributor's fork.** Its default image repositories, `home`/`sources`, maintainer, and README install command all referenced a third party's registry and repo, so `helm install` from a checkout of this repo pulled someone else's images. Its `appVersion` was also frozen at the previous release, so a source install requested stale image tags.

### Testing

- **Regression coverage at the layer that would have caught each bug.** `backend/handlers/upload_test.go` is the repo's first Go test — it asserts a collaborator granted in one namespace gets `403` on another, that a superadmin reads both, and that single-user mode is unaffected; with the authorization check removed it reports the actual cross-namespace leak. `frontend/src/__tests__/sanitize.test.js` pins both directions of the sanitizer: `foreignObject` and its label text survive, six smuggled payloads and inline handlers don't. And the browser suite now seeds a note containing a mermaid flowchart and asserts the **label text** is visible in Preview — asserting only that shapes rendered would have passed while every label was missing. All three were confirmed to fail with their respective fix reverted.

---

## v3.11.6 — Clearer pitch, reveal-in-tree, instant cross-tab sync, security gate

### Docs

- **The README and landing page now say what mdnest is in ten seconds.** The old README opened with deployment details and a flat wall of features, so a first-time reader couldn't tell what mdnest is or who it's for. It's rewritten in product-style copy: a one-line tagline (*"Your notes, on your own server. Open to every device — and your AI."*), a screenshot up top, a short **What you get** list, an **Is it for you?** self-check, and an honest one-line Obsidian comparison — with the full feature list preserved in a **More features** section below the fold. The `mdnest.dev` landing page (hero, meta/OG/Twitter/JSON-LD, and the AI-native/team/git-sync cards) is synced to the same framing.

### Features

- **Reveal-in-tree.** A button jumps the left tree to the currently-open note and highlights it — handy after following a wikilink or searching, when the file is open but not visible in the tree.
- **Instant cross-tab tree + sync updates.** Creating, renaming, moving, or deleting a note in one browser tab now updates the tree in every other open tab immediately, and git-sync-driven changes land without a manual Refresh — no more stale tree until you reload.

### Bug fixes

- **The build-details popover closes on an outside click.** It previously stayed open until you clicked the ⓘ again; it now dismisses when you click anywhere else, like every other popover.
- **The Live editor block handle is no longer clipped behind the tree sidebar.** The drag/`+` handle in the left margin could render underneath the sidebar on narrow layouts; it now stays fully visible.

### Security / CI

- **Security Audit is now a required status check before merge to `main`.** The audit (frontend/MCP `npm audit`, backend `govulncheck`, shellcheck) already ran on every PR, but wasn't *required* — so a PR could merge with a failing check (that's how a stdlib vuln once slipped onto `main`). It's now enforced server-side on the `main-branch` ruleset with no bypass. The pre-push hook mirrors the govulncheck gate locally, and the ruleset is captured as importable JSON so the gate is managed as code.

---

## v3.11.5 — Obsidian wikilinks

### Features

- **Obsidian-style `[[wikilinks]]` are now first-class links.** Vaults imported from Obsidian lean on `[[wikilinks]]`, which mdnest previously rendered as plain text. Now `[[target]]`, `[[target|alias]]`, `[[target#heading]]` and `[[#heading]]` render in the preview as internal links that open the note in-app with no page reload. The href still carries the `#ns/path` form, so middle-click and open-in-new-tab keep working, and a same-note `[[#heading]]` link just scrolls the preview to that heading. Targets resolve Obsidian-style against the namespace tree — an exact path first (with or without the `.md` suffix), then a case-insensitive basename match with a shortest-path tiebreak; an unresolved target renders as a muted, non-clickable broken-link span so you can see the note is missing. Relative markdown links to `.md` files (`[text](../notes/other.md)`) now navigate in-app too, instead of opening a dead file URL in a new tab.
- **Wikilinks are visible and clickable in the Live editor.** `[[...]]` spans get a link-coloured highlight, and Ctrl/Cmd+Click opens the target (plain click still places the caret, so editing is unaffected). This is decoration-only — no schema change — so the stored markdown stays literal `[[...]]`. Round-trip fidelity is guaranteed: Milkdown's serializer escapes `[[` to `\[\[` in plain text, so every save is routed through a restore pass that keeps documents byte-identical. Code spans and fenced code blocks are excluded, so `[['field' => 'x']]` in a PHP snippet stays code, not a link.

_Thanks to [@lglot](https://github.com/lglot) (Luigi Lotito) for contributing this feature._

---

## v3.11.4 — git-sync self-healing, fresh-machine CLI, tree memory + local test gate

### Bug fixes

- **git-sync now converges instead of looping forever on a diverged, dirty tree.** When a notes repo was simultaneously ahead and behind its remote *and* had uncommitted live-editor edits, the old sidecar kept failing the same way every cycle: a `git pull --rebase` couldn't start against the dirty tree, so it never integrated the remote, the local commit never pushed, and the divergence only grew (one namespace fell 118 commits behind unnoticed). The pull is now merge-only and self-healing — it autostashes the working tree (tracked + untracked) so the merge always starts, distinguishes a real content conflict (keep remote, save local copies as `.sync-conflict-*`) from a merge that simply couldn't begin (abort cleanly, retry next cycle), and re-applies the stashed edits on top of the merged result (saving a recoverable `.mdnest-sync-autostash-*.patch` if they collide). Push is now gated on HEAD actually containing the remote, so a non-fast-forward can never spin. Each cycle writes a git-excluded `.mdnest-sync-status.json` (`state`/`ahead`/`behind`/`message`), and the bookkeeping files are added to `.git/info/exclude` so they're never committed.
- **A broken background sync is now visible instead of silent.** `/api/admin/sync-status` overlays the daemon's self-reported health (`daemonState`/`daemonMessage`/`ahead`/`behind`), and the sidebar polls it every 60s. When the daemon reports `error`, the status bar shows a red ✕, a "Git sync broken — N behind" label with the reason in its tooltip, and a **Retry** button for admins (runs commit + pull + push). Previously a wedged sync only showed a stale "Synced X ago" date, hiding the failure entirely.
- **A fresh multi-mode install is usable out of the box again.** The first-run bootstrap seeded its one account with the literal role `admin`, which since the v3.5.0 three-tier role split means "namespace-scoped admin with no namespaces assigned" — so the only account saw zero namespaces and had no way to grant itself access (the grant dropdowns are themselves role-filtered). Migration 007 only promotes pre-existing `admin` rows, not ones the seed creates after it runs. The bootstrap account is now seeded as `superadmin` (global); the existing `count == 0` guard keeps this to the very first user, so later invitees are unaffected.
- **The `mdnest` CLI works on a fresh machine without `python3`.** The CLI hard-depended on `python3` for URL-encoding note paths, parsing the server version, and scoping `list <subfolder>` — with no fallback. On a machine without `python3`, note commands broke and `mdnest servers` labelled a perfectly reachable server "unreachable" because it conflated a failed *fetch* with a failed *parse*. Now `urlencode`/`urldecode` have pure-bash fallbacks, JSON fields are read via `python3` → `jq` → a brace-depth-aware `awk` (so the top-level `version` is returned, not `latestRelease.version`), and `list <subfolder>` scoping falls back to `jq` then an `awk` subtree extractor. `mdnest servers` now separates connectivity from parsing (using curl's exit code) and reports the real reason on failure (DNS/refused/timeout/TLS), with a `--connect-timeout` so it never hangs. A one-time note suggests installing `python3` for the best experience.
- **The CLI installer no longer aborts mid-download on a fresh machine.** `install-cli.sh` wrote curl's output straight to `/usr/local/bin/mdnest`, which fails with `curl: (56) Failure writing output to destination` when that directory doesn't exist yet or isn't writable. It now downloads to a temp file, sanity-checks it, creates the target directory, and installs atomically — with a `~/.local/bin` fallback (plus a PATH hint) when `/usr/local/bin` can't be used. `mdnest update` uses the same safe temp-download + atomic-install path, and resolves its own location without `readlink -f` (unsupported on macOS) or python3.
- **Install or update from any branch.** `install-cli.sh` and `mdnest update` honour `MDNEST_BRANCH` (default `main`), so `curl -fsSL .../develop/install-cli.sh | MDNEST_BRANCH=develop bash` installs the develop build — the installer still handles sudo/`mkdir`/atomic-install for you (no manual `sudo` needed).
- **Left tree remembers which folders are open, per namespace.** A refresh used to re-expand all top-level folders and forget whatever you'd collapsed, and the expand/collapse icons flickered. Expansion is now a per-namespace set persisted in `localStorage` (restored on load and namespace switch); the open file's ancestors still auto-reveal and search still force-expands matches.
- **Folders containing the open file can be collapsed again.** A regression made any folder on the path to the currently-open note impossible to collapse — it sprang back open immediately. The tree used to force such folders expanded (`containsActive`); now the open file's ancestors are added to the persisted expansion set once (so they auto-reveal) but stay freely collapsible.
- **Copy Path is now unambiguous, and `mdnest://` URIs work in the CLI.** Copy Path produced `mdnest://@alias/ns/<path>` with raw spaces, so a path like `19 Jun 2026.md` looked like three tokens to an LLM/shell. Path segments are now percent-encoded (`19%20Jun%202026.md`), and the CLI's `parse_path` strips a leading `mdnest://` and percent-decodes the namespace + path, so the copied URI is usable verbatim (raw CLI paths containing a literal `%` are left untouched).
- **Every code snippet in Settings has a one-click copy button.** The CLI / MCP / API tabs showed install commands, the login line, usage examples, the MCP config JSON, and curl examples as plain blocks you had to hand-select. Each now has a copy icon (with a "Copied!" confirmation) — works on both HTTPS and plain-http LAN installs.

### Testing

- **Local, end-to-end pre-merge test gate — no CI/remote required.** A tiered harness runs before code reaches `main`: `tests/cli-unit.sh` (instant pure-function checks, run both with `python3` and with it force-disabled — the cheap guard for the fresh-machine regression class); `tests/e2e-docker.sh` (builds the backend from the working tree, boots a throwaway single-mode instance, and drives the real CLI against it on the host **and** inside a bare no-python3 container); and `tests/e2e-browser.sh` (boots the full frontend+backend stack and runs a Playwright browser suite covering login, tree, opening/rendering a note, the Live and Basic editors, search, and note creation). The pre-push hook runs the unit tests on every push and the full Docker + browser suites when pushing toward `main`. The Docker harness immediately caught the `list <subfolder>` no-python3 gap fixed above.

---

## v3.11.2 — CLI list/move fixes + prettier update indicator

### Bug fixes

- **`mdnest list <ns/subfolder>` now scopes to that subfolder.** It used to ignore the deeper path and return the entire namespace tree. Now it returns just that folder (its children) or the file entry, and errors with a non-zero exit on a missing path.
- **`mdnest move` no longer loses content when given a full destination path.** A full `@alias/namespace/path` destination (the style typed for the source) made the server treat `@alias/namespace/` as literal folder names and relocate the file to a bogus path — the intended destination then read empty and write/delete returned 404. The CLI now normalizes the destination to a namespace-relative path and rejects cross-namespace moves.
- **The "new version available" indicator no longer renders as an oversized cream blob.** On a narrow sidebar the old badge wrapped its `↑` and version onto two lines inside a pill, which looked broken. The alert is now folded into the build-details **ⓘ**: when an update is available the icon turns accent-blue and gently pulses (respecting `prefers-reduced-motion`), and clicking it opens the popover with the build details plus a tidy "↑ vX.Y.Z available — see what's new" action. Removed the standalone badge.

---

## v3.11.1 — Live editor mermaid sizing + contrast

### Bug fixes

- **Mermaid text is now always readable, whatever fill the source specifies.** Author/AI-written diagrams that set a light node fill (`style X fill:#fff8e1`, a light `classDef`, …) rendered as light-text-on-light-fill — invisible. The Live editor was injecting a blanket `.nodeLabel { color:#cdd6f4 !important }` override that forced *every* label light, fighting the per-node brightness logic that's supposed to pick contrast. Removed the blanket override so `fixMermaidTextColors()` is the single authority: each label's color is computed from its own node's fill brightness (dark text on light fills, light text on dark), so contrast holds regardless of the colors the author chose. (Print/export keeps its own light-page palette.)

- **Mermaid diagrams now render at a sensible size in the Live editor.** Small diagrams ballooned to full width while large/tall ones shrank into a corner — because every rendered SVG had its real dimensions stripped and was forced to `width:100%`, then classified by width alone (`<400px` = "small"), so a wide `flowchart LR` filled the pane (stretched up) and a narrow `flowchart TB` rendered at its tiny natural width with empty space beside it. Now the SVG keeps its **natural width, capped at the container and at a 820px max** (`width:<natural>px; max-width:min(100%, 820px); height:auto`): small diagrams stay small (no stretching), large ones scale **down** to fit (no shrinking into a corner) and don't sprawl past 820px on wide screens, and the zoom/Fit controls layer on top. The preview box also lost its oversized `200px` min-height and `2rem 3rem` padding, so a tiny inline diagram no longer sits in a giant empty frame.

---

## v3.11.0 — CLI stdin fixes + smoke-test harness

### Added

- **Build commit shown next to the version.** `/api/config` now reports a `commit` field — the short git SHA the backend binary was built from, injected at build time via `-ldflags` (computed by `setup.sh`, passed through docker-compose as a build arg, baked into the binary). The sidebar footer renders it as `v3.11.0 · <sha>`, and `mdnest servers` shows it as `3.11.0 (<sha>)`. Because the SHA is compiled into the binary rather than read from config, it can't drift from the running code — so a stale container is now obvious even when the version string hasn't changed (the exact situation where a rebuilt `develop` still displayed an old version). Falls back to `dev` for local `go build` without the ldflag.
- **Build-details popover (ⓘ) with build time.** A short SHA alone isn't very legible, so the sidebar version now has an info button that opens a small popover showing the version, the commit (linked to its GitHub commit page), and **when the running build was produced** — a `buildTime` field newly added to `/api/config`, baked in via `-ldflags` alongside the commit (UTC timestamp computed by `setup.sh`, rendered in local time). Answers "is this the build I just deployed, and when?" at a glance.
- **Live editor: reclaimed the left space.** Crepe reserved an ~88px left gutter for its hover drag/`+` block handles, wasting ~20% of the width on mobile. The handle is now a compact **vertical grip** sitting flush in a **28px** gutter (no empty lane beside it), list indentation is tightened (marker column 24px→20px, marker→text gap 10px→4px) so bullets hug the left, and a Live-toolbar **toggle** hides the handle entirely for full-width content (**16px** margin). The slash `/` menu keeps working with the handle hidden. The state persists per browser and defaults to hidden on **touch devices** (`hover: none` / `pointer: coarse`), shown on pointer devices.
- **Live editor: toolbar buttons work reliably on touch + a real Link prompt.** Toolbar formatting buttons used `mousedown`, which doesn't preserve the editor selection on touch devices, so most icons did nothing on mobile; they now use `pointerdown` (covering touch) and refocus the editor after running, so bold/heading/list/etc. apply to the selection. The Link button now prompts for a URL and applies it as the link `href` (previously it toggled a link mark with no destination — a dead link).

### Bug fixes

- **`mdnest create` now accepts piped stdin via `-`, like its sibling verbs.** Previously `create` forwarded its positional argument straight to the API, so `echo "# Note" | mdnest create @ns/file.md -` wrote the literal one-byte string `-` as the file body — and the API still returned `{"status":"created"}`. The result was a silently corrupted (near-empty) file reported as a success, which is the most common way automated tooling (scripts, AI agents) corrupted notes: the command "succeeded", nothing retried, and the bad file surfaced much later. `create` now reads stdin on `-` (or an omitted arg) exactly like `write`/`append`/`prepend`.
- **Robust, TTY-aware stdin handling with a literal-dash guard.** All content verbs now route through a shared `read_content()` helper: `-` reads stdin and errors with a non-zero exit if nothing was piped (instead of writing a literal `-`); an omitted arg auto-reads stdin only when piped and never blocks on an interactive terminal. This removes both the TTY-hang footgun and the literal-`-` corruption path.
- **Empty content now fails loudly instead of reporting false success.** `create`/`write`/`append`/`prepend` refuse to issue the API call when no content was supplied, printing a clear message and exiting non-zero rather than creating an empty file and returning `ok`. (The guard returns success explicitly on the happy path so it is safe under the script's `set -e`.)

### Testing

- **New CLI smoke-test harness — `tests/cli-smoke-test.sh`.** 18 end-to-end checks covering every note operation (create/write/append/prepend/read/move/delete/search/list) plus the stdin edge cases above, run against a disposable namespace. It tests the working-tree CLI, creates everything under a unique self-cleaning folder, and exits non-zero on any failure. Run it after any change to the `mdnest` CLI. A new optional `MOUNT_testing_workspace` mount (documented in `mdnest.conf.sample`) gives it a dedicated namespace.

### Security / CI

- **MCP server: bump `hono` to clear a high-severity advisory** (transitive via `@modelcontextprotocol/sdk`). `npm audit` now reports zero vulnerabilities.
- **Frontend: bump `vitest` 2.x → 4.x** to clear the vulnerable `vite`/`vite-node`/`@vitest/mocker`/`esbuild` dev-toolchain chain (a high + a critical). The production build's direct `vite` was already on a fixed version; only the test runner's pinned `vite@5` was affected. Tests still pass (11/11) and `vite build` is unchanged.
- **Backend: run `govulncheck` in binary mode.** `govulncheck@latest` (v1.4.0) segfaults in source mode (nil pointer deref in `vulncheck.vulnFuncs`) when analysing code built with the Go 1.26.x toolchain that `go.mod` pins. Building the binary and scanning it with `-mode=binary` avoids the crashing source-SSA path while still detecting reachable vulnerable symbols; the local pre-push hook does the same. Also points setup-go's module cache at `backend/go.sum` to clear a warning.
- **Backend: bump Go 1.26.3 → 1.26.4** (`go.mod` + Dockerfile builder image) to clear two called standard-library advisories surfaced by the now-working govulncheck scan: `GO-2026-5039` (`net/textproto` error escaping) and `GO-2026-5037` (`crypto/x509` candidate-hostname parsing), both fixed in go1.26.4.

---

## v3.10.2 — Live editor list alignment + "Refresh Now" feedback

### Security

- **Bump `golang.org/x/net` v0.53.0 → v0.55.0** to clear `GO-2026-5026` (IDNA `idna.ToASCII` fails to reject ASCII-only Punycode-encoded labels — reachable from the in-app update poller's outbound `https://api.github.com/...` request via `http.Client.Do`). Transitive bumps: `x/crypto` 0.50→0.51, `x/sys` 0.43→0.45, `x/text` 0.36→0.37. `govulncheck ./...` now reports zero vulnerabilities.

### Bug fixes

- **Live editor: nested bullets / task items no longer appear as floating orphans between sub-rows.** Symptom (most visible at depth ≥ 2): a parent item's bullet drifted down to sit halfway through its own nested children, looking like a stray dot sandwiched between two unrelated sub-bullets. Root cause: the v3.10.0 Crepe migration added speculative CSS overrides on the list-item layout — most damagingly `align-items: center` on `.list-item`. Crepe's DOM for a list row is `[label-wrapper | children]`, and `.children` contains the parent's paragraph **plus** every nested `.milkdown-list-item-block`. Centering the bullet vertically against that whole stack pushed the parent's bullet to the visual midpoint of all its descendants. The fix strips every speculative list-item override and trusts Crepe's playground defaults for sizing / gap / alignment — the only override left is a single `.milkdown-list-item-block p { margin: 0 }` rule to neutralise the app-wide `p { margin: 0.4rem 0 }` that leaked into list rows (Crepe inserts a `<div class="content-dom">` between `.children` and `<p>`, so the previous `.children > p` selector was silently missing the paragraph and the leaked margin offset the bullet from the text's optical centre).
- **"New version available" banner's Refresh Now button now shows `Refreshing…` immediately on click.** Symptom: a user clicked the button after upgrading their server from v3.9.1 to v3.10.1, "nothing happened" visibly, then the tab appeared frozen and they had to kill the browser. Diagnosed: the click was actually triggering `window.location.reload()`, but the v3.10+ bundle is heavier than v3.9 (Crepe + Vue + CodeMirror + KaTeX ≈ 340 KB gzipped) and parsing it during the reload can take several seconds on a slow connection or low-memory device — during which the OLD tab stays visually idle because the click handler didn't update any UI before calling reload. Two changes: (a) set a `refreshing` state immediately on click so the button reads `Refreshing…` and goes `disabled` before the reload starts, giving the user an instant signal that the click registered; (b) drop the deprecated `true` argument from `window.location.reload(true)` — it was Firefox's non-standard "forceGet" flag that no other browser ever implemented and Firefox itself dropped years ago, so it was already a no-op everywhere but spec-incorrect.

---

## v3.10.1 — Login form: proper password-manager hints + per-server scoping + "Keep me signed in"

### New features

- **"Keep me signed in" checkbox** on the login form. Default ON. When checked the backend issues a 1-year JWT instead of the default 30 days, so users on personal/trusted devices stop getting unexpectedly logged out. Unchecked = 30-day TTL (the previous default) — appropriate for shared / kiosk sessions. The flag threads through every multi-step path (initial login → TOTP verify → forced password change) so the final JWT gets the right TTL regardless of which path the user takes. SSO and Firebase login default to the long-lived TTL since they have no checkbox UI of their own (their IdPs own the "stay signed in" UX). Backend helper `jwtTTL(rememberMe)` in `backend/handlers/auth.go` is the single source of truth.

### Bug fixes

- **Browser password-manager hints on the login form.** The username and password inputs were missing `name` + `autocomplete` attributes, so browsers couldn't reliably offer to save credentials and couldn't autofill them on return visits. Added `autoComplete="username"` / `autoComplete="current-password"` (and `"new-password"` on the forced-password-change step) so the "Save password?" prompt appears at the right time and re-visits get autofilled.
- **Per-server credential scoping (best-effort).** When the user runs multiple mdnest installs, browsers were lumping their saved credentials together — typing into one install's login form would try to autofill another install's password. The form's `name` and `id` now include the server's `SERVER_ALIAS` (read from `/api/config`) plus a hidden `server` input field. Together those make the form's identity distinct per install for password managers that fingerprint form structure (1Password, Bitwarden, KeePassXC). Browsers' built-in password managers (Chrome, Edge, Safari, Firefox) scope primarily by HTTP origin and use the Public Suffix List for autofill suggestions — they conflate sibling subdomains (`brain.example.com` and `wbrain.example.com` both autofill from the `example.com` record). For full per-install isolation, give each install a different parent domain, or in 1Password/Bitwarden set the saved entry's URL match to "Host" or "Exact".
- **Post-login password forms don't trigger save-prompts at the wrong time.** Settings → Change Credentials, the Admin → Reset Password modal, and the Admin → Create User form all had bare `<input type="password">` with no `autocomplete` attribute. Browsers would see those after login and offer to save / autofill the wrong credentials (which is what the user was seeing as "weird dialogue prompts inside when logged in"). Added the correct `autocomplete="current-password"` on current-password fields, `"new-password"` on every new/confirm field, `"username"` where applicable, and `autoComplete="off"` on the wrapping forms — so password managers don't mistake these for login forms after sign-in.
- **LICENSE copyright corrected** — the MIT LICENSE shipped from the initial release commit with the wrong copyright holder ("Ahsan Nabi Dar") — a template artifact that survived because nobody re-reads LICENSE on each release. Now reads `Copyright (c) 2026 Ahsan Amin`, matching the actual repo owner.
- **`docs/security.md` "Defense layers at a glance" mermaid diagram renders on GitHub.** The diagram failed to render in GitHub's docs viewer (and on mdnest.dev) with `Parse error on line 2: ...Expecting 'SQE', 'DOUBLECIRCLEEND', ... got 'PS'`. Cause: node labels like `net[Network boundary<br/>(loopback, Tailscale, …)]` contain unquoted parentheses inside a `[...]` square-bracket node, which mermaid interprets as a nested round-bracket shape definition. Wrapped the affected labels in `"…"` (the mermaid escape for "treat literally") — renders correctly on GitHub, on mdnest.dev, and in our own Live editor.
- **Update-available banner surfaces within ~minutes of a release, not a day.** Two cadence issues: the backend poller was hitting `https://api.github.com/repos/<owner>/<repo>/releases/latest` every 24 hours, and the frontend only fetched `/api/config` once per page load — so a long-running tab would never see a new release at all. Dropped the backend interval to 1 hour (still 1/60th of GitHub's unauthenticated rate limit) and changed the existing 60s `/api/config` poller on the frontend to refresh `appConfig.latestRelease` (it only updates state when the release version actually changed, so re-renders stay cheap). End-to-end: a new GitHub Release now shows up in the sidebar footer within roughly one hour of being published, no manual refresh needed. Also: the v3.10.0 GitHub Release was published this cycle — before that the API returned 404 from `/releases/latest` because we'd been pushing tags without publishing Releases. Both `CLAUDE.md`'s release process and the `/mdnest-ship` skill now require `gh release create` as Step 11 alongside `git push --tags`.

---

## v3.10.0 — Live editor migrated to Crepe + per-workspace last-file memory

The big one: the Live editor is now built on [`@milkdown/crepe`](https://milkdown.dev) — the same component the Milkdown playground uses. The pre-v3.10 hand-rolled `@milkdown/core` + commonmark + GFM stack is gone. Crepe brings a block-edit handle (drag + `+` button + slash menu), native SVG task-list checkboxes, KaTeX math, polished tables with column / row controls, link tooltip, and an image-block upload affordance. All four custom plugins from v3.9 (mermaid live edit, comments, in-cell `[ ]`/`[x]` checkboxes, clear-empty-block) port forward; the Catppuccin Mocha look is preserved.

This release also rolls up the v3.9.1 changes (paste-handler priority, browser tab title, Vitest scaffolding) — they shipped on the migration branch as the first commit and never got their own tag.

### New features

- **Block-edit menu** — hover the left margin of any block to get a drag handle and `+` button. The `+` button opens Crepe's slash menu (Heading 1-6, code block, math, image, hr, table, …). Typing `/` anywhere in the doc opens the same menu inline.
- **Native task-list checkboxes** — top-level `- [ ] foo` items now render as proper SVG checkboxes (clickable to toggle). Replaces the v3.9.2 hand-rolled `topLevelTaskCheckboxPlugin` which never looked right.
- **KaTeX inline + block math** — `$inline$` and `$$block$$` render via KaTeX. Auto-detected as markdown; no special syntax needed beyond the dollar signs.
- **Image upload UI** — slash-menu → Image inserts a placeholder block; click to upload or paste a URL. Pasting an image from clipboard works the same way (PNG screenshots, etc.). Uploads go to `/api/upload` and the rendered `<img>` resolves through a new `proxyDomURL` that rewrites the bare-filename markdown src into `/api/files/<ns>/<dir>/<file>?token=…`.
- **Auth middleware accepts `?token=<JWT>`** — for browser GETs that can't set an `Authorization` header (`<img>` tags, future `<a>` downloads). Same validation flow as Bearer; both JWT and `mdnest_…` API tokens accepted. Without this, images upload-but-never-display because `/api/files/…` requires auth and the browser image fetch had no way to provide it.
- **Per-namespace last-opened-file memory** — switching workspaces and switching back restores whichever file you had open in that workspace, with its scroll position. Stored in `localStorage` under `mdnest_last_path:<ns>`. URL hashes (`#ns/path`) still win for bookmarks. Stale entries (file deleted, moved, or renamed) are cleaned up automatically as the operations happen, and the note-loading effect's catch handler clears any that slip through.
- **Mermaid auto-detect on paste** — pasting raw mermaid source (text that starts with `flowchart TD`, `sequenceDiagram`, `graph LR`, etc.) auto-wraps it in a ```mermaid` fence and renders. The detector is intentionally strict: pastes that ALSO look like markdown (contain `#` headings or `|` table rows) are routed to the markdown path instead, so a document that just happens to mention "user journey" or "pie chart" doesn't get swallowed into a mermaid block.

### Mermaid rendering preserved

The legacy `MermaidBlock` React component (Preview / Source toggle, zoom, Fit, Copy, fullscreen viewer, "click any label to edit") stays. Crepe's `code-mirror` feature is kept enabled (its LaTeX feature depends on it) and a composing plugin wraps the `code_block` nodeView so `language=mermaid` blocks render via the React component while everything else falls through to Crepe's CodeMirror block. The fallback was important: without it disabling code-mirror crashed the editor on any `$…$` math because LaTeX's editor uses CodeMirror internally.

### Paste-fidelity contracts (v3.9.1 priority + new ProseMirror bypass)

- **`data-pm-slice` bypass** — when the clipboard HTML carries ProseMirror's slice marker (you copied from another mdnest tab / another Milkdown), the custom paste handler returns early without `preventDefault()`. Milkdown's native `parseSlice` then reconstructs the doc with full schema fidelity — table cells keep their inline marks (e.g. `**Enigma**` in the first column), fenced code blocks keep their language tag, link attributes survive. The previous behavior routed everything through `htmlToMarkdown → markdownToSlice`, which flattens GFM-specific structure.
- **v3.9.1 priority preserved** for external clipboards — plain-text-that-looks-like-markdown wins over rich HTML, so Obsidian's `- [ ] Foo` task lists stay task lists.
- **Code-block paste fix** — when the cursor is inside a code fence, the custom paste handler returns early so multi-line SQL / JS / etc. pastes as plain text into the block instead of being broken into one paragraph per line.

### Table-editing polish

- **Single-click cursor placement** — Crepe's default behavior turned the first click on a cell into a node-selection over the cell content (caret only appeared on the second click). Wrapped Crepe's table nodeView to let plain mousedowns fall through to ProseMirror's normal cursor placement.
- **Visible caret in cells** — set `caret-color: #89b4fa` on the editor; browser's `auto` was being swallowed by the dark cell backgrounds.
- **Inline code wraps inside cells** — `white-space: pre-wrap; overflow-wrap: anywhere` on `code` inside `.milkdown-table-block`, so long URLs / endpoint paths break instead of clipping.
- **Table-level horizontal scroll fallback** — `overflow-x: auto` on `.milkdown-table-block` so tables wider than the editor pane scroll horizontally instead of pushing the rightmost columns off-screen.
- **Drag handle anchors to the table** — Crepe's default block-edit filter explicitly rejects tables, so the drag handle skipped past them. Overrode `blockConfig.filterNodes` to reject nodes whose `$pos` is inside a table while accepting the table itself, so clicking the 6-dot handle selects (and lets you drag) the whole table. Selected-state outline (`2px #89b4fa`) added so the selection is visible against the table's own cell backgrounds.
- **Mermaid block selection outline** — same fix as tables, on `.mermaid-live-container.ProseMirror-selectednode`, so Delete-from-handle works discoverably.

### From v3.9.1 (subsumed into this release)

- **Pasted GFM task lists survive their checkboxes** when the clipboard carries both `text/plain` and `text/html` — the plain-text-that-looks-like-markdown path beats the HTML path.
- **Browser tab title includes the server alias** — `mdnest (srv-ahsan-mini)` so multi-tab users can tell servers apart.
- **Vitest scaffolding** — `frontend/src/__tests__/markdown-fixtures.test.js` exercises the paste-priority detection. `npm test` in `frontend/` runs the suite; the pre-push hook gates on it.

### Bug fixes

- **Mermaid container right-sizes for small diagrams** — a 3-node flowchart used to stretch a full editor-width container with ~1300px of empty halo on each side. `.mermaid-live-block` now uses `width: fit-content; max-width: 100%` so the block hugs the diagram (with the toolbar's natural width as a floor so its buttons never wrap).
- **Task-list spacing** — Crepe's default flex gap of 10px + the app-wide `p { margin: 0.4rem 0 }` were leaking ~13px of stacked margin between rows. Reset paragraph margin inside `.children`, tightened the gap to 6px, center-aligned the marker box on the text line so bullets / `1.` / checkboxes sit on the text baseline.
- **Heading hierarchy underline** — H1 *and* H2 keep their `#313244` bottom border (previous override only added it to H1).

### Internal cleanup

- **Legacy `LiveEditor.jsx` deleted.** The four shared plugins (`commentHighlightPlugin`, `clearEmptyBlockPlugin`, `tableCellCheckboxPlugin`, `LiveToolbar`, plus `findAnchorMatches` and `commentHighlightKey`) live in `frontend/src/components/live-editor-plugins.jsx`. `LiveEditorCrepe.jsx` imports from there.
- **`VITE_USE_CREPE` build flag removed.** Crepe is now the only Live editor; `./mdnest-server rebuild` (no env var) ships it. Dockerfile ARG and `mdnest-server` BUILD_ARGS propagation deleted.
- **Bundle size** — the Live editor chunk is now ~1.1 MB / ~340 KB gzipped (Crepe + Vue runtime + CodeMirror + KaTeX). Lazy-loaded; the main app bundle is unchanged in size for the initial page load.

### Notes

- Crepe brings a Vue 3 runtime (~340 KB raw, ~80 KB gzipped) into the lazy chunk. It is contained — no Vue components are mounted in the React tree; Crepe creates its own Vue app inside the editor's contenteditable root. mdnest as a whole remains a React app.
- The plain textarea ("Basic") editor stays. Some users prefer raw markdown editing, and Basic is also the auto-fallback when the Live editor crashes on a specific file (the existing `EditorErrorBoundary` catches Live-editor exceptions and flips to Basic).

---

## v3.9.1 — Paste-handler priority + browser tab title + test scaffolding

### Bug fixes

- **Pasted GFM task lists (`- [ ] Foo`) survive their checkboxes** when the clipboard carries both `text/plain` and `text/html` (Obsidian, terminals, most modern apps populate both). The Live editor previously checked the HTML branch first; `htmlToMarkdown` is lossier than `markdownToSlice` for task lists because the HTML version typically doesn't carry GFM's `data-item-type="task"` data attribute, so the DOM round-trip dropped the checkbox semantics and the result landed as a plain bulleted list. Reordered: plain text that *looks like markdown* (any line starting with `#`, `-`, `*`, `>`, `|`, `` ` ``, `[`, `!`) now wins over rich HTML when both are present. HTML conversion remains the path for sources that don't ship markdown (Google Docs, Confluence, web pages). The basic textarea editor already had this priority; this aligns the Live editor with it. Extracted the markdown-detection regex into `frontend/src/markdown-utils.js` so the two paste handlers share one source of truth.

### New features

- **Browser tab title includes the server alias.** Multiple mdnest tabs (different servers) are now visually distinguishable: `mdnest (srv-ahsan-mini)` instead of plain `mdnest`. Falls back to `mdnest` when no `SERVER_ALIAS` is configured. Reads from the existing `/api/config` payload — no backend change needed.

### Tests

- **Vitest scaffolding for markdown roundtrips** (`frontend/src/__tests__/markdown-fixtures.test.js`). Targets the regression patterns that have actually shipped: paste-priority detection, task-list HTML conversion (the v3.8.0 fix verification), and `looksLikeMarkdown` edge cases. Runs under jsdom so the `htmlToMarkdown` path (uses browser `DOMParser`) is exercised. `npm test` in `frontend/` runs the suite; pre-push hook gates pushes on it passing. Eleven tests today; add a fixture before touching the editor next time so the next regression of this shape is impossible to ship.

### Notes

- The deeper consolidation work (unifying Live's `tableCellCheckboxPlugin` with Preview's DOM-walker checkbox path, memoizing the comment-highlight plugin, schema-level task-list cleanups) is documented in the plan file as Tier 3 future PRs — explicitly NOT in this release. The pattern of "small markdown things keep breaking" needs that work, but each piece is its own change with its own blast radius and should ship one at a time.

---

## v3.9.0 — Tree auto-refresh in single mode + host-side token CLI + path-confusion guard

### New features

- **`mdnest update`** (and `mdnest upgrade`) — self-update verb on the CLI. Re-fetches the latest `mdnest` script from upstream and replaces itself in place; safe on Unix because the kernel keeps the running inode alive until the current invocation exits, so the next call picks up the new code. Reports the upgrade path (`vX.Y.Z -> vA.B.C`) and short-circuits with "up to date" when current matches latest. `--force` re-downloads regardless. Closes the discoverability gap where the only update path was remembering the `install-cli.sh` URL and re-piping it into bash.
- **`mdnest-server create-token <name>`** — host-side API token provisioning. Generates a token, persists it to the same `tokens.json` store the web UI uses, and prints just the raw token to stdout so callers can capture it: `TOKEN=$(./mdnest-server create-token foo)`. Same trust model as `reset-password` — anyone with shell access to the server can mint tokens, which is by design (server shell = full operator trust). In single mode the token is bound to `MDNEST_USER` for clarity in logs / UI; in multi-mode this CLI exits with a clear error pointing at the web UI's per-user token flow (web-UI tokens bind to the logged-in user, which the CLI can't disambiguate from the host).

### Bug fixes

- **Tree auto-refreshes in single mode** (and multi-mode without `ENABLE_LIVE_COLLAB`). Previously the tree was kept in sync via the WebSocket `tree-changed` event, which only fires in multi-mode + live-collab installs. Without it, a file created from the CLI / MCP / git-sync / another browser tab stayed invisible until the user clicked the Refresh button. Now the frontend polls the tree every 60s when no websocket is connected (skipped when the tab is hidden so backgrounded sessions don't burn requests). Costs one tree GET per minute per active session.
- **Better error when creating a file at a path that conflicts with an existing directory.** `POST /api/note?path=foo/bar.md` while a directory `foo/bar/` already exists at the same level used to silently create a misplaced sibling — agents (and humans) frequently meant "create a file inside `foo/bar/`" and didn't realize the path syntax was wrong. Now the backend detects this case and returns 409 with a clear hint: `a directory named 'foo/bar' exists at this location — to create a file inside it use path 'foo/bar/<filename>.md'`. POSTing directly to a directory path also returns a more informative 409 instead of the misleading "file already exists." Same `safePath` checks; just a smarter conflict message.
- **CLI-minted API tokens validate without a server restart.** The token store loads `tokens.json` once at startup and serves all subsequent validations from memory. The new `create-token` CLI runs in a one-shot container that writes the file but can't update the running server's in-memory map, so newly-minted tokens were rejected with `401 invalid API token` until the next rebuild. Fixed in `tokens.go`: on a hash miss the validator re-reads `tokens.json` from disk before giving up. Successful validations stay fast (in-memory hit, no I/O); only misses pay the file-read cost. Same logic mirrored in `ResolveAPITokenUser` for multi-mode user-resolution misses.

### Notes

- This release is on `release/v3.9.0`.

---

## v3.8.0 — Update notifications, version compare, and multi-IP bind

### New features

- **"Update available" badge with release notes.** The backend now polls the GitHub releases API once every 24 hours and includes the latest release (version, name, publish date, full markdown body) on `/api/config`. When a newer mdnest is published, a small badge appears next to the version in the sidebar footer. Clicking it opens a modal that renders the release notes inline so you can see *what actually changed* (features, bug fixes, breaking notes) before deciding to update — not just the version number. Per-version "don't remind me" dismissal is saved in localStorage; a newer release re-arms the badge automatically.
- **Compare two versions in the History modal.** A new "Compare to:" dropdown above the preview pane lets you pick any other commit, or the live "Current version", to diff against the primary selection. Green-tinted lines exist only in the target, red-tinted lines only in the primary — so when you're considering a restore, you can read exactly what would change and decide before clicking Restore. Diff is line-based (LCS); identical inputs short-circuit to "no differences."
- **Comma-separated `BIND_ADDRESS` for multi-IP binding.** `BIND_ADDRESS=127.0.0.1,100.73.118.115` now works — useful for binding localhost plus a private overlay address (Tailscale, ZeroTier, VPN) without falling back to `0.0.0.0`. Previously a comma-separated value was passed verbatim to a single Docker port mapping, so `mdnest-server rebuild` failed with `invalid IP address`. Single-IP behavior is unchanged.

### Bug fixes

- **Sidebar shows the configured username in single-user mode** instead of the literal placeholder "User". Previously the sidebar's `UserFooter` only had a username to display when `/api/me` populated `userInfo` — but `/api/me` is registered only in multi-mode, and `App.jsx` actively passed `null` to the sidebar in single mode (`userInfo={isMulti ? userInfo : null}`). So an admin signed in via `MDNEST_USER` always saw the generic "User" label. Fixed in `App.jsx` by decoding the JWT's `sub` claim client-side (which already carries `MDNEST_USER` from `mdnest.conf`) and synthesizing a minimal `userInfo` for single mode (with `is_super_admin: true` since the single-mode user implicitly owns everything). The gate at the Sidebar prop is dropped — `userInfo` flows through in both modes now.
- **Long-press on a file/folder on mobile now shows the same context menu as right-click on desktop.** `TreeNode.handleTouchStart` didn't call `e.stopPropagation()` (its right-click sibling does). The touch event bubbled up to the parent `.sidebar-tree`, whose own empty-area long-press handler also scheduled a 500ms timer with `target=null`. Both timers fired, the empty-area one ran *after* the file-specific one, so the file menu was rendered for an instant and then immediately overwritten with the empty-area "New Note / New Folder" menu. Fixed by adding `e.stopPropagation()` at the top of `handleTouchStart`, mirroring `handleRightClick`. The empty-area handler still fires correctly when the user long-presses on actual blank space below the tree.
- **Patched Go stdlib + golang.org/x/net CVEs.** The pre-push hook surfaced four `govulncheck` findings on the v3.8.0 branch: GO-2026-4982 / GO-2026-4980 (XSS via `html/template` escaper bypasses), GO-2026-4971 (panic in `net.Dial`/`LookupPort` on Windows from NUL bytes — reachable via `database/sql` and `exec.Command` lookups), and GO-2026-4918 (HTTP/2 transport infinite-loop on a malicious `SETTINGS_MAX_FRAME_SIZE` — reachable from `updates.Checker` and the Firebase admin SDK). Fixed by bumping `go.mod`'s `go` directive from `1.26.2` → `1.26.3` (which forces the patched stdlib via Go's auto-toolchain), pinning the Dockerfile builder image from `golang:1.26-alpine` (floating) to `golang:1.26.3-alpine` so production binaries match, and upgrading `golang.org/x/net` from `v0.52.0` → `v0.53.0`. `govulncheck ./...` now reports clean.
- **Checkboxes now render inside table cells.** GFM's standard `table_cell` schema admits only `paragraph+` content — list items (where Milkdown's task syntax lives) are not allowed children, so `| - [ ] X |` in a cell fell through to plain `[ ]` text in both the Live editor and the Preview. Rather than widening the schema (which breaks the ProseMirror tables editing plugin's cell-selection / tab-navigation / paste-rule assumptions), added two cooperating layers that operate on literal `[ ]` / `[x]` text inside cells: (a) Live mode — a new `tableCellCheckboxPlugin` ProseMirror plugin scans `table_cell`/`table_header` nodes on every transaction, hides each three-character bracket span via inline decoration (`width:0; visibility:hidden` so the cursor steps cleanly across), and paints an `<input type="checkbox" contentEditable=false>` widget decoration at the same position; clicking dispatches a `replaceWith` transaction that flips the underlying text → checked state persists through normal autosave. (b) Preview mode — DOM post-pass walks every `td`/`th` text node, replaces matched `[ ]`/`[x]` with checkbox elements, indexes them left-to-right top-to-bottom, and on toggle finds the N-th `[ ]`/`[x]` literal in the source markdown and rewrites it via the existing `onCheckboxToggle` callback (which now accepts a `colIndex` second argument so in-cell toggles target the specific bracket pair, not the surrounding list-item form). Round-trip is invariant: the underlying text in the document remains literal `[ ]` / `[x]`, so `toMarkdown` serializes it unchanged. Works in nested lists and blockquotes too — anywhere the literal brackets appear inside a cell.
- **CLI writes (and other HTTP-originated changes) now propagate to a same-user browser tab.** The `Hub` in `backend/collab/hub.go` was tracking presence in a `noteKey -> userID -> *Conn` map, and `BroadcastFileChanged` excluded *every* connection sharing the originator's userID. So `mdnest write @ns/path.md` from the CLI as user X excluded X's own browser tab from the resulting `file-changed` event — the tab kept showing the old content until you clicked away and back. Refactored to `noteKey -> set of *Conn` (set semantics on the connection pointer): `Join`/`Leave` operate on `*Conn`, presence + countUsers dedupe by `User.ID` for display purposes, and broadcasts split into two helpers — `broadcastToOthers(key, exclude *Conn, msg)` for WS-triggered relays (cursor / selection / live content) where the originating tab should not echo, and `broadcastToAll(key, msg)` for HTTP-triggered events (file-changed / tree-changed) where there is no originating `*Conn`. Side effects: a user can now have multiple tabs open on the same note without one silently displacing the other; "join"/"leave" presence events now fire only on the user's first/last connection so a second tab doesn't double-count.
- **Pasted markdown task lists no longer drop their checkboxes.** Pasting `- [ ] Foo` (from Obsidian, a terminal, or anywhere that puts plain markdown on the clipboard) into the Live editor produced bare text lines without bullets or checkboxes. Root cause: the paste handler used `@milkdown/utils`'s `insert(md)`, which wraps `doc.content` in `Slice(content, selection.openStart, selection.openEnd)` — when the cursor sat inside a paragraph (the common case) the slice's open ends were inferred as inline, so block-level lists collapsed to plain inline text on insertion. Switched to `markdownToSlice(md)` (the DOM-round-trip path) which serializes via the schema's `toDOM` (GFM's listItemSchema renders `<li data-item-type="task" data-checked="…">`) and re-parses via `DOMParser.parseSlice`, whose `parseDOM` rule extracts the `checked` attr and rebuilds the slice with proper open ends. Task list items survive the paste round-trip with checkboxes intact.
- **Live editor crash no longer blanks the entire app.** Some markdown content (deeply nested tables, certain HTML, malformed mermaid blocks) can throw inside Milkdown's `Editor.make()` or its plugin chain. Until now there was no React error boundary around the Live editor, so the exception propagated up to the app root and unmounted the entire tree — the user saw a blank white screen and had to hard-reload. New `EditorErrorBoundary` wraps the Live mount: on catch it (1) calls `onError`, which auto-flips `editorMode` to `basic` and persists the choice, (2) shows a banner above the editor pane naming the affected file and pointing to the toolbar toggle for re-trying Live, (3) resets itself when the user navigates to a different note (`resetKey={ns}/{path}`) so a single bad file doesn't lock out Live for the rest of the session. Manually toggling back to Live for the crashed file clears the banner.
- **Files created outside the UI now have a one-tap path to show up in the sidebar tree.** Files created via the `mdnest` CLI, the MCP server, or git-sync only auto-propagate to the browser when (a) live-collab is enabled (multi-mode + `ENABLE_LIVE_COLLAB=true`), AND (b) the user has a file open at the time — the per-file WebSocket is closed when no note is selected, so a `tree-changed` broadcast can't reach the client. Single-mode users have no WebSocket at all. The toolbar already has a refresh button for the open-file case, but it's hidden when no file is open, so on mobile (where there's no F5 / Cmd-R) the only recovery was a full browser reload. New refresh button added to the sidebar's tree-control bar (the row with expand-all / collapse-all / show-full-names). Always visible, works on touch, calls the same `refreshTree` path used after rename/move/delete. Spins for ~600ms on click so the action feels responsive even when the network call is fast.

### Mobile UX

- **Tree is usable on phones again at deep nesting.** Three CSS-side improvements behind the existing `@media (max-width: 768px)` breakpoint: (1) per-level indent reduced from `0.75rem` to `0.4rem` per depth — at depth 7 that's ~50px of left padding instead of ~92px, giving the label ~40% more room on a 360px-wide sidebar; (2) sidebar width grows from a flat `280px` to `min(88vw, 360px)`, using more of a phone's available width; (3) `.tree-row` gets `min-height: 40px` and a slightly larger font on phones, hitting the Apple HIG / Material Design minimum touch-target size so siblings don't get fat-fingered. Indent is now driven by a `--tree-depth` CSS custom property (set inline by `TreeNode.jsx`) so the breakpoint can override it cleanly. Long folder/file names ellipsize via `text-overflow: ellipsis` instead of pushing the chevron off-screen; the native `title=""` tooltip still shows the full name on hover.
- **Move files and folders without drag-and-drop.** Touch devices have `draggable=false` on tree rows (long-press is reserved for the context menu, and HTML5 drag-and-drop on touch interferes with scroll), so there was no way to move a file from one folder to another on a phone. New **Move to…** entry in the context menu opens a touch-friendly destination picker — flat list of folders in the namespace with hierarchy indent, 44px-tall rows, "Move here" confirm. Filters out invalid destinations (the source itself, the source's current parent, any descendant of the source if the source is a folder). Calls the same `POST /api/move` endpoint desktop drag-and-drop uses, so collision and permission rules are byte-identical across the two paths. Available on desktop too as an accessibility-friendly alternative to dragging. New `MoveToModal.jsx` component.
- **History modal is readable on phones.** The desktop layout puts a fixed-240px commit list next to a flex-1 content pane — on a 330px-wide phone modal that collapses the content to ~60px and stairsteps every line of markdown one word at a time. Below 768px we now stack vertically: the commit list takes the top 28vh, the content pane takes 50vh, and the "Compare to:" dropdown wraps to fill width. Modal grows from `min(900px, 92vw)` to `min(640px, 96vw)` for a touch more horizontal room. Desktop layout is unchanged.
- **Tree loading shows a spinner instead of "No files yet".** On slow connections the previous empty-state copy made it look like a namespace was empty mid-fetch. Now: while `getTree()` is in flight and the tree is empty, the sidebar shows a centered Catppuccin-blue spinner + "Loading…" text. When the tree is already populated and a refresh fires (after rename/move/create/delete/git-sync), a thin animated progress bar slides at the top of the tree area while the refresh lands — the existing tree stays visible underneath. Both are CSS-only animations, no JS overhead.
- **Long folder/file names are readable on phones.** Two coordinated changes that don't disrupt the tree's visual rhythm: (1) the sidebar slide-over grows from `min(88vw, 360px)` to `min(94vw, 420px)` on phones — since the sidebar overlays the editor anyway when open, reserving more room for the tree makes long names fit without compromise. (2) The toolbar's open-file path was `white-space: nowrap` + ellipsize-from-end, which on narrow toolbars cut the *filename* (most informative part) and kept the parent folders. Now split into `dirname / basename` spans: the dir half shrinks and ellipsizes when squeezed, the basename half has `flex-shrink: 0` and stays visible. The basename gets a slightly brighter color + medium weight to read as the primary identifier. Full path is on the `title=""` attribute for desktop hover reveal. Tree labels keep their single-line ellipsis everywhere — no per-row layout jumps.

### Notes

- **Update check is opt-out, not opt-in.** Default-on so most operators learn about security patches; air-gapped or privacy-sensitive installs can set `DISABLE_UPDATE_CHECK=true` in `mdnest.conf` (or `UPDATE_CHECK_REPO=<owner/repo>` to point at a fork). Failures are logged at info level and never block startup. The backend hits GitHub from one IP per server per day — user IPs are never exposed to GitHub.
- **Release-notes payload is capped.** Release bodies over 8 KB are truncated in `/api/config` with a "see full release notes on GitHub" hint, to keep the config payload small even if a future release ships with a giant body.
- **No new database migration.** This release is config-and-UI only on the multi-mode side; no schema changes.

---

## v3.7.0 — In-app version history with restore (single + multi mode)

### New features

- **Right-click any note → History.** Opens a modal listing the most recent 50 commits affecting that file from the per-namespace git-sync repo, newest first. Selecting a commit shows its content as of that point, and **Restore this version** writes the old content back through the regular save path (so the v3.6.1 empty-overwrite guard, the ETag conflict check, and the websocket file-changed broadcast all run as usual — restoration is not a separate write path that could carry a new class of bugs). Works in both single mode and multi mode; the only requirement is that git-sync is configured for the namespace. If it isn't, the modal says so clearly with a one-line setup hint.
- **Multi-user awareness on restore.** When a user clicks Restore in a multi-user install with live collab on, the resulting websocket `file-changed` event now carries `reason: "restored"` and the restored-from SHA, so other users currently on the same file see a distinct **info-coloured banner** ("X restored this file to an earlier version (sha)") instead of the usual yellow conflict banner. Their unsaved local changes are preserved until they choose to reload — same UX shape as the existing conflict banner, deliberately a different colour and copy because a restore is an intentional action by another user, not a divergence.
- **Backend endpoints (also new).** `GET /api/note/history?ns=&path=` returns `[{commit, unix_ts, author, message}]` (capped at 50, newest first); `GET /api/note/at?ns=&path=&ref=<sha>` returns the file's content at a specific commit. `ref` is required to be a 7-40 char hex SHA — branch names, `HEAD~N`, and other git ref forms are rejected to keep the surface predictable. Both endpoints are read-only and gated by the same `RequireNsAccess` middleware that protects `GET /api/note`. `PUT /api/note` accepts a new optional `?restore-from=<sha>` query parameter that adds the broadcast tagging without changing any safety logic.

### Notes

- **No file locks.** The user explicitly asked whether this should add a per-file lock primitive (acquire-while-editing). Decision: no. The existing optimistic-concurrency model (ETag + the new info banner + the existing presence bar) handles the multi-user restore case cleanly without introducing the stale-lock / lock-takeover / lock-expiration UX surface that locking inevitably brings. If real users hit conflicts the new banner can't mediate, locking can be designed as its own feature later.
- **No diff highlighting for now.** The History modal shows old content as a plain `<pre>` rather than a coloured diff. A diff library can be wired in later if there's appetite; the simpler viewer is enough for v3.7.0.
- **No `--follow` for renamed files.** Per-file history starts when the file was named what it's named now. If a file was renamed, its pre-rename commits aren't in the modal — fall back to the GitHub UI for that case. Easy to add later.
- **Read-only collaborators** can browse history and view old content; the **Restore** button is disabled for them with a tooltip.

---

## v3.6.1 — Stop the Live editor's undo from erasing your notes

### New (small UX add)

- **Undo and Redo buttons in the Live editor toolbar.** Hidden behind keyboard shortcuts before — and on macOS the redo binding is `Cmd+Shift+Z`, not `Cmd+Y`, which trips up plenty of people. Now there are two visible buttons (curved-arrow icons) at the start of the toolbar. Same effect as `Cmd+Z` / `Cmd+Shift+Z` on the keyboard. The basic textarea editor already uses your browser's native undo/redo; no toolbar buttons there.

### Bug fixes (critical — data-loss prevention)

- **Pressing Cmd+Z 2-3 times in the Live editor could silently erase a non-empty note.** The data-loss path was a chain of four cooperating defects, and any single one of them would have prevented the loss. We've fixed all four. (1) The frontend's `content` state defaulted to `''` and was reset to `''` on namespace change / failed load / browser-nav transitions, so for a brief window the Milkdown editor was initialized with empty content even when a real (non-empty) note was about to load. That empty state ended up as a reachable entry in ProseMirror's undo stack — pressing Cmd+Z walked back through your typing and then into that empty load. (2) `<LiveEditor>` had no `key` prop, so the same Milkdown instance carried across note switches and Cmd+Z could walk into another note's history. (3) `handleContentChange`'s 800ms debounced autosave fired unconditionally — when the editor briefly held empty content, the autosave dutifully committed empty bytes to disk. (4) The backend's `PUT /api/note` had no guard against truncating a non-empty file to empty. Fixed in `App.jsx` (initial state is now `null` until a note is loaded; setting `null` during transitions instead of `''`; autosave skips when `newContent === ''` and the loaded content was non-empty; `key={ns/path}` on `<LiveEditor>` and `<Editor>` so each note gets a fresh instance with its own undo stack), `LiveEditor.jsx` (only mounts when content is a real string, so the empty-during-load transition no longer enters the undo stack), and `notes.go` (refuses to overwrite a non-empty file with an empty body unless the request explicitly passes `?allow-empty=1` — autosave never does, so the silent-truncation path is closed even if every layer above somehow fails).
- **Recovery for already-lost content:** if your install runs the optional git-sync sidecar (default cadence 600s), every note has a complete commit history in the per-namespace git repo. Browse the repo on GitHub to find a `sync: <UTC-timestamp>` commit before the destructive undo, view the file at that commit, and copy the content back. We are surfacing this as an in-app "Version history" button in v3.7.0 so future recovery doesn't require the GitHub UI.

---

## v3.6.0 — Admin password reset (UI + host CLI)

### New features

- **Superadmins can reset another user's password from the Admin Panel.** Each non-superadmin row in Admin → Users now has a "Reset password" button (visible only to superadmins, only when `USER_PROVIDER=local`). The dialog asks for a new password twice; on submit the target user's `must_change_password` flag is set so their next login is gated on picking their own password before they can do anything else (the existing forced-change flow in `Login.jsx` already handled this case for invited users — we just reuse it).
- **Resetting another superadmin's password from the UI is intentionally blocked.** That would be a lateral-escalation primitive — one compromised superadmin could lock out every other superadmin in a single click. The UI button is hidden for superadmin rows and the `/api/admin/reset-password` endpoint returns 403 if the target's role is `superadmin`. The legitimate recovery case (a colleague forgot their superadmin password) is handled by the new host-side CLI below.
- **`mdnest-server reset-password <email>`** — host-shell command for resetting *any* user's password, including superadmins. Prompts for the new password with hidden input (twice), pipes it via stdin to a one-shot backend container so the password never appears in argv or shell history. Validates `AUTH_MODE=multi` + `USER_PROVIDER=local` and refuses otherwise. Same `must_change_password=true` guarantee — the temp password is single-use.

### Notes

- No database changes. The `must_change_password` column has existed since the original multi-mode work, so this release is additive: any existing schema works unchanged.
- Federated providers (`firebase`, `sso`) reject the new endpoint — identity is owned by the IdP. Reset there.

---

## v3.5.4 — Fix renamed file vanishing from the sidebar when extension is dropped

### Bug fixes

- **Renaming a note to a name without a file extension silently hid it from the tree.** The sidebar only lists files with a recognized text extension (`.md`, `.txt`, `.json`, `.sql`, `.csv`, `.yaml`, `.yml`, `.markdown`) — that's `tree.go`'s `textExtensions` filter. The rename prompt accepted any string and passed it straight to `/api/move`, so typing `foo` while renaming `foo.md` wrote `foo` to disk and the file disappeared from the sidebar: still on disk, no error, no warning. Fixed in `App.jsx` by mirroring `doCreateNote`'s extension-preserving behaviour — when the target is a file and the typed name contains no `.`, the original extension is auto-appended. Folders are exempt; explicit extension changes (`foo.md` → `foo.txt`) still work as before.

---

## v3.5.3 — Fix bogus 409 "modified by another user" on first save of new notes

### Bug fixes

- **"This file was modified by another user" 409 on the first save of a freshly-created note.** Notes carry an invisible `<!-- mdnest:UUID -->` marker so comments survive renames; the marker is lazy-injected by `EnsureNoteID` the first time a comments endpoint touches a file. `ExtractNoteID` returned the body in two different shapes — bytes-as-is when no marker, with a trailing `\n` normalization when the marker was present — so the ETag computed by `getNote` *before* the lazy injection didn't match the ETag computed by `updateNote` *after*. The frontend's first autosave hit the conflict path with no actual conflict, the user lost their typed content on refresh. Same defect also fired on every save *after* the first (since `newETag = sha256(body)` ignored the same normalization). Fixed in `notes.go` by adding `canonicalForETag`, a helper that drops trailing newlines from clean note content. Wrapped around all three ETag call sites (`getNote`, `updateNote` `currentETag`, `updateNote` `newETag`) so the hash is identical regardless of whether the marker has been injected yet — the race becomes mathematically irrelevant. Bytes on disk and bytes returned to the editor are unchanged; only the hash input is canonicalized. Genuine conflicts (real concurrent edits) still 409 correctly.

---

## v3.5.2 — Fix empty tree for superadmin in multi mode

### Bug fixes

- **Superadmin users saw an empty file tree in multi-user mode.** The grant filter in the tree handler only bypassed filtering for `role="admin"` (namespace-admin), not `role="superadmin"`. Since superadmins have no explicit grant rows (they're meant to have implicit full access), `filterTreeByGrants` stripped every node — returning an empty root. Fixed by adding the `"superadmin"` role check alongside `"admin"` in `tree.go`.

---

## v3.5.1 — Go 1.26 bump for stdlib CVEs

### Security

- **Bumped Go to 1.26** (was 1.25). Clears five stdlib vulnerabilities flagged by govulncheck against the 1.25 line:
  - `GO-2026-4865` — `html/template` JS context tracking bug (XSS)
  - `GO-2026-4866` — `crypto/x509`
  - `GO-2026-4870` — `crypto/tls` KeyUpdate DoS
  - `GO-2026-4946` — `crypto/x509` slow policy validation
  - `GO-2026-4947` — `crypto/x509` slow chain building
- `backend/go.mod`: `go 1.25.0` → `go 1.26.2`. `backend/Dockerfile`: `golang:1.25-alpine` → `golang:1.26-alpine` (the moving tag tracks the latest 1.26.x patch so future fixes land on rebuild without manual bumps).
- No code changes required for the bump — `go mod tidy` was a no-op, `go build` and `go vet` clean, and the production-style `docker compose build --no-cache` succeeded against the new image.

---

## v3.5.0 — Namespace-scoped Admin role + SuperAdmin + token access scoping

### Breaking changes

- **Existing `role='admin'` users are migrated to `role='superadmin'` on first startup of v3.5.0.** They keep current behaviour — global access to every namespace, every user-management endpoint, every grant. This is a one-shot rename done by migration 007 and only fires when the migration runs the first time. No action required from operators.
- **The new `role='admin'` is namespace-scoped, not global.** A user with `role='admin'` can only manage the namespaces listed for them in the new `namespace_admins` table — they invite users into those namespaces, manage grants on them, promote co-admins, and trigger git-sync for them. They cannot delete users, change anyone's role, reset 2FA, or sync globally — those are SuperAdmin-only.
- **API tokens no longer get a system-wide admin bypass.** Pre-v3.5.0, an admin's token bypassed every permission check. Post-v3.5.0 a token resolves to its creator's current scope at request time: superadmin tokens are still global, namespace-admin tokens work only on their owner's admin namespaces, collaborator tokens work only on their owner's grants. Revoking a user's grant immediately revokes their tokens for that namespace too.
- **`ADMIN_EMAILS` now auto-promotes to `superadmin`** (was `admin`). This preserves the operator-bootstrap intent across the role rename.

### Features

- **Three-tier role hierarchy.** SuperAdmin (global) / Admin (namespace-scoped) / Collaborator (grants only). The model lets a multi-tenant deployment have one superadmin operator and per-team admins who can run their own namespace without seeing other teams' data.
- **`namespace_admins(user_id, namespace, granted_by, created_at)` table.** Migration 007 creates it; the `PermissionChecker` consults it on every `role='admin'` request to decide whether the namespace is in scope. The hot path is a single-row `EXISTS` query.
- **New endpoints `/api/admin/namespace-admins`** — `GET ?ns=<n>` lists admins of a namespace, `POST {user_id, namespace}` promotes (auto-bumps `users.role` from collaborator to admin, auto-creates a `permission='write'` grant on `/`), `DELETE ?user_id=<id>&ns=<n>` demotes (auto-reverts to collaborator if no other admin namespaces; the auto-grant is left in place so access doesn't disappear by surprise).
- **`/api/me` exposes `is_super_admin` and `admin_namespaces`** so the frontend can scope the admin panel without an extra round-trip on every page load.
- **`/api/admin/users` is filtered by caller scope.** SuperAdmins see all users; namespace admins see only users with grants or namespace_admins entries on their own namespaces (plus self).
- **`/api/admin/grants` is filtered by caller scope.** Same model: superadmin sees all, namespace admin sees only their namespaces. Create / update / delete return 403 if the target grant isn't in the caller's admin scope.
- **Reset 2FA, delete user, change role** are SuperAdmin-only. Promoting between superadmin/admin/collaborator globally requires SuperAdmin. Promoting another user as namespace admin only requires admin scope on the target namespace.
- **Sidebar admin scope hint.** Namespace admins see a yellow "Admin of: <ns list>" badge at the top of the admin panel so they know what they're managing.
- **New "Namespace Admins" tab in the admin panel.** Pick a namespace, see who admins it, promote any non-superadmin user, demote with one click. Visible to anyone with the panel; the backend scopes both reads and writes.

### Configurable grant depth

- **`GRANT_MAX_DEPTH`** in `mdnest.conf` caps how deep into a namespace tree an admin can scope a grant. `/` is depth 0 (always allowed), `/foo` is 1, `/foo/bar` is 2. New grants beyond the limit are rejected at `POST /api/admin/grants` with a 400 explaining the depth and the configured limit. Existing rows are grandfathered — only new INSERTs are checked. Default `3`. Set to `0` for no limit. The PathPicker dropdown in the admin UI reads the same value from `/api/config` and hides too-deep folders so admins can't pick something the API will reject.

### Dev-only

- **`INSECURE_DEV_LOGIN` backdoor** for local SSO testing. When set to `true` in `mdnest.conf`, the backend registers `POST /api/auth/dev-login` which mints a 30-day session JWT for any **existing** user by email — completely bypassing the IdP. Identity rules match SSO (no auto-provisioning, blocked users still rejected). Off by default; the route 404s when the flag is unset. The default sign-in page is unchanged (still strict SSO); the bypass is reachable only by manually navigating to `/?login=dev`. While enabled, every authenticated page renders a sticky red warning banner, and the backend logs a multi-line warning at startup. Strictly for local development — never enable on a non-localhost deployment. New `LoginDev.jsx` component, `devLoginEnabled` field on `/api/config`.

### Internal

- New `backend/store/namespace_admins.go`: `NamespaceAdminStore` interface + Postgres impl with `Add`, `Remove`, `IsAdminOf`, `ListByUser`, `ListByNamespace`, `CountByUser`. `Add` is idempotent via `ON CONFLICT DO NOTHING` so promote re-runs are safe.
- `backend/middleware/permission.go`: new constructor `NewPermissionChecker(grantStore, nsAdminStore)` and a `hasAdminScope(uc, ns)` helper. The three places that used to short-circuit on `Role == "admin"` now go through it.
- `backend/middleware/admin.go`: `RequireAdmin` now means "any admin role"; new `RequireSuperAdmin` for the global gate. `IsSuperAdmin(ctx)` helper added.
- `backend/handlers/admin.go`: every method now scopes through `callerCanAdminNamespace` / `callerAdminNamespaces`. `ensureNotLastAdmin` → `ensureNotLastSuperAdmin` (only superadmins are deadlock-load-bearing).
- `backend/handlers/sync.go` takes an `nsAdminStore` and returns 403 when the caller isn't allowed to sync the requested namespace.
- `backend/handlers/tokens.go`: `listTokens` and `revokeToken` no longer give `role=='admin'` system-wide visibility — superadmin only. Owners always see / revoke their own.
- `backend/store/grants.go`: + `GetGrant(id)` so admin handlers can authorize the action against the target grant's namespace.
- Frontend: `App.jsx` derives `isSuperAdmin` and `adminNamespaces` from `/api/me`; threads them into `AdminPanel`. The panel hides global actions (Cycle role, Delete user) for non-superadmins, locks the Invite namespace dropdown to admin scope, adds the Namespace Admins tab. New `api.js` helpers: `adminListNamespaceAdmins`, `adminAddNamespaceAdmin`, `adminRemoveNamespaceAdmin`. `adminInviteUser` accepts a `namespace`.

---

## v3.4.0 — Corporate SSO + Federated Identity

### Features
- **`mdnest-server reload`** — new lightweight subcommand for config-only edits. Regenerates `.env` + `docker-compose.yml` from `mdnest.conf` and force-recreates `backend` + `frontend` (and `git-sync` if enabled) so they re-read the new env. No image rebuild — ~10s vs `rebuild`'s 60-90s. Postgres and other persistent services are left untouched. Use after editing `mdnest.conf` (e.g. flipping `USER_PROVIDER`, adding a `MOUNT_*`, rotating an SSO secret).
- **`mdnest-server rebuild` always force-recreates app containers.** Previously the default rebuild relied on the `--no-cache` backend build to change the image hash, which usually triggered recreation but could miss conf-only changes that produced an identical binary. Now `rebuild` always passes `--force-recreate` to `compose up -d` for `backend` + `frontend`, guaranteeing the new `.env` is read. Postgres + git-sync still stay running. `--full` continues to nuke everything for the rare cases that need it.
- **Backend Dockerfile: BuildKit cache mounts.** `/root/.cache/go-build` and `/go/pkg/mod` are now persisted across builds. After v3.4.0 added Firebase Admin SDK + grpc + protobuf, a clean `go build` was taking 180-235s on a small EC2. With cache mounts the first build is unchanged, but every subsequent rebuild reuses the precompiled package archives → typically **10-30s** for source-only changes. The default `rebuild` also drops `--no-cache` to take advantage of layer caching too; `rebuild --full` keeps `--no-cache` for the paranoid case.
- **`mdnest-server` disables BuildKit attestations.** Sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1` at the top of the script so every build skips SLSA provenance + SBOM generation. These are designed for images pushed to a registry; we build locally, so they're pure overhead and can hang at "resolving provenance for metadata file" depending on the host's network conditions. Skipping them never affects image content or behaviour.
- **Corporate SSO via generic OIDC.** New `USER_PROVIDER=sso` mode (requires `AUTH_MODE=multi`). Users sign in through your IdP (Google Workspace, Okta, Microsoft Entra, Keycloak, Auth0 — anything that speaks OIDC discovery). Backend uses `coreos/go-oidc` + `oauth2` with PKCE; state/nonce/code-verifier carried in a short-lived HMAC-signed cookie. The IdP owns MFA, so mdnest's local 2FA is skipped in this mode. See `docs/sso-setup.md`.
- **Email-gated sign-in, no auto-provisioning.** An SSO sign-in only succeeds if the email is already in the mdnest `users` table (invited by an admin). Role, grants, and blocked flag stay in Postgres. Rejection paths redirect back with `#sso_error=<code>` for the frontend to surface.
- **Optional `SSO_ALLOWED_DOMAINS`** allowlist for corporate-domain-only sign-in.
- **Firebase identity (peer mode).** `USER_PROVIDER=firebase` is also available for teams that prefer Firebase Auth + Firestore-backed shared TOTP. Docs: `docs/firebase-setup.md`. Chosen mode is exclusive per server; Firebase is not required and carries no overhead when not enabled.
- **`store.TOTPStore` interface.** TOTP handlers, login flow, and admin 2FA reset now route through an interface with Postgres and Firestore implementations. Makes the 2FA surface swappable and explicit.
- **`totp_enabled` JWT claim.** Populated at login-issue time so the frontend can render "Enable 2FA" vs "Manage 2FA" without hitting the TOTP store on every request. Real 2FA enforcement still runs against fresh state at login.
- **`ADMIN_EMAILS` bootstrap.** Comma-separated list in `mdnest.conf` is reconciled into `role='admin'` on every startup. Removals are NOT auto-demoted — operator demotes explicitly.
- **Profile name + avatar from the IdP.** SSO callback now reads the `name` and `picture` OIDC claims from the ID token. Avatar is mirrored into a new `users.avatar_url` column on every login (picture URLs rotate at the IdP). Username is filled in once when the row's value is empty — admin-set usernames are never overwritten. The sidebar renders `<img>` from `avatar_url` with a graceful fallback to initials when the image fails to load. New users created by the SQL-INSERT bootstrap path get their real face + name automatically on first sign-in instead of "User" / "?". Migration 006 adds the column; additive, safe in all modes.

### Internal
- New `backend/sso/` package: OIDC relying-party with PKCE, cookie-based state, domain allowlist, `SanitizeFromPath` to prevent open-redirect abuse through the post-login `from=` param.
- New `backend/handlers/sso.go` wiring two routes: `GET /api/auth/sso/start`, `GET /api/auth/sso/callback`. Only registered when `ssoClient != nil`, so misconfigurations 404 cleanly.
- New `backend/firebase/` package: Firebase Admin SDK wrapper + Firestore TOTP store. Only instantiated when `USER_PROVIDER=firebase`.
- Migration 005: `users.firebase_uid TEXT UNIQUE`, `DROP NOT NULL` on `password_hash` / `username`, indexes on `firebase_uid` and `email`. Additive; safe on local-mode databases.
- Frontend: `LoginSSO.jsx` for SSO mode, `LoginFirebase.jsx` for Firebase mode, unchanged `Login.jsx` for local mode. `App.jsx` picks the right one from `/api/config.userProvider`. Hash-fragment token handoff (`#sso_token=…`) for the SSO callback.
- `Settings.jsx` hides the "Credentials" tab in both federated modes (no local password to change).
- `setup.sh` validates SSO / Firebase config at rebuild time, emits env vars into `.env`, mounts Firebase JSON files when needed.
- Dockerfile: Go image bumped to `golang:1.25-alpine` (Firebase Admin SDK requires Go 1.25+).

---

## v3.3.1 — Preview crash hotfix + CLI server-alias cleanup

### Breaking (CLI)
- **No more silent `@default` alias.** `mdnest login <url> <token>` without an explicit `@alias` used to create an alias literally named `default` — which hid which server was which in copy-path URIs. Now the CLI fetches `/api/config` and uses the server's `SERVER_ALIAS` automatically. If the server doesn't advertise one, login refuses with an actionable error: either pass `@alias` explicitly or set `SERVER_ALIAS=<name>` in the server's `mdnest.conf` and rebuild.
- **`@default` is rejected as an alias name** at login time.
- **New `mdnest rename @old @new` command** so users stuck with an existing `@default` alias can fix it in one step. Updates the default-server pointer if it referred to the old name.
- **Existing `@default` aliases keep working** (backward-compat for scripts) but print a one-line deprecation nudge per invocation pointing at `rename`.

### Server
- **`SERVER_ALIAS` soft-required.** Backend logs a `WARNING` on startup if it's unset, and `setup.sh` prints a warning at rebuild. Not a hard failure (existing installs keep running), but CLI users on unnamed servers have to pass `@alias` manually until it's set.
- `mdnest.conf.sample` now ships with `SERVER_ALIAS=mdnest` uncommented and a comment explaining why.

### Fixes
- **Preview crash on task lists with nested content** — clicking Split or Preview view on a file whose task list contained nested blocks (sub-lists, multi-paragraph items) threw `Token with "list" type was not found` from marked and took the preview tree down. Root cause: the custom `listitem` renderer called `parseInline` on block-level tokens. Fixed by dropping the override entirely — marked v15 already renders GFM task lists as `<li><input type="checkbox">`, and we re-wire those in the DOM post-pass.
- **Preview crash on headings / paragraphs / tables** — follow-up regression from the first fix attempt. Passing a plain-object `renderer` via the per-call `marked(src, {renderer})` option **replaces** the default renderer entirely in marked v15, instead of merging with it. Any token type not explicitly overridden (heading, paragraph, table, blockquote, etc.) crashed with `this.renderer.X is not a function`. Fixed by switching to `new Marked().use({renderer: {...}})`, which merges with defaults.

### Robustness
- **Preview error containment** — `renderMarkdown` is now wrapped in try/catch, and the `Preview` component is wrapped in a `PreviewErrorBoundary`. A malformed note (or any future renderer bug) now shows a readable error panel inside the preview pane instead of unmounting the whole app. The boundary auto-resets when the user navigates to a different note, so a single bad file doesn't permanently black out the pane.
- **View-mode toggle visible without a file open** — previously the Editor / Split / Preview and Basic / Live toggles were hidden when no file was selected. That trapped users in a bad mode after a crash: every file they tried to open re-triggered the same render path. Toggles are now always visible so users can pre-switch to a safe mode before opening the next file.

---

## v3.3.0 — Inline Comments

### Features
- **Inline comments** — select text in the Live editor and attach a comment to it. Commented text gets a persistent bright-yellow highlight so reviewers see what's been discussed at a glance. Highlights do not appear in print or export.
- **Threaded replies** — each comment can carry a conversation. Click **Reply** under any active thread to add a message; Enter sends, Esc cancels. Replies stack inside the parent card.
- **Comment sidebar** — slide-out panel on the right with active and resolved threads. Each thread shows the quoted anchor text, author, relative time, and actions (Go To, Reply, Resolve, Delete).
- **Clickable highlights** — click yellow text in the editor to open the sidebar and pulse the matching comment card into view.
- **Go To with pulsing flash** — the **Go To** button scrolls the commented text into view and plays a ProseMirror decoration flash on it, so the location is obvious even in long documents. Position tracking is done by ProseMirror itself, so scrolls and edits don't desync it.
- **Cross-mark anchor matching** — highlights work even when the commented selection spans inline marks (bold, italic, inline code, links). The search concatenates every text node with position mapping, rather than walking nodes one at a time.
- **UUID-anchored storage** — each note carries an invisible `<!-- mdnest:UUID -->` marker at the bottom, stripped on GET and re-injected on PUT. Comments are stored at `<namespace>/.mdnest/comments/<uuid>.jsonl`, so moving or renaming a file keeps its comments attached.
- **Direct-link loading** — comments now load correctly when opening a note via URL hash or browser back/forward, not just when clicked in the tree.
- **Requires multi-user + live collab** — comments need both `AUTH_MODE=multi` (for real author identity) and `ENABLE_LIVE_COLLAB=true` (for the WebSocket hub). Without either, the UI is hidden and the `/api/comments` route is unregistered.

### Fixes
- **Floating Comment popup at wrong positions** — suppressed when the triggering mouseup/keyup comes from outside the editor (e.g. clicking Go To in the sidebar no longer resurrects the popup).
- **Single-user / collab-off mode crash on comment** — the comment UI was showing in single-user mode and in multi-user installs that disable live collaboration (`ENABLE_LIVE_COLLAB=false`), even though the feature requires real user identity and the WebSocket hub. Comments are now gated on `liveCollab` on both the frontend (no icon, no popup, no sidebar, no API calls) and the backend (`/api/comments` route is only registered when live collab is on).

---

## v3.2.2 — Responsive Mobile & Stability

### Fixes
- **Mobile responsive rendering** — uses React `isMobile` state instead of CSS-only for editor/preview switching. At 768px breakpoint, only one wrapper renders (editor OR preview), preventing blank screens and split-view glitches.
- **Mobile mobileView sync** — syncs with desktop viewMode on first load so preview mode works on mobile.
- **False update banner (v1.0)** — removed second fallback in api.js that returned version '1.0' when config failed.
- **WebSocket status hidden when no file** — "Offline" no longer shows when no file is selected.

---

## v3.2.1 — Performance & Stability

### Fixes
- **Server overload (critical)** — GET requests on `/api/note` triggered `BroadcastTreeChanged` to all WebSocket clients, causing an infinite loop. Now only broadcasts on mutating requests (PUT/POST/DELETE).
- **WebSocket ghost reconnections** — switching files left stale `onclose` handlers that reconnected to the old file, stacking connections. Fixed with connection ID tracking.
- **Tree filtering** — non-markdown files (Postman JSON, binaries) excluded from tree. Supports `.md`, `.txt`, `.json`, `.sql`, `.csv`, `.yaml`. Files >5MB skipped. Empty directories still shown.
- **Removed 15-second tree polling** — WebSocket `tree-changed` events handle tree updates. Eliminated 80+ redundant requests/min with 20 users.
- **Note poll reduced** — 10s → 60s. WebSocket `file-changed` is real-time, poll is just a fallback.
- **Tree-changed debounce** — 1-second debounce prevents rapid-fire tree refreshes from bulk operations.
- **PathPicker cache** — admin panel directory picker caches tree API for 30s, preventing N duplicate calls.
- **ETag conditional (304)** — note GET returns 304 Not Modified when content unchanged, saving bandwidth.
- **Backend always rebuilt --no-cache** — prevents stale Docker cache from deploying old binaries.
- **False update banner** — no longer shows "v3.2.1 → v1.0" when backend is slow/unreachable.
- **iPad viewport** — `100dvh` accounts for mobile browser bar. View mode toggle visible on tablets.
- **Copy path URI** — uses `mdnest://@alias/namespace/path` format for LLM readability.
- **WebSocket status text** — shows "Live", "Reconnecting", or "Offline" next to the status dot.
- **CLI login warning** — warns before overwriting default server with a different URL, suggests aliases.

---

## v3.2.0 — Two-Factor Authentication & Account Security

### New Features
- **Two-Factor Authentication (TOTP)** — authenticator app support (Google Authenticator, Authy, 1Password). QR code setup, recovery codes, admin reset.
- **Mandatory 2FA** — `REQUIRE_2FA=true` in config forces all users to set up 2FA. Guided setup flow during login with QR code + step-by-step instructions.
- **Shared 2FA across servers** — `export-2fa` / `import-2fa` commands let admins share TOTP secrets across multiple mdnest instances. One authenticator entry for all servers.
- **Forced password change** — new users must change their password on first login (`must_change_password` flag).
- **Block/unblock users** — admin can block users, preventing login with a clear error message.
- **Multi-step login flow** — password → forced password change → 2FA setup/verify → JWT. Each step shows a clean UI.
- **30-day sessions** — JWT expiry extended from 24 hours to 30 days (safe with 2FA).
- **Auto-migrate on rebuild** — `./mdnest-server rebuild` automatically runs database migrations for multi-user mode.

### Fixes
- **Mermaid text colors** — injected SVG `<style>` override ensures light text on all diagram types. No more black text on load or color toggling on click.
- **Mermaid label click** — diagram-type agnostic click handler. Works on all mermaid types (sequence, flowchart, class, etc.) by finding nearest `<g>` group text instead of checking specific CSS classes.
- **Mermaid label replace** — handles `<br/>` line breaks at any word boundary via brute-force matching.
- **WebSocket stale closure** — collab message handler used stale namespace/path from closure, causing one user's saves to disrupt another user's view. Now uses refs for current values.
- **Editor mode reset** — switching files no longer resets Live mode to Basic. Editor/view mode are global user preferences, not per-file.
- **Table cell selection** — multi-cell selection now visually highlights in Live editor (blue overlay).
- **Table row paste** — copying table rows and pasting inside an existing table inserts rows after the current row instead of creating a new table.

### Config
- `REQUIRE_2FA=true|false` — require all users to set up 2FA (default: false)
- `TOTP_ISSUER=name` — issuer name shown in authenticator app (default: mdnest)

---

## v3.1.8 — Developer Experience & Security

### New Features
- **Pre-push git hook** — verifies frontend/backend compile, npm audit, govulncheck, lock file integrity, and version consistency before every push. Install with `./mdnest-server dev-setup`.
- **`remove-namespace` command** — lists namespaces, removes config entry and deploy key. Files on disk are NOT deleted.
- **Improved `add-namespace`** — two clear paths (GitHub clone or local directory), SSH verification, auto-clone, branch name prompt, never exits on bad input (re-prompts instead), auto-creates subdirectories for non-empty paths.

---

## v3.1.7 — Mermaid Improvements & UX Polish

### New Features
- **Per-file preferences** — each file remembers its view mode (editor/split/preview), editor mode (basic/live), and scroll position in localStorage. Survives page refresh.
- **Default to Live editor** — new files open in Live editing mode instead of basic textarea.
- **Sync status visible to all users** — "Synced 5m ago" green dot shown to collaborators, not just admins. Sync trigger button stays admin-only.
- **`add-namespace` command** — `./mdnest-server add-namespace` walks through creating a namespace: directory, git init, deploy key generation, remote URL setup.

### Fixes
- **Mermaid color revert on label edit** — mermaid.initialize was only in Preview.jsx; Live mode used default pastel theme. Moved to shared `mermaid-config.js`.
- **Mermaid text contrast** — smart post-processing detects parent node fill brightness and forces dark or light text for readability.
- **Mermaid label click for multi-line labels** — labels with `<br/>` line breaks now correctly detected and replaced in source.
- **Mermaid code consolidated** — theme config, initialization, and text color fix all in one shared file.
- **Refresh icon moved** — now appears right after the file path instead of at the end of the toolbar.
- **Raw editor paste fix** — pasting markdown text no longer wraps it in triple backticks.
- **Git-sync fresh repos** — first push uses `--set-upstream` for newly created namespaces.
- **Git-sync SSH alias auto-fix** — detects `host:path` format (without `git@`) and rewrites to `git@github.com:path`.
- **Rebuild force-recreates git-sync** — volume-mounted services always restart on rebuild.

---

## v3.1.1 — Critical Save Fix

### Fixes
- **Live Editor stale onChange (critical)** — switching files in Live mode caused 409 conflicts and lost changes. Milkdown's `markdownUpdated` listener captured `onChange` once at editor creation, so saves went to the wrong file path after switching. Fixed with `onChangeRef` that always points to the latest callback.
- **MutationObserver phantom saves** — Milkdown's async MutationObserver fired `markdownUpdated` after `replaceAll`, triggering phantom saves that changed file ETags. Now suppressed until real user interaction (keydown/mousedown).
- **Auto-refresh poll race condition** — in-flight `getNote` responses from the previous file could overwrite the new file's state after switching. Now discards stale responses.
- **Save timer stale closure** — `saveTimer` was React state (stale in closures), changed to ref. Cleared on file switch.
- **Version update banner** — active sessions show a blue banner when server is updated, with "Refresh Now" button.
- **Browser cache on deploy** — nginx serves `index.html` with `no-cache` so hard refresh picks up new bundles.

---

## v3.1.0 — Mermaid Zoom & Live Toolbar

### New Features
- **Mermaid zoom controls** — `−` / `+` / `Fit` buttons in the mermaid toolbar. Zoom 20%–300% via CSS transform. Small diagrams render at natural size, large diagrams fill container width.
- **Rich text formatting toolbar** — Live mode now has a full toolbar: Bold, Italic, Strikethrough, Code, H1/H2/H3, Bullet/Numbered list, Blockquote, HR, Link, Code block, Table, +Row/+Col/-Row/-Col.
- **Copy mermaid code** — Copy button in mermaid toolbar copies the source code to clipboard.
- **Version update banner** — when the server is updated, active sessions show a blue banner with current → new version and a "Refresh Now" button. Polls `/api/config` every 60s.

### Fixes
- **Live Editor stale onChange (critical)** — switching files in Live mode caused 409 conflicts and lost changes. Root cause: Milkdown's `markdownUpdated` listener captured `onChange` once at editor creation, so saves went to the wrong file path. Fixed by using a ref that always points to the latest callback.
- **Auto-refresh poll race condition** — in-flight `getNote` responses from the previous file could overwrite the new file's state. Now discards stale responses via a poll key check.
- **Save timer stale closure** — `saveTimer` was React state (stale in closures). Changed to `useRef` and cleared on file switch.
- **Smart mermaid sizing** — uses SVG viewBox dimensions (reliable) instead of width attribute (unreliable). Small diagrams centered at natural size, large diagrams fill container.
- **Mermaid fullscreen** — was broken because modified SVG (stripped attributes) was passed to viewer. Now stores and passes original unmodified SVG.
- **Scroll position on view switch** — switching between editor/split/preview modes now preserves scroll position.
- **Browser cache on deploy** — nginx now serves `index.html` with `no-cache` header so hard refresh always picks up new JS bundles.

---

## v3.0.0 — Live Rich Editor

### New Features

- **Live editor mode** — Obsidian-style rich editing powered by Milkdown (ProseMirror). Markdown renders inline as you type: bold shows bold, headings render as headings, lists format in place. Toggle between Basic (plain textarea) and Live mode from the toolbar.
- **Interactive table editing** — click into table cells to edit. Toolbar buttons to insert tables, add/remove rows and columns. Tab between cells.
- **Mermaid inline rendering** — mermaid code blocks render as diagrams in-place in Live mode with Source/Preview/Fullscreen buttons. Click any node or edge label to edit it directly on the diagram.
- **Clickable checkboxes in edit mode** — task list checkboxes work in Live mode without switching to preview.
- **Rich paste** — paste from Google Docs, Confluence, or any rich source into Live mode and it inserts as parsed markdown nodes (headings render as headings, not `# text`).
- **Scroll sync** — editor and preview scroll proportionally in split view.
- **Collapsible headings** — click the toggle icon on any heading in preview to collapse/expand that section. Expand All / Collapse All buttons in preview toolbar.

### Improvements

- **Lazy-loaded Live editor** — Milkdown only downloads when you switch to Live mode (462KB chunk). Main bundle stays at 311KB for fast initial load.
- **Smart backspace** — empty headings/blockquotes convert to paragraphs on single backspace in Live mode.
- **Text selection in mermaid** — can select and copy text from rendered mermaid diagrams in preview mode. Fullscreen expand moved to a hover button.
- **Editor mode per view** — Live mode preference is separate for editor-only view. Split view always uses Basic mode.
- **Heading collapse** — only the toggle icon (not heading text) triggers collapse. Expand All properly shows all nested content.
- **Copy buttons** — headings show a clipboard icon on hover (copies heading text). Code blocks show a "Copy" button on hover (copies code content).
- **Table delete controls** — separate Del Row, Del Col, Del Table buttons using direct ProseMirror commands (cursor in cell is enough, no need to select).
- **Scroll position persistence** — each document remembers its scroll position. Switch between documents and your reading position is restored.
- **Mermaid label editing for sequence diagrams** — participants, messages, and other sequence diagram labels are clickable alongside flowchart nodes.
- **Auto-expanding label editor** — mermaid label input grows/shrinks with text content.

### Dependencies

- Added: `@milkdown/core`, `@milkdown/ctx`, `@milkdown/react`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, `@milkdown/plugin-listener`, `@milkdown/plugin-history`, `@milkdown/plugin-clipboard` (all v7.20)
- Existing: `marked` (preview/basic mode), `mermaid` (diagrams) unchanged

### New Files

- `frontend/src/components/LiveEditor.jsx` — Milkdown editor wrapper with table toolbar, mermaid node view, paste handling
- `frontend/src/components/MermaidBlock.jsx` — React component for inline mermaid with Source/Preview toggle and click-to-edit labels

---

## v2.1.0 — Multi-Server CLI + Git Sync Fix

### New Features
- **Multi-server CLI** — manage multiple mdnest servers with `@alias` paths. `mdnest login @work <url> <token>`, then `mdnest read @work/engineering/docs.md`. Single-server users see zero change.
- **Flat CLI commands** — `mdnest read`, `mdnest list`, `mdnest search` etc. (no more `mdnest note` prefix needed, though it still works).
- **`mdnest servers`** — list all configured servers with versions and reachability.
- **Copy Path includes server alias** — right-click Copy Path in the web UI gives `@work/namespace/path` when `SERVER_ALIAS` is set, directly pasteable into the CLI.
- **Collapsible headings in preview** — click any heading to fold/unfold the section. Expand All / Collapse All buttons in preview toolbar.
- **Git sync status indicator** — green dot + "Synced 5m ago" in sidebar header.
- **Sync button commits + pushes** — pressing sync now does git add + commit + pull + push (was pull-only before).

### Fixes
- **Git-sync SSH key** — the git-sync sidecar now falls back to `SSH_KEY_PATH` when `git-sync/keys/` is empty. One SSH key config works for both the sync button and the auto-sync cycle.
- **Mermaid inline sizing** — 50% on desktop, 90% on mobile. Removed inline style override.
- **Sync button reloads current note** — not just the tree.
- **Tree arrows bigger and blue** — more visible expand/collapse indicators.
- **Hard refresh on login** — clean state, no stale data.
- **Removed "no key" warning** — was confusing for users who don't need git pull.

### Configuration
- `SERVER_ALIAS` — optional, sets the `@alias` used in CLI paths and Copy Path.
- `SSH_KEY_PATH` — now used by both the backend sync button AND the git-sync sidecar.

---

## v2.0.1 — Patch Release

### Fixes
- **Drag-drop to ancestor directories** — moving items up the tree (e.g. subdir to parent) was blocked by an overly aggressive guard. Fixed.
- **SSH key mount for git pull** — sync button now supports SSH authentication. Set `SSH_KEY_PATH` in `mdnest.conf` pointing to a passphrase-free deploy key.

### New Features
- **HTML-to-Markdown paste** — copy from Google Docs, Confluence, Notion etc. and paste into the editor. Rich content (headings, bold, lists, tables, code blocks) auto-converts to clean Markdown.
- **View mode persistence** — your Edit/Preview/Split selection is remembered across page reloads (stored in localStorage).
- **Mobile toggle restyle** — Edit/Preview buttons are now pill-shaped buttons instead of flat tabs.

---

## v2.0 — Multi-User Collaboration

> Powerful, privately-hosted Markdown notes — use it the way you like.

mdnest v2.0 transforms the app from a personal note tool into a collaborative workspace for teams, while keeping the default single-user experience unchanged.

### Upgrading from v1

If you're running mdnest v1 (single-user), **no changes are required**. Your existing setup continues to work exactly as before. Multi-user features are opt-in.

To enable multi-user mode:

1. Update your code:
   ```bash
   cd mdnest
   git fetch origin
   git checkout v2.0
   ```

2. Edit `mdnest.conf` — add:
   ```
   AUTH_MODE=multi
   POSTGRES_PASSWORD=a-secure-password
   ```

3. Run setup and migrate:
   ```bash
   ./mdnest-server setup      # regenerates docker-compose.yml with Postgres
   ./mdnest-server migrate    # creates database tables
   ./mdnest-server rebuild    # rebuilds and starts everything
   ```

Your first user (from `MDNEST_USER`/`MDNEST_PASSWORD`) becomes the admin automatically.

To also enable live collaboration:

4. Add to `mdnest.conf`:
   ```
   ENABLE_LIVE_COLLAB=true
   ```

5. Rebuild:
   ```bash
   ./mdnest-server rebuild
   ```

### New Features

#### Multi-User Mode (E1-E6)
- **PostgreSQL-backed user management** — optional, only when `AUTH_MODE=multi`
- **Roles** — Admin and Collaborator. Admins can invite users and manage access.
- **Namespace & directory-level access grants** — control who can read or write to which namespaces and subdirectories. `write` implies `read`. Grant on `/` covers the full namespace.
- **Permission enforcement** — every API endpoint checks access. Collaborators only see namespaces they have grants for.
- **Admin panel** — manage users (invite, promote/demote, delete) and access grants from the web UI. Accessible via the user avatar menu.
- **Frontend permission awareness** — read-only mode for view-only grants, write actions hidden when no permission, 403 handled gracefully (no redirect to login).
- **Logout button** and user identity display in the sidebar.
- **`/api/config`** — public endpoint returns auth mode and feature flags so the frontend adapts.
- **`/api/me`** — returns current user profile and grants.
- **Database auto-migration** — tables created automatically on startup. Safe to run on every restart.
- **`mdnest-server migrate`** — standalone command for running migrations before starting.

#### Live Collaboration (E7)
- **WebSocket-based presence** — see who else has the same note open, with colored avatar dots and usernames.
- **Real-time cursor tracking** — colored cursor lines show where other users are in the document, with name labels.
- **Live content sync** — when one user types, others see the changes in real-time (~200ms). When both type simultaneously, each keeps their own content to avoid conflicts.
- **Typing indicator** — pulsing avatar and "bob is typing..." text in the presence bar.
- **ETag conflict detection** — `GET /api/note` returns an ETag, `PUT /api/note` accepts `If-Match`. Stale saves return 409 Conflict.
- **Conflict banner** — when another user saves while you have unsaved changes, a banner appears with a Reload button.
- **Auto-reconnect** — WebSocket reconnects automatically with exponential backoff on connection drop.
- **No external services** — everything runs on your server via `nhooyr.io/websocket`. No Firebase, no Google, no third-party dependencies.

#### UI Improvements
- **Resizable sidebar** — drag the right edge to make the project pane wider or narrower (180px–600px).
- **SVG file tree icons** — replaced emoji icons with crisp SVG icons. Folders with content show blue, empty folders show dashed grey outline with italic name.
- **Directory-level share dialog** — right-click any folder → "Manage Access" opens a clean dialog to add/remove users with read/write toggles per directory.
- **Directory picker for grants** — admin panel shows actual folder tree in dropdown instead of free-text path input.
- **User-centric grants accordion** — admin panel Access Grants tab shows each collaborator as an expandable card with all their directory grants inline.
- **Namespace sync button** — admin can click the sync icon in sidebar to trigger git pull and refresh the file tree.
- **Copy Path** — right-click any file or folder to copy its full mdnest path (e.g. `growth/docs/readme.md`) to clipboard.
- **User avatar menu** — sidebar footer shows user initials in a circle, click to open dropdown with "Manage Users & Access" and "Sign Out".
- **Tree filtering by grants** — collaborators only see directories they have access to, not the full namespace tree.
- **Mobile improvements** — Edit/Preview toggle moved to top, editor fills full screen width, sidebar resize handle hidden on mobile.

### Bug Fixes
- Fixed links in preview opening in the same tab instead of a new tab (marked v15 renderer compatibility).
- Fixed WebSocket proxy through nginx (missing upgrade headers).
- Fixed concurrent editing overwriting — remote content only applied when local user is idle.
- Fixed live content sync stopping after first remote update.

### Configuration Reference

New settings in `mdnest.conf` (all optional, defaults preserve v1 behavior):

| Setting | Default | Description |
|---------|---------|-------------|
| `AUTH_MODE` | `single` | `single` (file-based) or `multi` (PostgreSQL) |
| `POSTGRES_PASSWORD` | — | Required when `AUTH_MODE=multi` |
| `POSTGRES_HOST` | `postgres` | PostgreSQL host (use `postgres` for built-in container) |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `mdnest` | PostgreSQL database name |
| `POSTGRES_USER` | `mdnest` | PostgreSQL user |
| `ENABLE_LIVE_COLLAB` | `false` | Enable WebSocket presence and live editing |

### Docker Changes

When `AUTH_MODE=multi`, `setup.sh` automatically adds a `postgres` service to `docker-compose.yml` with:
- `postgres:16-alpine` image
- Health check (`pg_isready`)
- Persistent volume (`mdnest-pgdata`)
- Backend `depends_on` with health condition

### API Changes

New endpoints (multi-user mode only):

| Endpoint | Description |
|----------|-------------|
| `GET /api/config` | Public — returns auth mode and feature flags |
| `GET /api/me` | Current user profile + grants |
| `POST /api/admin/invite` | Create a new user (admin only) |
| `GET /api/admin/users` | List all users (admin only) |
| `PUT /api/admin/users?id=` | Update user role (admin only) |
| `DELETE /api/admin/users?id=` | Delete user (admin only) |
| `POST /api/admin/grants` | Create access grant (admin only) |
| `GET /api/admin/grants` | List grants (admin only) |
| `PUT /api/admin/grants?id=` | Update grant permission (admin only) |
| `DELETE /api/admin/grants?id=` | Revoke grant (admin only) |
| `POST /api/admin/sync?ns=` | Git pull + cache refresh for a namespace (admin only) |
| `GET /api/ws` | WebSocket for live collaboration |

Changed endpoints:

| Endpoint | Change |
|----------|--------|
| `GET /api/note` | Now returns `ETag` header |
| `PUT /api/note` | Accepts `If-Match` header, returns 409 on conflict. Response includes `etag` field. |
| `GET /api/namespaces` | In multi mode, filtered to user's granted namespaces |
| `GET /api/tree` | In multi mode, filtered to user's granted directories |

---

## v1.0 — Self-Hosted Private Knowledge Base

The initial release. A single-user, file-based markdown notes app.

### Features
- **Markdown editor** with live preview, split view, and formatting toolbar
- **Mermaid diagrams** rendered inline with interactive fullscreen viewer
- **Task checkboxes** — click to toggle in preview, auto-saves to file
- **Image upload** — paste or drag images into the editor
- **Full-text search** with concurrent file reading and cached file index
- **Namespace model** — mount multiple host directories as separate workspaces
- **REST API** with JWT and API token authentication
- **MCP server** for AI agent integration (Claude, Cursor)
- **CLI tool** (`mdnest`) for terminal-based note access from any machine
- **Git sync** — optional auto-commit and push to private repos
- **Mobile responsive** — works on phone, tablet, desktop
- **Docker deployment** — multi-stage builds, nginx proxy, alpine runtime
- **Private by default** — binds to localhost, no cloud, no telemetry
- **Tailscale ready** — one command for encrypted remote access
