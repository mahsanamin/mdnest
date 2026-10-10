# mdnest - AI Context

Privately-hosted Markdown notes app. Plain files on disk, Docker-based. Supports single-user (no database) and multi-user (PostgreSQL) modes.

## Quick Orientation

- **Backend**: Go (net/http + golang-jwt + lib/pq), lives in `backend/`
- **Frontend**: React + Vite + Milkdown (live editor), lives in `frontend/`
- **Docker**: multi-stage builds, nginx proxy, optional git-sync sidecar
- **MCP Server**: Node.js, lives in `mcp-server/` — wraps REST API for AI assistants
- **Config**: `mdnest.conf` -> `setup.sh` generates `docker-compose.yml` and `.env`

## Skills — which to invoke, and when (read this first)

This repo ships slash-command skills (in `.claude/skills/`, `md-*` prefix) that
encode the *full, correct* multi-step process for the recurring workflows. **When
a request matches one of these workflows, invoke the skill — whether the user
typed the slash command or asked in their own words ("fix these bugs", "add this
feature", "ship it").** The skill is the source of truth for the steps (branch
strategy, verification gate, no-per-bug-PR rule, clean-commit / no-attribution
rule, `-dev` version scheme, delete-the-bug-file-when-fixed, release recipe). Do
not improvise an ad-hoc version that skips steps — an ad-hoc bug fix must still
follow `md-fix-bugs`.

| If the user wants to… | Invoke | It covers |
|---|---|---|
| Fix bug(s) — from the brain `Bugs/` folder **or** an ad-hoc bug they describe | **`md-fix-bugs`** | Read/triage the backlog, verify it's really a bug (some are already fixed), fix each on its own branch from `develop`, verify (smoke test + a regression check), merge **straight into `develop`** (no per-bug PR), **delete the bug's file from the brain** so it isn't re-picked, then one clean release PR on top of `main`. |
| Add a feature / improvement — from the brain `Features/` folder or described ad-hoc | **`md-add-improvement`** | Same disciplined flow for the features backlog. |
| Ship / release / "update the docs + website + rebuild" after code changes | **`md-ship`** | CHANGELOG, three-file version bump, docs, website sync, rebuild the dev stack, publish the GitHub Release (tags ≠ Releases — the in-app banner needs a Release). |
| Handle a **GitHub issue** someone filed — "take care of issue 87", "here's the issue \<url\>", "someone reported X, deal with it" | **`md-issue-process`** | The whole arc for one issue: read it (including the screenshot — one report is often two bugs), split it into symptoms, decide which are even ours, reproduce the *mechanism* without owning the reporter's machine (PATH shims, containers), fix each per `md-fix-bugs`, add the test that would have caught it, release via `md-ship`, then reply to the reporter (owner's go-ahead first — it's public and under his name), close, and record the lessons in the brain. |
| Review PR(s) from an outside contributor — "what should we merge?", "check this PR", "is this safe?" | **`md-review-collab`** | Three gates in order: **legit** (does it do what it claims — verify by running, don't read), **safe** (no weakened path/permission check, no exploit), **direction** (doesn't trade away git-as-storage, mount-defined namespaces, or the lean core). Then merge order (simulate conflicts first), a review that only says what must be said, and merge into `develop` with owner sign-off on anything touching direction. |

If unsure which applies, prefer the skill over an ad-hoc approach and say which one
you're running. The `md-*` family is authoritative; the summaries here are just a
router. See also the **Release Process** section below (the skills implement it).

## Project Structure

```
backend/
  main.go                    # Entry point, route registration, AUTH_MODE branching
  routes.go                  # v4.6.2+ — the content-route table (registerContentRoutes): which guard wraps which route, in one function. routes_test.go builds it with fake grant stores and drives it over HTTP through the real auth middleware — a guard that is wrong in the WIRING (not in a handler) fails there. A route that serves one note needs read/write on that note's path (RequireRead / ReadWriteRouter), never just RequireNsAccess: grants can be path-scoped. A listing that spans a namespace filters each item with middleware.ReadFilterFor (fails closed if the checker isn't attached). /api/download is RequireRead on its ?path=; /api/transfer has NO route middleware because its two namespaces are in the body — its handler's required canRead/canWrite (pc.CheckRead/CheckWrite) are the guard, and TestRoutes_TransferChecksBothSides pins them through the real table.
  handlers/
    auth.go                  # POST /api/auth/login (JWT)
    namespaces.go            # GET /api/namespaces (lists mounted dirs)
    tree.go                  # GET /api/tree?ns= (recursive dir listing)
    notes.go                 # GET/POST/PUT/PATCH/DELETE /api/note?ns=&path=
    search.go                # GET /api/search?ns=&q= (concurrent search with caching)
    tokens.go                # GET/POST/DELETE /api/auth/tokens (API token management)
    totp.go                  # 2FA: TOTP setup, verify, disable, admin reset
    upload.go                # POST /api/folder, /api/upload, GET /api/files/ (ns comes from the URL path, so the read check is IN the handler, not middleware)
    upload_test.go           # First Go test in the repo (v3.11.7+) — pins the /api/files/ cross-namespace authz check
    move.go                  # POST /api/move?ns=&from=&to=
    transfer.go              # POST /api/transfer (+?dryRun=1) — move/copy a file or folder to another namespace (issue #114). The body names TWO namespaces, so the query-param middleware cannot guard it: canRead/canWrite are REQUIRED constructor args (nil denies) and both sides are checked in the handler before anything is written. A cross-namespace move is copy → verify → delete-source, never a rename across mounts. A copy re-IDs every note (StripAllNoteIDs + fresh marker) and carries no comments; a move carries each `.mdnest/comments/<uuid>.jsonl` to the ID the note actually LANDED with (the git backend can restore an older marker on a reused path), keeps only lines that decode as a Comment, and carries NOTHING (the thread stays in the source) when a note outside the moved set still claims the ID, when the source has more than maxClaimScan notes to check, or when the destination already has that thread — it never merges into one. Rollback and the source delete touch only the entries this transfer created or planned (removeEntries), never RemoveAll on a path a concurrent writer may share. Real transfers take a slot like downloads; dry runs never do. Proxied to the writer on MDNEST_ROLE=app.
    download.go              # GET /api/download — a file as an attachment, a folder as a streamed zip. Routed with path-scoped RequireRead, NOT RequireNsAccess (that would let a /Shared grant zip /Private). Limits are counted before the first byte (413 JSON); zip downloads hold one slot per user (uc.ID, so N tokens are one user; single mode is one key) + DOWNLOAD_MAX_CONCURRENT globally, non-blocking (429), released by defer; a ctx check per entry AND ctxReader per read stop a cancelled download — each alone passes the cancel test, removing both fails it.
    treecopy.go              # Shared by download + transfer: TreeLimits (DOWNLOAD_MAX_FILES/MB), planTree (skips + records symlinks and nested .git/.mdnest, case-insensitively; STOPS once past a limit — 413 then carries "partial": true), the 413 body, download slots, contentDisposition (ASCII fallback + RFC 5987). Links and .git/.mdnest on the REQUESTED paths are not handled here: CheckRead/CheckWrite resolve links (storage.LinkResolver) and relpath.Clean refuses reserved segments, so download and transfer inherit the v4.6.2 rules instead of keeping a second copy of them.
    path.go                  # SafePath(), RequireNamespace() — shared utils
    noteid.go                # ExtractNoteID / InjectNoteID / EnsureNoteID (UUID marker). StripAllNoteIDs removes EVERY marker — readers take the first match, so stripping only one lets a second become the identity. Create and PATCH append/prepend strip incoming markers (a prepended marker used to become the note's ID, and so its comment thread); PUT keeps the note's own.
    comments.go              # GET/POST/PATCH/DELETE /api/comments?ns=&path=&id=
    history.go               # GET /api/note/history, /api/note/at — git-sync version history (v3.7.0+)
    sso.go                   # GET /api/auth/sso/{start,callback} (USER_PROVIDER=sso only)
    tasks.go                 # GET/POST/PATCH /api/tasks, /api/board — task board (v4.0.0+, ENABLE_TASK_BOARD)
    workspaces.go            # /api/admin/workspaces, /api/me/workspace — per-workspace git remotes (v4.0.0+, multi mode)
    chat.go                  # File-based chat, ON by default (ENABLE_CHAT=false turns it off; ChatEnabled keeps it off for MDNEST_ROLE=app, where the per-process note lock cannot serialise replicas). Built-in reaction SVGs are go:embed'ed from handlers/chatgifs/ and served publicly at /api/chat/gifs/builtin/; a namespace's ChatGifs/ overrides them by name, and messages reference images as ![x](gif:NAME). GET/POST /api/chat, POST /api/chat/convert, GET /api/chats. The note IS the chat — a `mdnest-chat: true` frontmatter tag is the only marker; no DB, no sidecar. /api/chats spans namespaces, so like /api/tasks/all its nsFilter + canRead are REQUIRED constructor args and nil denies. Reads support `format=text` so the bash CLI never parses JSON. The list's per-file index is keyed by size+mtime and only re-reads changed files.
    chat_members.go          # v4.8.4+ (issue #127) — GET/POST/DELETE /api/chat/members: private chat member lists, multi mode only. The handler checks nothing about membership itself: PermissionChecker.check refuses a non-member BEFORE the namespace-admin shortcut, so every route that serves a note (and ReadFilter for every listing) enforces it. A chat with no rows is open, as before. convert?private=1 writes the member row BEFORE the note so a new private chat is never briefly open. The last member cannot be removed (store.ErrLastChatMember, row-locked). Removal (and making an open chat private) closes non-members' live websocket connections via Hub.DropUsers: a websocket is authorised once, at join, so nothing else would reach an editor tab already open. convert?private=1 is refused (409) on an existing note, or any writer could take a shared note away from everyone else. Making an existing OPEN chat private (POST members on a chat with no list) needs namespace-admin scope, for the same reason (convert, then make private). /api/move refuses an existing destination (os.Rename replaced files silently, which let a writer drop their private chat over a shared note). The namespace-admin shortcut in check() still resolves symlinks for private chats, and ReadFilter's admin and whole-namespace branches resolve them too: both used to skip resolution, so a link to a private chat leaked it into search and tasks.
    chat_members_follow.go   # v4.8.4+ — move / transfer carry the member list along: rows are COPIED to the destination (REPLACING any list left there, so a removed member cannot come back with an old one) before the files move. A failed move calls RestoreCopy, which undoes exactly that copy. Never "delete everything under the destination": the first version did, and a move aimed at an existing folder (rename fails) wiped the list of a private chat living there and opened it. Source rows are NEVER removed, on move or delete: git history is served by path (note/history, note/at), so the old path must stay closed. noForeignChatsUnder ignores such leftover rows once no file is there (fileExists), so they do not block folder ops forever. Folder ops by a non-member are refused by CheckWriteTree / CheckReadTree; folder download filters each file.
    chat_traits.go           # v4.8.4+ — each agent's role in a chat, kept in the note's front matter under `agents:` (one quoted line per name, cut at 300 chars). Set by POST /api/chat/agents (the Connect an agent panel saves it on Copy prompt) or a `/role ...` post. A format=text GET with exclude=NAME that returns messages ends with a reminder line naming NAME's role: the wait output is the one thing an agent reads every round, so it survives the agent's context being summarised, and it needs no CLI change. Never add the reminder to an EMPTY poll — the CLI treats any body as news.
    chat_owner.go            # v4.8.4+ — who may delete a chat: its owner (`owner:` in the front matter, stamped by convert; a pre-4.8.4 chat falls back to its first message's account; an empty one with neither is anyone's), a namespace admin, or a superadmin. Checked on EVERY way a chat can go: DELETE of the note and of a folder holding it (blockedChat walks it), an upload over it, and a PUT or top PATCH that would un-chat it or change the owner (chatEditAllowed) — a guard on DELETE alone was bypassed by stripping the marker first. GET /api/chat and /api/chats report owner + canDelete. Single mode (no user, no checker) may; a multi-mode request with a checker but no user may not. `chat wait` exits 3 on a 404/403 mid-wait and prints the leave command, which the keepalive hook reads as "out of the chat" (tests/cli-chat-gone.sh).
    approvals.go             # v4.8.5+ (experimental, ENABLE_AGENT_APPROVALS, off by default and never on MDNEST_ROLE=app): an agent's PermissionRequest hook (`mdnest approval request`) posts its hook input, long-polls /wait, and prints the hook output this server builds per agent. In-memory requests (10 min default, 60 max, 20 pending per account, 64 KB). Owner-only: another account gets 404/410. /decide refuses an API token (middleware.RequestViaAPIToken) because the agent runs on its owner's token; routes_approvals_test.go pins it through the real auth middleware and fails if the check is removed. The hook input is parsed with EXACT keys (strictObject refuses duplicate or case-variant keys, which encoding/json would silently accept) and the command is shown through visibleText (an allowlist; everything else becomes \u{XXXX}), so the card cannot show a different command than the one that runs. A chat card is a marker plus a neutral line; the command is never written into the chat note.
    approvals_tools.go       # v4.8.5+: per tool. AskUserQuestion (parseQuestions, answerText: picked labels in option order joined ", ", typed text last, which is what Claude Code 2.1.295 itself produces; checked through a pty-driven session), "allow for this session" (sessionPermissions: only addRules/addDirectories, destination forced to "session"), readable Write/Edit details. A question cannot be plainly allowed.
    approvals_notices.go     # v4.8.5+: notices (stuck or stopped agents, no buttons). A permission_prompt is skipped while the session has an open card; one per session and kind; 50 per account, 12 h; the chat gets a fixed line, never the agent's text. Pending requests are capped at 100 per account AND 20 per machine label (approvals.go).
    chat_markdown.go         # The PURE half of chat: IsChatNote / ParseChat / RenderChatMessage / AppendChatMessage / ConvertToChat. A message starts at `#### author · <UTC ISO time>`; the timestamp is what keeps a plain `####` heading from parsing as a message, and a body line that would parse as a header is stored `\`-escaped so nobody can forge another poster's message. `as` is a label — in multi mode a label that isn't the account is written `label (via account)`.
    notelock.go              # Per-note, per-process lock (refcounted keyed mutex). Held by append/prepend (PATCH), chat post/convert, AND the If-Match check + write in PUT — the old PATCH was read-modify-write with no lock, so concurrent appends silently dropped text (mutation-verified: 40 concurrent posts kept 2). Per-process ONLY: the MDNEST_ROLE=app multi-replica tier is not covered, which is why chat is not offered in the Helm chart.
    tasks_markdown.go        # v4.2.0+ — the PURE markdown half of the task board (parse a task line + its detail block, resolve columns, render a spec back to markdown, generate stable refs). Split out of tasks.go by a verified pure move; tasks.go is request handling only. Put new parsing/rendering here, not in the handler.
    team.go                  # GET /api/namespace/users — namespace members for the assignee picker (v4.2.0+, multi mode). Uses a narrow interface, deliberately NOT on GrantStore, so existing fakes are untouched.
    groups.go                # /api/admin/groups(/members|/grants) — role-based access Groups (v4.2.0+). Superadmin-only; multi mode only.
    attribution.go           # GET /api/note/attribution (v4.2.0+). Route is NOT registered without a DB — single mode has no identities to attribute.
    stickies.go              # GET/PUT /api/stickies (v4.5.0+) — the per-user sticky board. Registered in BOTH auth modes and, like preferences, resolves a single-mode request (which arrives with NO user context) to the single-mode user. The board is addressed ONLY by the authenticated identity — no user id, path or namespace in the request — so cross-user access is not a check that can be forgotten, it is not expressible.
    preferences.go           # GET/PATCH /api/preferences (v4.3.0+) — per-user UI settings, registered in BOTH auth modes. NOTE: the auth middleware attaches a UserContext only in MULTI mode, so a single-mode request arrives fully authenticated with NO user context; the handler resolves that to the single-mode user and still refuses it in multi mode (where it means an unmappable API token). Unit tests that inject a context by hand cannot catch this — one that calls the handler the way the middleware does is in preferences_test.go.
    marp_themes.go           # GET/PUT/DELETE /api/marp/themes (v4.2.0+, ENABLE_MARP_THEMES). GET is any authenticated user (any deck must resolve its theme); PUT/DELETE superadmin.
    marp_starter.css         # Seeded once into the empty theme catalog.
  firebase/                  # Firebase Auth + Firestore (USER_PROVIDER=firebase only)
    client.go                # Admin SDK wrapper (VerifyIDToken)
    totp_store.go            # Firestore-backed store.TOTPStore impl
  secrets/                   # AES-256-GCM sealing for git credentials at rest (v4.0.0+)
    secrets.go               # DeriveKey/Encrypt/Decrypt — same construction as the MCP OAuth sealing
  relpath/                   # The one lexical rule for namespace-relative paths (relpath.Clean). Leaf package on purpose: handlers.SafeRelPath IS relpath.Clean, and the permission middleware cleans ?path=/from=/to= with it before checking grants. Before v4.5.5 the middleware checked the raw string while handlers acted on the cleaned one, so a ".." segment walked a request out of a path-scoped grant. Never authorise a path you have not cleaned the same way the handler will.
  storage/                   # Pluggable note persistence behind STORAGE_BACKEND (v4.0.0+)
    storage.go               # Storage interface — namespace-scoped, backend-agnostic. Optional capabilities: RangeReadable, LinkResolver (v4.6.2), Annotator (a line in the namespace's next commit body, kept to one line by oneLine so a path cannot forge a trailer). A wrapper (CoherentStorage) must FORWARD each one explicitly — embedding an interface does not promote methods outside it; TestStacksImplementLinkResolver / TestStacksImplementAnnotator pin every stack.
    local.go                 # Default filesystem backend; owns the symlink-containment check
    git.go                   # STORAGE_BACKEND=git — in-process git history, idle-debounced commits
    gitremote.go             # Per-namespace remote resolution + push plan (askpass / GIT_SSH_COMMAND)
    queued.go                # MDNEST_ROLE=app — writes go to the working set + durability queue
    writer.go                # MDNEST_ROLE=writer — drains the queue, owns the git tree. NOTE (v4.2.0): OpRename must RE-CACHE the destination from the durable tree, not delete it — app replicas can't re-hydrate on a cache miss, so evicting both ends made a move look like data loss until the next full hydrate. `recacheDest` handles a file and a moved subtree; both are pinned by tests.
    system.go                # Reserved, hidden namespaces (names start with "."), excluded from every listing and picker. Currently .marp-themes. The writer hydrates these explicitly.
    workingset.go            # Redis-backed coherence tier (the shared read path)
    leader.go                # Writer leader election
    factory.go               # FromEnv — local (default) | git [+ REDIS_URL -> coherent]
  sso/                       # Generic OIDC relying-party (USER_PROVIDER=sso)
    client.go                # coreos/go-oidc + oauth2 with PKCE, signed state cookie
  middleware/
    auth.go                  # JWT validation middleware
    context.go               # UserContext. ViaAPIToken (multi mode) and RequestViaAPIToken(r) (both modes: a single-mode request has NO UserContext) record that a request came in with an mdnest_ token, set in auth.go; auth_method_test.go drives the real Wrap.
    cors.go                  # CORS middleware
  updates/                   # Background poller for newer mdnest releases (v3.8.0+)
    checker.go               # 24h GitHub releases poll, served on /api/config as latestRelease
  store/
    db.go                    # Postgres connection pool (multi mode only)
    migrate.go               # Auto-migration: schema_migrations, users, access_grants, firebase_uid (005), avatar_url (006), namespace_admins (007), access_groups (013), note_activity (014), user_preferences (015). **Applied by full NAME, not the numeric prefix** — two migrations sharing a number both run, so a duplicate prefix is a merge conflict and a readability problem, never a silent skip.
    users.go                 # UserStore (Postgres) + UpsertFirebaseUser / PromoteToSuperAdmin
    namespace_admins.go      # NamespaceAdminStore — per-namespace admin scope (v3.5.0+)
    access_groups.go         # GroupStore (v4.2.0+) — groups, members (user_id XOR oidc_group, DB CHECK), group grants. Direct membership resolves LIVE; OIDC membership comes from the token claim.
    note_activity.go         # NoteActivityStore (v4.2.0+) — per-note save trail behind the Attribution panel
    chat_members.go          # ChatMemberStore (v4.8.4+, migration 017 `chat_members`) — keyed by namespace + canonical path, LOWERCASED ("/chats/x.md"): a case-insensitive mount (Docker Desktop on macOS, SMB) serves CHATS/SECRET.md as Chats/secret.md, and a case-sensitive key let that spelling skip the check. middleware.foldPath must fold the same way, and fileExists matches each segment case-insensitively so a leftover-row check still finds Chats/Secret.md on Linux. The flip side, found in review: on a CASE-SENSITIVE disk a lowercased key covers every spelling, so a list written for Shared/DOC.md (a new file) also locks everyone out of the existing Shared/doc.md. handlers.foldedMatches refuses to write a list (convert private=1, members POST, every CopyPrefix destination) where another spelling exists. Migration 018 lowers keys stored by the first develop build; a key left in its original case would silently OPEN its chat. Private chat paths are ASCII-only (PrivateChatPathOK) and, in a namespace with private chats, a non-ASCII request path must byte-match the disk (middleware exactSpelling): a macOS disk folds more than ToLower does (long s, Kelvin sign, NFD). Invite (add a member) and Remove take a per-chat pg_advisory_xact_lock and decide against the list as it is NOW, not as the route saw it, or a removed member spamming POST re-adds themselves (tests/e2e-private-chats-multi.sh catches the unconditional self-add in ~4 of 15 rounds). user_id has NO foreign key on purpose: CASCADE would delete the only member's row when their account goes, and no rows means OPEN. Prefix ops use starts_with, not LIKE, so `%`/`_` in a folder name stay literal; Chats/ never matches Chats_x.md (pinned in tests/e2e-private-chats-multi.sh).
    stickies.go              # StickyStore (v4.5.0+) — the board model (incl. nullable X/Y *float64 for corkboard position: a POINTER so "never dragged" stays distinct from "placed at 0,0"; NaN/Inf are rejected because either one turns the client's board-size arithmetic into NaN and collapses the whole board rather than misplacing one card) and the same Postgres/file split as preferences (migration 016, `user_stickies`, ONE row per user holding the whole board as JSON). The file backend writes to the **secrets dir**, not `NOTES_DIR/.sticky` as first sketched: `/data/notes` is not itself a volume, so a runtime-created dir under it is destroyed by `mdnest-server rebuild` (the v4.2.0 Marp-theme trap). The secrets volume is declared AND invisible to git-sync (which walks `/data/notes/*/`), which is the whole privacy guarantee. Writes are tmp+rename — a board exists nowhere else, so a truncated file loses all of it.
    preferences.go           # PreferenceStore (v4.3.0+) — Postgres (migration 015, user_preferences) in multi mode, preferences.json in the secrets volume in single mode. Same split as TokenStore. Keys are an ALLOWLIST with a length cap: the endpoint is writable by any authenticated user, so an open bag would be a per-user blob store anyone could fill.
    totp_store.go            # TOTPStore interface + PostgresTOTPStore

frontend/
  src/
    App.jsx                  # Root: auth, namespace/tree state, context menu, URL routing
    api.js                   # All API calls (fetch wrapper with JWT + 401 handling). NOTE (v4.5.0): `fetchStickies` deliberately does NOT fail soft, unlike `fetchPreferences` right above it. The two look symmetric and are not — a preference is PATCHed key by key, a board is PUT WHOLE — so returning [] on a failed GET made "could not read your board" indistinguishable from "your board is empty", and the next keystroke replaced the real board with one card. Fail-soft read + whole-object write is a data-loss machine; the caller holds a load state and refuses to save until a read has actually succeeded.
    wikilink.js              # Obsidian [[wikilink]] support (v3.11.5+) — pure module: parse/resolve, marked inline extension, relative-.md-link resolver, restoreWikilinks() serializer-unescape. No React imports (unit-tested standalone).
    theme.css                # v4.3.0+ — the design-token layer. TWO layers, and the second one is load-bearing: primitives (--ctp-*) hold the raw Catppuccin palette (Mocha dark / Latte light), semantics (--bg, --border, --text, --accent, ...) are what every stylesheet uses. Never write a hex literal into App.css / index.css / TaskBoard.css again, and never reference a --ctp-* primitive outside this file.
    stickies.js              # v4.5.0+ — pure module: the sticky board's rules (new card on top, an edit never reorders, normalizeBoard makes a hand-edited stickies.json safe to render) AND the corkboard layout (layoutBoard / boardExtent / clampToBoard). Both views are thin renderers over these. Two things the layout maths is load-bearing about: a card's x/y is NULLABLE rather than defaulting to 0, so "never dragged" (lay it out on the grid) stays distinguishable from "deliberately placed in the corner" — with 0 as the default every card the drawer created would stack in the top-left; and layoutBoard SKIPS grid slots a placed card already occupies, because a new card dealt underneath an existing one is invisible, so "+ New" appears to do nothing. STICKY_COLORS must match store.StickyColors in Go — a colour on one side only 400s the WHOLE board, so `__tests__/stickies.test.js` reads the Go source rather than restating the list.
    theme.js                 # v4.3.0+ — pure module: resolveTheme (user preference -> DEFAULT_THEME -> auto -> prefers-color-scheme), applyTheme, the first-paint cache, and onThemeChange (a MutationObserver on data-theme). No React imports.
    useTheme.js              # v4.3.0+ — the React hook over onThemeChange, for components whose output is IMPERATIVE (mermaid SVG, the Excalidraw canvas) and so needs a value in a dependency array to redraw.
    sanitize.js              # DOMPurify wrappers (v3.11.7+): sanitizeHtml for marked output + release notes, sanitizeSvg for mermaid AND Excalidraw embeds. sanitizeSvg MUST keep ADD_TAGS:['foreignObject'] or every flowchart label renders blank. v4.2.0+ it also allows `use` — Excalidraw paints an embedded image as a <symbol> in <defs> painted by <use href="#…">, so without it the image sits in <defs> and silently never renders. `use` is ONLY safe paired with the afterSanitizeAttributes hook that drops any href/xlink:href not starting with '#' (an off-document <use href> is a classic SVG exfil vector — that pairing is why DOMPurify drops the tag by default). Never add one half without the other.
    __tests__/sanitize.test.js # Pins both directions — labels survive, payloads don't, same-document <use> survives, off-document <use> is dropped
    marpExport.js            # v4.2.0+ — standalone Marp deck export (render -> inline assets -> Blob download; never rendered in-app, so no sanitize call is needed on the output). The auth token is attached ONLY for same-origin asset URLs: deck content is user-authored and shared, so `![](https://evil/x.png)` would otherwise send the exporter's JWT to that host. Cross-origin images are still fetched, just without credentials.
    __tests__/marpExport-token.test.js # Pins that the JWT never goes cross-origin (absolute, protocol-relative, xlink) and still goes same-origin
    marpBespoke.js           # Wraps exported slides in marp-cli's vendored bespoke player (src/vendor/marp-bespoke, MIT) — no npm dep, nothing added to the backend image
    excalidraw.js            # v4.2.0+ — pure module: isExcalidrawDoc / parseExcalidraw / serializeExcalidraw / noteRelativePath. The .excalidraw.md format is Obsidian-compatible (scene JSON + a mirrored `## Text Elements` section so drawing text stays searchable)
    relations.js             # v4.2.0+ — pure module: task depends-on / blocked-by / related-to resolution by stable ref
    cardKey.js               # v4.2.0+ — board card identity. v4.5.2+: a loaded task carries a `uid` (withStableIds matches note + raw line + occurrence across refreshes) and cardKey prefers it over the old namespace+path+LINE key. The line is not stable: a move writes a `status:` line and shifts every task below it, and a refresh that re-keyed those cards bound an in-flight drag to whichever card now held its old key, so the drop moved the wrong task. Also relocateTask — find a task again after its line shifted, used to retry a move the server refused as stale (409) instead of a full reload.
    chat.js                  # Pure helpers for the chats view: slugify/chatPathFor (shell-safe new-chat paths), colorForAuthor (theme TOKENS, never literals), isOwnMessage (an agent posting on MY token as `claude-a` arrives `via` me and must NOT render as mine), groupMessages, mergeMessages (dedupe a poll and a send that both delivered #N), plainPreview, agentInstructions (pasteable — no angle brackets).
    approvals.js             # v4.8.5+: pure helpers for agent approvals: the approval:<id> chat marker, the "(N) mdnest" tab title, which requests are new since the last poll.
    useApprovals.js          # v4.8.5+: polls GET /api/approvals on every view while the server has approvals on; browser notification per new request once permission is granted.
    adminDirectory.js        # v4.8.3+ — pure module behind the admin panel's People and Namespaces tabs: joins users, direct grants, groups (members + grants) and namespace admins into one view per person ("Can reach", with the reason for each line) and per namespace. Access is kept in four places on the server; the old panel showed each in its own tab, so "what can alex reach?" took three tabs. OIDC-group membership lives in the login token and is deliberately not counted.
    components/AdminGit.jsx  # v4.8.4+ — git backup inside the admin Namespaces tab: a "Git backup" section per namespace card, "+ Add namespace" (a namespace and its repository in one step), and "Git connections" (the API's workspace groups: one host + token, repo <base>/<ns>.git). Replaced the separate Git Workspaces tab, whose "groups" shared a name with access Groups. Shown only when GET /api/workspaces/status says mirroring: on the plain-files backend (every setup.sh install) per-namespace remotes are never read and a runtime-created namespace lands in the container layer that `rebuild` discards, so the server refuses those creates (409, WorkspaceHandler.MirroringSupported) and the panel points at mdnest.conf + git-sync instead.
    hashRoute.js             # v4.5.2+ — pure module: the URL hash shapes (parseRoute / formatRoute). `#ns/path`, `#!board/ns[/path]` (the task board — it keeps the namespace AND the note underneath, because its back button and "This note" scope need them after a reload; before this it had no route and a refresh always dropped you into the editor), `#!stickies`. Markers start with `!` so no namespace name can shadow them. App.jsx skips writing the hash while a navigation that came FROM the address bar is still loading its note (`hashNavPending`), or a pasted board link is rewritten to the half-loaded state before the note arrives.
    listPage.js              # v4.5.2+ — pure module: the task board's List view paints LIST_PAGE (200) tasks at a time, like the Kanban columns' 100. It had no cap: a 6,327-task workspace froze the app ~10s on the List click while Kanban stayed instant. Filters still run over every task; the "Show more" button names how many are hidden.
    boardLanes.js            # v4.5.2+ — pure module: which column a board drag is aimed at (laneAt — the pointer's vertical lane, from the column's top down) and the edge auto-scroll step. dnd-kit's own auto-scroll is OFF on the board: in 6.3.1 it measured the edge zone against the SOURCE column's box while scrolling the board, so leaving the starting column slid the board sideways and the card landed one column over. The drop target is also re-resolved on release from the live pointer and live column boxes, because dnd-kit folds scroll into its coordinates and only re-evaluates `over` on pointer moves. `tests/browser/board-drag.spec.js` pins the gestures that used to fail.
    lazyWithRetry.js         # v4.2.1+ — pure module: retries a failed dynamic import and, on the LAST attempt, re-imports with a `?mdnest_retry=` query. The proxy's cache key is the request URI, so a different URI misses an entry that cached an error for an immutable asset URL. Used by every React.lazy() call in App.jsx.
    __tests__/pasteable-commands.test.js # v4.3.3+ — every shell command the UI hands the user with a Copy button must survive a paste. Checks a shell block IN FULL (the button copies the whole thing, and one offender began `echo … | mdnest append <ns>/…`, which a "line starts with mdnest" rule misses) and excludes JSON config blocks (the MCP tab's config is pasted into a FILE, where `<your token>` is fine).
    __tests__/lazyWithRetry.test.js # Pins the retry policy: plain retry for a blip, cache-bust on the final attempt, and the no-URL fallback for engines whose error message omits it
    img-src.js               # v4.4.0+ — pure module: resolveImgSrc turns a markdown image href into the <img src> Preview renders. A relative path resolves under /api/files/ and carries the JWT as ?token= (an <img> GET cannot set an Authorization header); absolute/rooted hrefs pass through untouched so the token never reaches a foreign host. The "already absolute" test is SHARED with the Live editor's proxyDomURL by design — /^(https?:|data:|blob:|\/)/i — because both renderers show the same note, and the prefix form it replaced called any filename starting with "http" absolute, so an uploaded http-flow.png rendered broken in Preview and fine in Live.
    __tests__/img-src.test.js # Pins both directions (our /api/files URLs get the token, foreign ones never do) AND the parity cases that fail against the prefix form
    transfer.js              # Pure module for issue #114: the cross-server clipboard payload ({mdnest:"file/v1",name,content}, 1 MB measured in UTF-8 BYTES via TextEncoder, not string length), safeFileName (a pasted name never picks a folder), suggestCopyName, localLinks, describeRefusal (409/413/429 bodies in words), filenameFromDisposition.
    echo-gate.js             # v4.1.1+ — pure module (no React): suppresses the file-changed echo of a tab's own save. In-flight-save window + epoch token: broadcasts arriving before the PUT response resolves are deferred and re-checked once the save settles; reset() on note switch invalidates the window. Closes the self-conflict-banner race (issue #82).
    __tests__/echo-gate.test.js # Pins the echo-beats-response race, late echoes, note-switch epochs
    tree-refresh.js          # v4.1.3+ — pure module: when the sidebar tree re-reads itself (TREE_POLL_MS + shouldPollTree). The live-collab websocket is deliberately NOT an input — `tree-changed` only fires for API writes, so gating the poll on it left git-sync/filesystem writes invisible until a manual Refresh.
    __tests__/tree-refresh.test.js # Pins that collab state is ignored and the cadence stays sub-minute
    mermaid-text.js          # v4.1.3+ — pure module: extractDiagramText (labels live in BOTH svg <text> and <foreignObject>, depending on diagram type) + copyPlainText (hidden-textarea/execCommand, since mdnest is often reached over plain HTTP where navigator.clipboard is unavailable)
    __tests__/mermaid-text.test.js # Pins extraction per diagram shape, dedupe, whitespace collapse
    mermaid-config.js         # Shared mermaid init, theme, and fixMermaidTextColors(). v4.3.1+ the contrast pass is split into two pure, tested helpers: chooseShapeFill (which shape actually paints a node) and brightnessOver (composite a colour over the diagram ground before judging it). Both exist because the old inline logic measured the wrong thing — see the convention below.
    firebase-config.js       # Firebase SDK lazy init (USER_PROVIDER=firebase only)
    components/
      Login.jsx              # Auth form (USER_PROVIDER=local)
      LoginFirebase.jsx      # "Sign in with Google" button (USER_PROVIDER=firebase)
      LoginSSO.jsx           # Corporate SSO sign-in button (USER_PROVIDER=sso)
      Sidebar.jsx            # Namespace picker, tree area, expand/collapse
      TreeNode.jsx           # Recursive tree node (drag-drop, context menu, long-press)
      Toolbar.jsx            # Top bar: hamburger, +Note, +Folder, path display
      Editor.jsx             # Basic mode: textarea with tab/paste/drop support
      EditorToolbar.jsx      # Markdown formatting buttons (basic mode)
      LiveEditorCrepe.jsx    # Live mode: @milkdown/crepe-based rich editor (v3.10.0+)
      live-editor-plugins.jsx# Shared Milkdown plugins (comments, table-cell checkboxes, clearEmptyBlock) + LiveToolbar component
      MermaidBlock.jsx       # Inline mermaid with Source/Preview toggle + click-to-edit labels
      Preview.jsx            # Rendered markdown (marked + mermaid)
      ContextMenu.jsx        # Right-click / long-press floating menu
      ChatView.jsx           # The chats view (on by default; React.lazy'd behind ChunkErrorBoundary): channel list + conversation, routed as `#!chats[/ns/path]`. Polls (CHAT_POLL_MS) instead of relying on live-collab, which is off by default and multi-only. ChatView.css is in theme-tokens.test.js's TOKENISED list. App.jsx keeps board and chats mutually exclusive via setBoardActive/setChatsActive. Members and Connect an agent are popups (ChatDialog) owned by ChatView, not ChatRoom, so the list's right-click menu can open them for a chat that is not open; ChatAgentPanel loads that chat's saved roles itself.
      ApprovalCard.jsx       # v4.8.5+: one approval request, loaded from the owner-only API (machine, agent, the exact command as React TEXT, the agent's description labelled as the agent's, Allow / Deny / Deny with a reason). Used in a chat message with an approval marker and in ApprovalsPanel. Styles in App.css, not ChatView.css, because the panel lives outside the chat chunk.
      ApprovalsPanel.jsx     # v4.8.5+: the approvals list, opened from the "N waiting" badge in the sidebar footer.
      StickiesLoadError.jsx  # v4.5.0+ — shown INSTEAD OF the cards when the board could not be read. Instead of, not alongside: the board is saved by PUTting it whole, so any card rendered here would be editable and one keystroke would replace a real server-side board with whatever the failed load produced.
      StickiesPanel.jsx      # v4.5.0+ — the sticky board drawer. Shares the right-edge geometry AND the stored width with CommentSidebar; App.jsx keeps exactly one of the two open. The save state is shown in the header rather than hidden behind a silent autosave — this is the one surface whose content exists nowhere else (no namespace, no git remote), so a failed save must be visible.
      StickiesBoard.jsx      # v4.5.0+ — the same cards full screen, free-positioned and draggable. It owns a URL route (`#!stickies`, marked with a leading `!` because a namespace called `stickies` would otherwise be unreachable) since it replaces the whole view; the drawer deliberately has none, because it overlays a note and the note is what the URL should describe — it is remembered in `localStorage` instead (`mdnest_stickies_open`), so a refresh keeps it without a shared link forcing it open on someone else. The drawer sits at `top: 0`, NOT the `.comment-sidebar`'s 61px offset: `.main` already carries a margin-right the width of the panel, so the toolbar is squeezed clear of it and the offset only left a band of bare page background in the top-right corner. App.jsx holds ONE `stickiesView` ('closed' | 'panel' | 'board'), not two booleans, so "both open" is unrepresentable. Opening the board never writes to the server: unplaced cards are laid out at render time and only gain a stored x/y when dragged. Drag needs a movement THRESHOLD — without it the jitter inside an ordinary click writes a position and marks the board unsaved (and note a Playwright `.click()` moves zero pixels, so a test using it passes with or without the guard; the spec models a real 2px click instead). Below the mobile breakpoint the canvas stops being a canvas and dragging is off. Cards are resizable in WIDTH only (`w`, nullable like x/y): height follows the content, so a stored height would clip a card the moment another to-do was added — and `boardExtent` must read each card's own width, or a widened card at the right edge falls outside the scrollable area with its right half unreachable.
      StickyCard.jsx         # v4.5.0+ — one card (title + free text + checklist), shared by both views, so a change to the card cannot land in one and be forgotten in the other. The card is dragged from ANYWHERE on it, with every text field and control opting out in `onPointerDown` — the CSS cursor rules must mirror that opt-out exactly, or the card claims to be draggable where it is not. A checklist line is a TEXTAREA, not an input — an input cannot wrap, so any to-do longer than the card was stored in full but only readable up to the card's edge (and the flex row holding it needs `min-width: 0` or it refuses to narrow and clips anyway). That change silently broke Enter-adds-a-row: the post-render focus lookup still searched for `input[type=text]`, found nothing, threw nothing, and left the caret on the previous line — a querySelector that matches nothing is the quietest kind of regression, so the focus target is pinned by a browser spec. "Done" is per CHECKLIST ITEM, not per card — a card-level flag forces "buy milk, call bank, post form" to be three notes or one you can only tick when all of it is finished; `isCardDone` therefore returns false for an empty checklist, because `every()` is vacuously true and would strike through every plain note. The drag handle is the top bar, not the whole card (dragging from anywhere means clicking into the text starts a drag instead of placing the cursor) — and every control INSIDE that bar must bail out of the drag before `setPointerCapture`, which redirects the following pointerup to the bar so the browser fires `click` there instead of on the button. Without that opt-out the colour and delete buttons work in the drawer and silently do nothing on the board.
      CommentSidebar.jsx     # Inline comments: slide-out panel, threads, replies, Go To
      HistoryModal.jsx       # Per-file git-sync history viewer + restore (v3.7.0+)
      TaskBoard.jsx          # Kanban board over note checkboxes (v4.0.0+); lazy-loaded. v4.2.0+ adds the filter bar and the "All workspaces" scope. v4.2.2+: reached from a single toolbar button that swaps to name its destination — `.toolbar-view-board` ("Board") on a note, `.toolbar-view-editor` ("Editor") on the board; the class follows the destination, not the state. The Basic/Live group is hidden while the board is open (nothing to act on), as is the "No file selected" placeholder. The board has lived inside the Basic/Live control (all three read as one choice) and in the sidebar (it read as the first row of the file tree, next to the root row) — don't move it back to either. Columns paint 100 cards at a time; server-side task scans are cached (backend/handlers/tasks_cache.go).
      TaskCard.jsx           # v4.2.0+ — one card (title on its own full-width line, badges, relations, steps)
      BoardColumn.jsx        # v4.2.0+ — one kanban column + drop target
      TaskEditor.jsx         # Rich task create/edit form used by the board
      BoardColumnsEditor.jsx # Per-namespace column layout (.mdnest/board.json)
      ExcalidrawEditor.jsx   # v4.2.0+ — the drawing canvas for a .excalidraw.md note. React.lazy()'d, and Preview.jsx dynamic-imports the engine only when an embed is present, so the entry bundle grows ~1.8 KB gzipped rather than ~1.5 MB
      AttributionModal.jsx   # v4.2.0+ — created / last-edited / contributors, from the note context menu (multi mode only)
      MoveToModal.jsx        # Destination picker for "Move to…" AND "Copy to…" (v3.8.0+; namespaces + name + dry run since issue #114). Offers the current namespace plus those writable at root (/api/namespaces?detail=1), dry-runs every choice and enables Confirm only on a 200 — it never infers permission. Stale dry-run answers are dropped by a sequence number.
      PasteModal.jsx         # "Paste here": a new note from the clipboard text (transfer.parsePastedNote: plain text named after its first heading, or the JSON payload versions before 4.8.4 copied, which carries the file name). "Copy file contents" copies the note as plain text minus its ID marker. Driven ONLY by a real paste event (never navigator.clipboard.readText(), which plain-HTTP installs lack); creates through POST /api/note so the target server's 409 and permissions apply; a "(copy)" name is offered on collision, never applied silently.
      ChunkErrorBoundary.jsx # v4.2.1+ — visible fallback for a lazily-imported surface whose chunk fails to download (drawings, task board, slides). <Suspense> handles a *pending* import, never a *rejected* one, so without this the error reached React's root and unmounted the entire app: blank page, no sidebar, no way to open another note.
      EditorErrorBoundary.jsx # React error boundary around Live editor — catches Milkdown crashes and flips to Basic (v3.8.0+)

mcp-server/
  index.js                   # MCP server entry — tools + resources wrapping REST API. v4.4.0+: `edit_note` is the exact-string editor — splices with indexOf/slice + join rather than String.replace (which would expand $&/$1 inside new_string and corrupt a pasted shell snippet), and sends If-Match with the ETag from its own read so a concurrent save 409s instead of being clobbered. It is the only tool that uses the ETag; `write_note` still overwrites, which is why partial edits should go through `edit_note`.
  test_transfer.mjs          # move_item with targetNamespace / copy_item go to /api/transfer with the right body; same-namespace move_item keeps /api/move; a 409 is a tool error naming the path.
  test_edit.mjs              # 14 assertions against a fake backend that serves an ETag and enforces If-Match: unique/missing/ambiguous match, replace_all, literal $ handling, the concurrent-save conflict. Registered in `npm test`.
  package.json

deploy/
  compose/docker-compose.yml # v4.5.3+ — the PLAIN install (issue #112): published ghcr images, no clone, no setup.sh, every option a comment. Copied by people who never run anything else in this repo, so `tests/compose-example.sh` pins it (every knob is one the backend reads, nginx's `backend` proxy target is a service, same tag on both images, not gitignored — the root `.gitignore` rule is anchored to `/docker-compose.yml` for exactly this — and release.yml publishes arm64, or `compose up` fails on every ARM host).
  helm/mdnest/               # Optional Helm chart (v3.11.7+) — inert unless used; Compose path unchanged
    Chart.yaml               # appVersion tracks the release — the FOURTH version-bump file
    values.yaml              # Every knob; three options are gated off (see _helpers.tpl)
    templates/_helpers.tpl   # mdnest.validateSupported (rejects unimplemented options) + mdnest.validateHA
    templates/               # backend/frontend/gitsync/mcp Deployments, Services, PVCs, Ingress, HPA, PDB
    files/sync.sh            # git-sync loop for the chart's sidecar (chart-local; Compose has its own)
    README.md(.gotmpl)       # helm-docs generated reference — edit the .gotmpl, patch both

.github/workflows/
  security-audit.yml         # npm audit + govulncheck + shellcheck. REQUIRED checks on main; also runs on PRs into develop
  ci.yml                     # (v3.11.7+) go build/vet/test -race, frontend build+test, helm lint/render/kubeconform, image builds
  release.yml                # (v3.11.7+) on v* tags: push images + chart to ghcr.io/<owner>/

mdnest                       # Client CLI (login, note read/write/append/edit, works from any machine). v4.4.0+ `edit` is the guarded read-modify-write — see the CLI conventions below for why the splice is pure bash and why the capture needs a sentinel.
mdnest-server                # Server management CLI (start, stop, rebuild, reset-password, runs from project dir). `MDNEST_SERVER_LIB=1 source ./mdnest-server` loads its functions without dispatching, mirroring the client CLI's MDNEST_LIB hook (v4.1.3+)
setup.sh                     # Reads mdnest.conf, generates docker-compose.yml + .env
mdnest.conf.sample           # Template config with MOUNT_ entries
```

## Key Conventions

### Backend (Go)
- Standard library only, no web framework — just net/http with ServeMux
- External dependencies: golang-jwt/jwt/v5, **jackc/pgx/v5** (Postgres driver), golang.org/x/crypto (bcrypt)
- **The Postgres driver is pgx, not lib/pq** (v4.2.1+). lib/pq is in maintenance mode and carries seven advisories that will never be fixed (GO-2026-6166/6168/6170–6173, all `Fixed in: N/A`), and `Backend (govulncheck)` is a required check on `main` with no bypass actors — so it blocked *every* release, not just the one that hit it. Three things follow: open the pool with `sql.Open("pgx", dsn)` (the keyword/value DSN is unchanged); test for a unique violation with `pgconn.PgError` + SQLSTATE `23505`, never `pq.Error`; and pass a Go slice **directly** for an array parameter (`= ANY($n)`) — pgx maps it to a Postgres array natively, so there is no `pq.Array` equivalent to reach for.
- Two auth modes: `AUTH_MODE=single` (file-based, no DB) or `AUTH_MODE=multi` (Postgres)
- Three identity providers (multi-mode only): `USER_PROVIDER=local` (default, username/password), `USER_PROVIDER=firebase` (Firebase Auth + Firestore TOTP), `USER_PROVIDER=sso` (generic OIDC). Exclusive; chosen at startup. In `sso` mode 2FA is skipped entirely (IdP owns MFA) and local password endpoints are unused. See `docs/sso-setup.md` and `docs/firebase-setup.md`.
- **Three role values** (v3.5.0+): `superadmin` (global), `admin` (namespace-scoped via the `namespace_admins` table), `collaborator` (per-grant only). Pre-v3.5.0 `admin` is migrated to `superadmin` by migration 007. `ADMIN_EMAILS` auto-promotes to `superadmin`. Permission checks go through `middleware.PermissionChecker.hasAdminScope(uc, ns)` — admin only for `namespace_admins` rows; everyone else falls through to grants. **A superadmin has NO implicit access to note content** (v3.12.0, PR #53): it manages every namespace (users, grants, admins) but reads and writes notes only through grants, like anyone else, and can self-grant (the empty page's "Give me access to all namespaces" button does that). Admin-only content actions (deleting someone else's chat) check `uc.Role == "superadmin"` separately, on top of the grant the route already required. API tokens follow the same precedence chain (no admin bypass for tokens).
- **Access Groups are a second grant source, unioned in** (v4.2.0+): effective access = own grants ∪ every group's grants. Consulted only after direct grants fail, and a nil `groupStore` disables the layer (single mode / no DB). The two member kinds have *different revocation latency* and that asymmetry is deliberate but must stay documented: a `user_id` member resolves live per request, while an `oidc_group` member is matched against the `groups` claim snapshotted into the JWT at login. That is why SSO sessions use `ssoJWTTTL` (12h) instead of the year-long remember-me TTL — it bounds how long a stale IdP snapshot outlives a change. Note `uc.Role` is read from the token too, so role changes are equally deferred; that is pre-existing, not new.
- **An access filter passed as a function must be required, not optional.** `/api/tasks/all` is access-controlled *solely* by its namespace filter and deliberately skips `RequireNsAccess` (it isn't scoped to one namespace). The filter is a mandatory `NewTaskHandler` argument, and `HandleGlobalTasks` treats nil as deny-all — so forgetting to wire it is a compile error, and if one ever slips through the endpoint serves nothing instead of every namespace. When a test pins a guard, mutate the *call site* too: a nil-means-permissive default is invisible to a predicate test.
- **SSO identity rules live in one pure function, `checkIdentity`** (`backend/sso/client.go`, v4.5.4+), so they are unit-tested without an IdP. Any IdP-specific rule must be keyed on the issuer and leave every other IdP untouched — mdnest is generic OIDC, and Clerk, Okta, Entra, Keycloak and Auth0 all go through the same path. The Google `hd` rule is the example: it requires `hd` to be *present*, not *listed*, because `hd` is the org's primary domain (a secondary-domain user carries the primary), and it exempts `gmail.com`, whose accounts never have `hd`. The first draft required membership and would have locked out both. `email_verified` decodes as `flexBool` because some IdPs send the string `"true"`, and a strict `bool` failed the whole claim decode.
- In single mode, the store/ package is not initialized — zero DB dependency
- All handlers take `notesDir` (absolute path) in constructor
- All file APIs require `ns` query param (namespace = top-level dir under NOTES_DIR)
- Path safety: `SafePath()` in `path.go` prevents traversal — always use it
- `RequireNamespace()` validates and resolves namespace to directory — use for all ns-scoped endpoints
- Handler pattern: struct with notesDir field, constructor `NewXHandler()`, method handlers
- Method dispatch: single route per resource, switch on r.Method inside Handle()
- Response format: JSON for structured data, raw text/markdown for note content
- Errors: JSON `{"error":"message"}` with appropriate HTTP status

### Frontend (React)
- Functional components with hooks, no class components
- State management: useState/useCallback in App.jsx, passed as props
- No state library (Redux etc.) — props and callbacks only
- CSS: single App.css + index.css, no CSS modules, no styled-components
- Theme: Catppuccin Mocha (bg #1e1e2e, sidebar #181825, accent #89b4fa, text #cdd6f4)
- Mobile: responsive at 768px breakpoint, sidebar becomes slide-over overlay
- URL state: hash-based routing (#namespace/path/to/note.md)
- API calls: all go through api.js which handles JWT and 401 redirects
- marked v15: use plain renderer object (NOT `new marked.Renderer()`), method signature is `({ text, lang })` for code blocks. **Register the renderer via `new Marked().use({renderer: {...}})`, NOT via the per-call `marked(src, {renderer})` option** — the per-call form replaces the default renderer entirely (no fallback), so any token type you don't override crashes with `this.renderer.X is not a function`. Also: never call `this.parser.parseInline(token.tokens)` from a custom `listitem`; task items with nested blocks will blow up with `Token with "list" type was not found`. Rely on marked's built-in GFM task rendering and re-wire the checkboxes in the DOM post-pass.
- Mermaid: rendered post-DOM-insert by querying `.mermaid-source` divs
- Two editor modes: Basic (textarea, Editor.jsx) and Live (Crepe, LiveEditorCrepe.jsx)
- Live editor: lazy-loaded via React.lazy(), only downloads when user switches to Live mode. The chunk is ~1.1 MB (~340 KB gzipped) — Crepe + Vue runtime + CodeMirror + KaTeX.
- Crepe (v3.10.0+): `@milkdown/crepe` is the same editor Milkdown's playground uses. Provides block-edit (drag handle + slash menu), native task-list checkboxes, KaTeX math, polished tables, image-block upload UI, link tooltip. Built on `@milkdown/kit/preset/{commonmark,gfm}` under the hood — same schema as pre-v3.10's hand-rolled Milkdown stack.
- Custom plugins (in `live-editor-plugins.jsx`): `commentHighlightPlugin` (yellow highlight on commented text, anchor disambiguation via `rangeStart`), `clearEmptyBlockPlugin` (backspace empty heading → paragraph), `tableCellCheckboxPlugin` (literal `[ ]`/`[x]` in cells render as interactive checkboxes via decorations; markdown bytes unchanged on serialize), `wikilinkDecorationPlugin` (v3.11.5+ — `[[wikilink]]` spans get a link-coloured highlight + `data-wikilink`; decoration-only so bytes stay literal `[[...]]`, Ctrl/Cmd+Click navigation wired in `LiveEditorCrepe.jsx`), `LiveToolbar` (Undo / Redo / format / insert / table commands).
- **A queued autosave is flushed on navigation, never cancelled** (v4.2.1+). `openNote` / `openNoteDirect` / `handleSelectNs` used to `clearTimeout` the previous file's pending save, which silently discarded every edit made inside the debounce window. They now `await flushPendingSave()`, and the order is load-bearing: it must run **before** `getNote()`, because `etagRef` is shared, so a save that ran afterwards would send the *new* file's etag with the *old* file's content. An editor that debounces internally registers its pending state through `registerFlush` so it can be drained at the same point — the drawing canvas does this. Do **not** flush from an unmount cleanup: by then the app has moved on and the content would be applied to the next note.
- **`<Suspense>` is not error handling** (v4.2.1+). It covers a *pending* dynamic import; a *rejected* one throws to React's root and unmounts the whole app — blank page, no sidebar, no way out. Every `React.lazy()` surface must sit inside `ChunkErrorBoundary` (or `EditorErrorBoundary`, which flips Live to Basic), and its factory must go through `loadWithRetry`. `/assets/` also 404s on a miss rather than falling back to `index.html`, so a stale tab gets a clean failure instead of HTML parsed as a module.
- **A flex item that must scroll needs `min-width: 0`** (v4.2.1+). The task board's columns were unreachable with no scrollbar: `.tb-panel` is a flex item of `.split-view` (a flex row with `overflow: hidden`) and defaulted to `min-width: auto`, so it refused to shrink below the intrinsic width of N fixed columns, grew past the viewport, and was clipped. `overflow-x: auto` on the inner element can never fire while its parent is sized by its own content.
- **A command the UI tells you to RUN must be pasteable** (v4.3.3+). `<your-token>` is a shell **redirection**, so `mdnest login https://x <your-token>` fails with `no such file or directory: your-token` the moment it is pasted — and every `CodeBlock` in Settings has a Copy button that reproduces the text verbatim, so the instruction meant to unblock someone is the next thing that breaks. Use literal stand-ins (`mdnest_yourtoken`, `notes`, `@myserver`). Bracket notation stays fine in prose, in `Usage:` synopses, and in JSON config blocks, which are pasted into a *file*. This is the same rule the CLI adopted in v4.1.3; the lesson worth keeping is that the convention was written down and tested for **CLI output only**, so the surface that needed it most sat outside the test's reach for two years. `__tests__/pasteable-commands.test.js` closes it — and was itself verified against the pre-fix file, both that it flags all nine and that it does not flag the JSON block.
- **Colour goes through a token, never a literal** (v4.3.0+, `theme.css`). App.css / index.css / TaskBoard.css contain no hex; a literal is a colour that silently will not switch theme, and it fails invisibly for whoever is not on the theme the author was using. The layering is load-bearing rather than tidy: a *semantic* token (`--border`, `--surface-2`) may point at a different primitive per theme, which is the only reason light mode works. In Mocha a border and a raised panel can share a value because both read as "lighter than the page"; in Latte a border must be *darker* than what it encloses. `#313244` was a background 78 times and a border 102 times, so mapping by value would have flattened every light-mode border. The sharper case: `#1e1e2e` was also a *text* colour 33 times (a label on a filled accent button) — by value the page background, by role `--text-inverse`, which stays light when the page turns light. `__tests__/theme-tokens.test.js` pins that no literal creeps back, that every bare `var()` resolves, and that nothing reaches past the semantic layer to a `--ctp-*` primitive. Adding a colour means adding the semantic token to BOTH blocks in `theme.css`.
- **A new light-mode colour must be measured, not chosen** (v4.3.0+). `__tests__/theme-contrast.test.js` resolves every var() chain and asserts WCAG AA. Catppuccin Latte is a good palette that tunes its accents to sit on white *as accents* — icons, fills, large type — while mdnest uses them as body text, so stock Latte yellow measures 2.31:1 and green 2.96:1 against a 4.5:1 floor. Five hues are deliberately darker than upstream for that reason; don't "fix" them back. Dark mode's `--text-muted` is under AA and always has been (3.36:1) — that is pinned at its current level rather than asserted at AA, so it cannot silently get worse, and raising it is a deliberate design decision about 71 call sites, not a side effect.
- **A surface that draws imperatively will not re-theme on its own** (v4.3.0+). mermaid SVG and the Excalidraw canvas are written into the DOM outside React's control, so a theme change redraws nothing unless the theme is in the effect's dependency array — that is what `useTheme()` is for. mermaid additionally needs `applyMermaidTheme()` called at the top of the render effect, because its config is global and applies at *render* time; relying on a subscription elsewhere having fired first makes correctness depend on observer registration order.
- **Sanitization (v3.11.7+, `sanitize.js`): every path that puts rendered markup into the DOM goes through it.** `innerHTML` / `dangerouslySetInnerHTML` with `marked()` output, GitHub release notes, or mermaid SVG must call `sanitizeHtml` / `sanitizeSvg` — note bodies are user-authored and shared between users, and marked passes raw HTML through by design. If you add a new render target, route it through the same module rather than sanitizing inline. Two traps, both load-bearing: `sanitizeSvg` needs `ADD_TAGS: ['foreignObject']` because mermaid puts flowchart labels inside one and DOMPurify's svg profile excludes it (without it, diagrams render as blank shapes — nothing throws); and do **not** additionally allow `div`/`span`, because once allowed they fail DOMPurify's namespace check instead of being unwrapped and the labels vanish again. `sanitizeHtml` deliberately keeps `class`, `data-*`, and task checkboxes — the Preview's post-passes depend on them.
- Wikilinks (v3.11.5+, `wikilink.js`): resolution runs against the current namespace tree only (built via `buildPathIndex(tree)` and memoized in `App.jsx`, shared by `Preview.jsx` and the Live editor). Round-trip fidelity is the hard requirement — the Live editor stores literal `[[...]]`, but Milkdown's serializer escapes `[[`→`\[\[` in plain text, so `markdownUpdated` routes every serialized doc through `restoreWikilinks()` before `onChange`. Don't add a wikilink node to the schema — the decoration + serializer-unescape approach is deliberate so bytes never change.
- **A label's background is the shape that PAINTS it, not the first shape you find** (v4.3.1+, `mermaid-config.js`). `fixMermaidTextColors` picks each label's ink from the brightness behind it, and it got that wrong twice, in ways worth remembering because neither throws. (1) Mermaid nests an empty `<rect></rect>` spacer inside every flowchart node's `g.label`; it paints nothing but inherits the themed `mainBkg`, so the walk read `#313244` for a `#cfe4ff` node and inked it light-on-light. Candidates are now measured with `getBBox()` and zero-area shapes are skipped. (2) An **edge** label has no shape at all — mermaid paints it with a CSS `background-color` on the HTML inside the `foreignObject` — so an HTML label's own background now wins over any shape behind it. Brightness is composited over the diagram ground (`PALETTES[theme].background`) because that chip is half-transparent; the previous canvas parse returned `NaN` for any `rgba()` and only reached the right ink by accident. An unresolvable fill falls back to the theme's ordinary ink, never the light one — white on a pale canvas is the same invisibility.
- **`--text-inverse` is the ink for the ACCENT, not for anything coloured** (v4.3.1+). It resolves to `#1e1e2e` in dark and `#ffffff` in light, which is right on a filled accent button and wrong on anything that is bright in *both* themes. `--highlight` (the comment/search yellow) is exactly that, and inking it with `--text-inverse` put white on yellow at 1.32:1 in light mode. Marker text uses `--highlight-ink`. The palette assertions alone cannot catch a relapse — no ratio is wrong until you know which token the rule reached for — so `theme-contrast.test.js` also reads App.css and requires every rule filled with `--highlight` to set `--highlight-ink`.
- **The file toolbar wraps; it must never overflow** (v4.3.1+). It is one flex row whose groups are all `flex-shrink: 0`, so the only elastic item is `.toolbar-path` in the middle. When it was `flex: 1` with no `overflow` it grew to fill the row and then spilled its own children — the filename over the comment button, Rename over the settings icon — on any narrow editor (a 13" laptop, or any window with the comment panel open). It is `flex: 0 1 auto` with `margin-right: auto` now, the filename ellipsizes, and `.toolbar` sets `flex-wrap: wrap`. `tests/browser/toolbar-fit.spec.js` pins it at 1440 and 1024. Two things that test has to do and a naive one would not: skip nested pairs (Rename and Delete are *inside* `.toolbar-path`, and a parent enclosing its children is not a collision), and hit-test the intersection rather than trusting rectangles, because a control clipped by an `overflow: hidden` ancestor still reports its full box while painting nothing.
- Mermaid: `LiveEditorCrepe.jsx` defines an inline `mermaidNodeView` that renders the `MermaidBlock` React component for `code_block` nodes where `language === 'mermaid'`. The compose-mermaid plugin runs after `SchemaReady`, reads Crepe's existing `code_block` factory from `nodeViewCtx`, and writes a wrapper that delegates to it for non-mermaid blocks — so Crepe's CodeMirror UI still works for other code languages AND mermaid renders via our React component.
- Image upload: Crepe's `image-block` `onUpload` calls `uploadImage()` in `api.js`. `proxyDomURL` resolves the bare-filename markdown src (e.g. `![](photo.png)`) into `/api/files/<ns>/<dir>/<file>?token=<jwt>` for rendering — the `?token=` query param is the auth-fallback the middleware accepts for `<img>` GETs that can't carry an `Authorization` header.
- **The tree must refresh for writes that never touched the API** (v4.1.3+, `tree-refresh.js`). `tree-changed` is broadcast from the mutating-HTTP wrapper in `main.go`, so it fires *only* for changes that came through the API — git-sync pulling another machine's commits, a host-side editor, or a restored backup produce nothing. Do not gate the poll on `appConfig.liveCollab`: a connected websocket is not evidence the tree is current, and that gate meant installs running both collab and git-sync got no automatic update at all. Automatic refreshes pass `{ soft: true }` so they skip `treeLoading` — the sidebar draws an indicator bar whenever that's set, which is right for a user-initiated Refresh and pure noise on a timer.
- **The tree's drop target and create target are whatever the gesture implies** (v4.2.1+). Three rules that were each wrong once: an expanded folder's *contents area* is a drop target for that folder (otherwise a drop there bubbles to `.sidebar-tree`, which means "move to the namespace root" — so aiming inside a folder moved the file out of it); a **file** row must bail out of its drop handler *before* `preventDefault`/`stopPropagation`, so the event keeps bubbling to the containing folder instead of being swallowed; and the namespace root is a real row (`.tree-root-row`), because selecting a folder aims `+ Note`/`+ Drawing`/`+ Folder` at it and there would otherwise be no way back to the top level and no visible root drop target. The create destination is shown in each button's tooltip — it is invisible otherwise, which is what made "+ Note" landing somewhere unexpected feel arbitrary.
- Per-namespace last-file memory: `localStorage` key `mdnest_last_path:<ns>` records the path of whichever note was last opened in each namespace. Restored on namespace switch and on initial load when there's no URL hash. URL hashes still win for explicit navigation. Per-file scroll position lives in `mdnest_file_prefs:<ns>/<path>.scrollPct` (existing pre-v3.10 mechanism).
- Crepe nodeView composition: when overriding a node view that Crepe registers (e.g. `code_block` for mermaid, `table` for the click-to-cursor fix), the pattern is to wait for `SchemaReady`, read the existing entry from `nodeViewCtx`, then append a new entry with the same node-type id. `Object.fromEntries(nodeViewCtx)` keeps the last entry for duplicate keys, so ours wins; we keep a reference to the original factory and delegate to it for cases we don't want to override.
- Both editor implementations share the same onChange/content props — Crepe is now the only Live editor, but `App.jsx` keeps its lazy import named `LiveEditor` so the JSX call site stays editor-agnostic.

### Namespace Model
- Namespaces are NOT created at runtime — they are host directories mounted via Docker volumes
- Configured in `mdnest.conf` as `MOUNT_<name>=<host_path>`
- `setup.sh` generates docker-compose.yml volume mounts from these
- Backend sees them as subdirectories under NOTES_DIR
- GET /api/namespaces lists them (reads top-level dirs)
- **App-managed data that is NOT user notes needs its own declared volume.** `/data/notes` is not itself a volume — `setup.sh` bind-mounts each `MOUNT_` namespace *individually* — so anything the backend creates under `NOTES_DIR` at runtime lands in the container's writable layer and is destroyed by `./mdnest-server rebuild` (`compose up --force-recreate`). v4.2.0's Marp theme catalog hit exactly this in review: `.marp-themes` is a reserved system namespace created at runtime and deliberately never mirrored to a git remote, so a rebuild would have wiped every custom theme with no copy anywhere. The fix is the pattern `mdnest-secrets` already uses — `setup.sh` emits a **named volume** (`mdnest-marp-themes:/data/notes/.marp-themes`) when the feature is on, and `tests/setup-marp-themes.sh` pins that the generated compose both mounts *and declares* it. The Helm chart is unaffected: it mounts all of `/data/notes` as a PVC. If you add another system namespace, add its volume in the same change.

### Client CLI (`mdnest`, bash)
- Runs under `set -e` — a helper used as a bare statement must `return 0` on its success path or it aborts the script. (This also leaks into anything that *sources* the CLI: `tests/cli-unit.sh` does `set +e` right after the `MDNEST_LIB=1 source` for exactly this reason.)
- **Under `set -e`, a PLAIN assignment from a command substitution is a silent script-killer** (v4.3.2+). `x=$(cmd)` takes the substitution's exit status, so the script dies on that line and everything below it — *including the error handling written for exactly that failure* — never runs. This is not a hypothetical: it shipped in `api()` in v1.0 and survived 47 releases. `mdnest servers` printed the table header, exited with curl's `28`, and never reached the `unreachable (DNS|refused|timeout|TLS)` labels or the "works in your browser?" hint; because the server list is globbed alphabetically, one dead server also hid every healthy server sorting after it. Write `x=$(cmd) || x=""` — always — and do **not** follow it with `rc=$?`, which overwrites the real status with the now-successful assignment's `0` and reports `unreachable (curl 0)`. `run_errexit_lint` in `tests/cli-unit.sh` fails the build on a new unguarded site; it proves itself against a probe file, because a lint that cannot fail is worse than none. Two exemptions, both verified rather than assumed: `local x=$(...)` is safe (`local` is a builtin, so the status is the builtin's own — which is why the CLI is full of them), and a substitution ending `|| true)` is already guarded from the inside.
- **The same class also hides in a trailing `&&` list, and the lint cannot see it.** `[ -n "$x" ] && do_thing` as the *last statement of a function* makes a false test the function's return value, which `set -e` then treats as a failure. This was reintroduced *inside* the fix for it, and the behavioural test (`run_unreachable_suite`, "servers: unreachable server still exits 0") caught it, not the lint. Conditions inside an `if` are exempt from errexit; a trailing `&&` list is not. Prefer `if`.
- **The CLI is pull-only, so a fix does not reach anyone until they run `mdnest update`** (v4.3.2+). Nothing pushes, and the in-app banner tracks the *server*, not the CLI. Before v4.3.2 the only version check was a MAJOR mismatch at login, which is how a bug present since v1.0 stayed invisible to every client running it. `version_gt()` + `cli_update_notice()` now print one line — naming both versions and the exact command — in `mdnest servers`, `mdnest whoami`, and `mdnest login`. Deliberately **not** on every command (there is no update cache, and a per-read check would be its own bug), and deliberately compared against the **server's** version rather than GitHub's latest: no extra network call, no new failure mode, and CLI + server ship from the same repo at the same number. Known limitation, stated rather than hidden: a client whose server is *also* stale hears nothing. `version_gt` is pure bash — no python3, no jq, and no `sort -V` (busybox sort has none) — and is pre-release aware the same way `isVersionNewer` in `App.jsx` is, so a `-dev` build never nags about the release it is a candidate for.
- **A read-modify-write must carry the version it read.** `mdnest edit`
  (v4.4.0+) exists because the only way to change one line used to be `read` +
  rebuild + `write`, and a plain `PUT` overwrites whatever the web UI,
  git-sync, or another agent saved in between while printing
  `{"status":"ok"}`. The PUT sends `If-Match` with the ETag from its own read,
  so the backend answers 409 instead. Two things this needed and a naive
  version would miss: `api()` had to grow an optional response-header dump
  (`-D`) because the ETag is only in the headers — do **not** recompute it
  client-side from the content, that duplicates `canonicalForETag` in a second
  language and silently rots; and the splice is **pure bash parameter
  expansion**, not sed/awk, because a note is arbitrary markdown — a regex tool
  reads `.`/`*`/`[` in the needle and expands `&`/`\1` in the replacement,
  corrupting exactly the code fences people keep in notes. Quoting the pattern
  inside `${...}` forces literal matching and needs no python3/jq/awk tier at
  all.
- **`$( )` strips trailing newlines, so every capture of note content needs a
  sentinel.** `x=$(cmd)` silently deletes the note's final newline, which turns
  "leave the rest of the file alone" into a lie. `cmd_edit` captures as
  `$(... ; printf 'X')` and strips the `X`. This bit twice in one change — once
  on the read and again on the splice result — and the second one survived the
  first fix. Note the read uses `&&` before the `printf`, not `;`: with `;` the
  status is printf's `0` and a failed `api()` sails straight past its error
  handling.
- **Body content goes to curl as `--data-raw`, never `-d`.** `-d @foo` makes
  curl read a *file* called `foo`, so a note whose content merely STARTS with
  `@` (`@mention …`) could not be created, written, appended or prepended —
  it failed with curl's exit 26, surfaced as "couldn't reach the server".
  Shipped in v1.0, fixed in v4.4.0. `--data-raw` is `-d` without that case.
- **Every python3 call goes through `py()`** (v4.1.2+), never `python3` directly. It passes `-S` (skip site initialisation, so a user's broken site-packages/`.pth` can't print a traceback into our output — issue #87) and `-E` (ignore `PYTHON*` env), drops python's stderr, and returns its exit status. **Gate on the result, not on presence:** `have python3` passing does not mean python3 *works*, so every call site must fall through to its pure-bash/awk tier when `py` fails. A present-but-broken interpreter is the failure mode that bit us, not a missing one.
- Dependency tiers, in order: python3 (`py`) → jq → pure bash/awk. The awk tier is not a token gesture; it is the tier that runs on a fresh machine, and `tests/e2e-docker.sh` proves it in a bare alpine container with neither python3 nor jq.
- **Human-facing output is rendered in awk only** — `format_tree` / `format_namespaces` for `mdnest list` have deliberately no python3/jq tier, so a listing is byte-identical on every machine and a broken python can't garble it. Verified on gawk, mawk and busybox awk. Raw API JSON stays available behind `--json` / `MDNEST_JSON=1` for scripts; don't make raw JSON the default output of a command again.
- Adding a command means three edits: the `case` dispatch, the help **Commands** list, and the help **Examples** block (`grep -c '<cmd>' mdnest` ≥ 3).
- **A download never trusts the server with where it lands** (issue #114). `mdnest download` writes to a temp file in the target folder and renames it only after a non-error status, so a refusal (413/403) leaves nothing behind; it never overwrites an existing local file; and `disposition_filename` reduces the server-chosen name to a bare file name (no folder part, decoded `%2F` included, no leading dots). The move/copy request body is built with `json_str`, pure bash, so a quote or backslash in a path cannot break the JSON on the no-python3 tier.
- **The frontend image serves the repo-root CLI at `/cli/mdnest`** (v4.8.5+), with `frontend/public/cli/install.sh` beside it. The script is outside the `frontend/` build context, so it comes in as a named build context `cli` (repo root): `additional_contexts` in the compose file `setup.sh` writes (needs Compose 2.17+, which `setup.sh` checks and names), `build-contexts: cli=.` in `release.yml` and `ci.yml`, and `--build-context cli=.` for a hand `docker build`. Without it `COPY --from=cli` fails the build on purpose. Never commit a second copy of the script. `tests/setup-cli-context.sh --build` does a real compose build from the generated file; `tests/e2e-browser.sh` checks `/cli/mdnest` is byte-identical and runs the tab's Install command, then its Connect command on a pty. The installer only installs: installing and connecting are separate steps in the tab on purpose. nginx's `/cli/` location 404s on a miss, never the SPA's index.html.
- **`mdnest login <url>` with no token prompts on `/dev/tty`, never stdin** (v4.8.5+): under `curl ... | bash` stdin is the pipe. No terminal means exactly the old usage + exit 1, so scripts are unchanged. A pty test must wait for the terminal's ECHO flag to go off before typing the token (`tests/pty-drive.py`), or the kernel echoes it and the "not echoed" check is a race. `MDNEST_TTY` is the test hook for "no terminal".
- `mdnest update --server @alias` (v4.8.5+) fetches only that server's `/cli/mdnest`, never GitHub, since the point is to match the server.
- `mdnest update` self-updates from `raw.githubusercontent.com/.../main` — so a CLI fix reaches users when it lands on `main`, independent of the tag/Release (those drive the in-app *server* update banner). Corollary: the CLI installed on this machine lags `develop`, so test with `./mdnest`, not `mdnest`.
- **Never print `<angle brackets>` inside a command you tell the user to RUN** (v4.1.3+). `<name>` is a shell redirection, so a hint like `mdnest login @<name> ...` errors in zsh and bash the moment it's pasted — the recovery instruction became a second error. Use literal placeholder words (`@myserver`, `mdnest_yourtoken`) whenever real values are being substituted in. Bracket notation is still fine in `Usage:`/`--help` *synopses*, which nobody pastes. `tests/cli-unit.sh` asserts no suggested command contains a bracket.
- **Validate before you conclude, and before you persist.** Two failures of the same shape shipped together in `login`: reporting "this server has no SERVER_ALIAS configured" for a host we never reached (the curl exit code was thrown away, so "couldn't connect" and "connected, no alias" were one empty string), and saving a non-URL to disk — where it became the *default* server. Keep curl's exit status when the reason matters (`fetch_server_config` + `curl_reason`), and never write config you haven't validated.

### Docker
- Backend: golang:1.24-alpine build, alpine runtime
- Frontend: node:20-alpine build, nginx:alpine serve
- Nginx proxies /api/ to backend service
- SPA fallback: try_files -> /index.html
- git-sync: optional (auto-enabled when keys in git-sync/keys/), alpine/git with cron-style loop
- postgres: optional (auto-added by setup.sh when AUTH_MODE=multi), postgres:16-alpine with healthcheck

### MCP Server (Node.js)
- Uses @modelcontextprotocol/sdk with StdioServerTransport
- Config via env vars: MDNEST_URL, MDNEST_USER, MDNEST_PASSWORD
- Authenticates on startup, stores JWT, auto-refreshes on 401
- Tools: list_namespaces, list_tree, read_note, write_note, create_note, create_folder, delete_item, move_item, search_notes
- Resources: notes://{namespace}, notes://{namespace}/{path}
- search_notes reads tree, fetches each .md, case-insensitive match, max 20 results
- Uses native fetch (Node 18+), no extra HTTP deps

## Release Process

- **One PR per release.** Bundle all the work for a release into a single branch (`feat/<name>` or `release/v3.X.Y`) and open **one** PR against `main`. Don't open intermediate / sibling PRs for sub-features during the same release cycle — they cause merge conflicts on shared files (`CHANGELOG.md`, the three version files, `App.jsx`, docs) when one lands while another is still open. Hotfix exception: a true emergency (security CVE, prod crash) can ship as its own PR ahead of the release, but flag it before opening. v3.10.0 hit exactly this — PR #10 (v3.9.1) merged while PR #11 (v3.10.0) was open and produced six-file conflicts; resolve by merging `main` into the release branch and keeping the higher version + the deletion of any files the cutover removed.
- **Version scheme — `develop` carries `X.Y.Z-dev`, releases drop the suffix.** `develop` always holds the in-flight version with a `-dev` pre-release suffix (e.g. `3.11.3-dev`), so a develop/staging box reads `v3.11.3-dev` ("candidate, still validating") and production reads the plain `v3.11.3`. The **release branch sets the plain `X.Y.Z`** (drops `-dev`); after the release merges, bump `develop` to the *next* `X.Y.(Z+1)-dev`. `isVersionNewer` (App.jsx) is pre-release-aware so a `-dev` build shows no false "update available" against the last release but does see the final release as newer once it ships.
- Set the version in four files — on the release branch use the plain `X.Y.Z`; on `develop` use `X.Y.Z-dev`:
  - `backend/handlers/config.go` — `"version": "3.X.Y"`
  - `frontend/package.json` — `"version": "3.X.Y"`
  - `mdnest` CLI script — `MDNEST_CLI_VERSION="3.X.Y"`
  - `deploy/helm/mdnest/Chart.yaml` — `appVersion: "3.X.Y"` (v3.11.7+, the Helm chart's default image tag). Note `version:` in the same file is the **chart's own** SemVer and moves independently — bump it when the chart's templates change, not on every app release. The release workflow passes `--app-version` when packaging, so a *published* chart is stamped from the tag either way; this file only governs `helm install ./deploy/helm/mdnest` from a source checkout.
- Update `CHANGELOG.md` with the new version section
- Merge to `main`, tag as `v3.X.Y`, push with `--tags`
- **Publish a GitHub Release for the tag** — `gh release create vX.Y.Z --title "..." --notes-file <file>` with the CHANGELOG entry as the notes. Tags ≠ Releases on GitHub: `git push --tags` only creates the git ref, but the in-app "update available" banner polls `https://api.github.com/repos/<owner>/<repo>/releases/latest` which returns **404** when zero Releases have been published — so without this step, no running mdnest install will ever notice a new version. The frontend's banner (`appConfig.latestRelease.name` + `.notes` preview) is also designed around Release metadata, not bare tag names. The clean recipe:
  ```bash
  # after tag + push --tags
  awk '/^## v3.X.Y —/{found=1} found{print} /^## v[0-9]/ && NR>1 && !/^## v3.X.Y —/{exit}' CHANGELOG.md > /tmp/rel-notes.md
  gh release create vX.Y.Z --title "vX.Y.Z — <headline>" --notes-file /tmp/rel-notes.md
  ```
- Run `/md-ship` skill after code changes to update docs, website, and test instance. (mdnest skills use the `md-*` prefix: `md-fix-bugs` clears the Bugs backlog, `md-add-improvement` the Features backlog, `md-ship` does the post-change docs/website/release chores.)
- Pre-push hook (`.githooks/pre-push`) verifies builds, security, lock files, version consistency
- New developers run `./mdnest-server dev-setup` to activate hooks

### The merge-to-main security gate (required status checks)

**Nothing merges to `main` until the Security Audit passes — this is enforced server-side, not by trust.** The `Security Audit` workflow (`.github/workflows/security-audit.yml`) runs four jobs on every PR to `main` — `Frontend (npm audit)`, `MCP Server (npm audit)`, `Backend (govulncheck)`, `Shell scripts (shellcheck)` — and those four are **required status checks** on the `main-branch` repository ruleset. A red or pending check blocks the merge (`gh pr merge` refuses; the PR sits at `mergeStateStatus=BLOCKED`). The `main-branch` ruleset has **no bypass actors** (`current_user_can_bypass: never`), so the gate binds even the repo owner — the separate `mahsan_bypass` ruleset only exempts the *pull-request-required* rule on non-default branches (that's how `develop` takes direct pushes), it does **not** exempt `main`'s status checks.

- **Why it exists / the failure it prevents:** *running* a check is not *requiring* it. Before this gate, the audit ran but wasn't required, so a PR merged at `mergeStateStatus=UNSTABLE` with a failing check — that's how the `crypto/tls` stdlib vuln **GO-2026-5856** landed on `main` via the v3.11.5 release (CI caught it only on the *post-merge* push). Bumping Go `1.26.4 → 1.26.5` (go.mod `go` directive + `backend/Dockerfile` builder image) fixed the vuln.
- **Read the threshold the gate actually sets before "fixing" what an audit
  prints.** Both npm audit jobs run `--audit-level=high`, so a moderate
  advisory is below the gate on purpose (`security-audit.yml` says as much:
  "Bump severity here when those are cleaned up"). A bare local `npm audit`
  lists every severity, and reading that as the gate is how v4.4.0-dev grew an
  `overrides` entry for a MODERATE advisory that was never blocking anything —
  and the override then made the tree invalid to npm's legacy quick-audit
  endpoint (`400 … Invalid package tree`), which refuses the whole audit. One
  moderate advisory traded for no audit signal at all. Local runs passed
  because local npm reached the working bulk endpoint while CI fell back to
  the legacy one — **verifying in one environment verified one environment**,
  which is the durable half of this lesson: CI pins Node 20 (npm 10.x) and a
  dev box on Node 24 (npm 11.x) is a different audit client, so test a
  dependency change in `node:20` before believing it.

  **Updated in v4.5.1: that `@xmldom/xmldom` override is now in place and
  required.** The advisory was re-rated **high**, which put it above the gate
  and blocked every merge to `main` — the exact condition the old note said to
  revisit on. `speech-rule-engine@4.1.4` still pins `0.9.10` exactly and
  `marp-core`/`mathjax-full` are both already at their latest, so an
  `overrides` entry forcing `^0.9.12` is the only route, and re-testing under
  `node:20`/npm 10.8.2 shows it no longer breaks the audit the way it did in
  v4.4.0-dev. Two things made it safe to take: `xmldom` and
  `speech-rule-engine` are **tree-shaken out of every shipped chunk** (grep
  `frontend/dist/assets/*.js` — zero hits), so nothing about the browser
  bundle changes; and Marp still renders, verified by rendering a real deck
  with front-matter, pagination and math through `marp-core` in Node rather
  than by trusting the unit tests, which cover our own `isMarpDoc` and not
  marpit's YAML parsing.
- **"Could not check" is not "found something", and the hook got this wrong.**
  `npm audit` exits non-zero for a real advisory AND for a failure to reach the
  advisories endpoint. The hook discarded stderr and reported every non-zero
  exit as `VULNERABILITIES FOUND`, so an npm outage (503s on
  `/-/npm/v1/security/advisories/bulk`) blocked pushes while naming the wrong
  cause — and `npm audit fix` exited 0 having applied nothing, which is how the
  same outage looks from the other side. `npm_audit_check` now separates them:
  an unreachable endpoint SKIPs with the reason printed (matching how the hook
  already treats a missing Go toolchain or shellcheck), a real finding still
  blocks. `tests/pre-push-audit.sh` drives the helper against fake `npm`s
  covering all seven outcomes, and the load-bearing one is "REAL vulnerability
  still exits non-zero" — a fix here that reclassified too much would silently
  disarm the check. Same rule as `curl_reason` in the CLI: keep the reason when
  the reason is what the reader has to act on.
- **The local pre-push hook is defense-in-depth, not the gate.** It runs `govulncheck` too, but **silently skips it when `go` isn't installed on the host** (e.g. this dev machine) and can be `--no-verify`'d — and it doesn't run at all on a GitHub-side PR merge. Treat CI required checks as the authoritative gate; never assume a green local push means the security scan ran.
- **Managing the gate as code:** `scripts/apply-main-branch-protection.sh` (idempotent) adds/updates the required-status-check rule on the `main-branch` ruleset. It needs a token with repo **Administration: write** (a contents/PR-scoped fine-grained PAT gets HTTP 403 on the ruleset PUT). The check-context strings in that script must match the workflow job `name:` values **exactly** — a typo becomes an "Expected" check that never reports and blocks `main` permanently.

### The `develop` gate (contributors gated, owner bypasses)

`develop` is the integration branch: every contributor PR lands there first and soaks for a few days before the release PR to `main`. Its ruleset is `develop-branch`, managed by `scripts/apply-develop-branch-protection.sh` (idempotent — creates if absent, else replaces the rules).

- **What it enforces:** `deletion` + `non_fast_forward` protection, **1 required approval**, and **9 required status checks** — the five `CI` jobs (`ci.yml`) plus the same four `Security Audit` jobs `main` requires.
- **The owner (admin role) is a bypass actor, deliberately.** Required status checks gate *ref updates*, not just merges, so without the bypass the `md-fix-bugs` / `md-add-improvement` flow — merge each verified branch straight into `develop` locally, then push — would start getting rejected. So `develop-branch` gates *contributors*; the local `.githooks/pre-push` remains the owner's gate. Because that hook silently skips `govulncheck` without a host Go toolchain, `security-audit.yml` also runs on **pushes** to `develop`, so the branch tip is scanned even when the hook couldn't.
- **Why 1 approval and not 0:** outside contributors work from forks and have **no write access to the base repo**, so they cannot merge anything today regardless of rulesets — merging requires write on the base. But `mahsan_bypass` (`~ALL`) only requires *that a PR exist*, with `required_approving_review_count: 0`. The moment anyone is granted write, they could self-merge into `develop`. An author cannot approve their own PR, so requiring 1 routes any future collaborator through the owner. Set in advance rather than after.
- **`require_code_owner_review` is left off on `develop`, and is inert on `main`** — there is no `CODEOWNERS` file in the repo. Adding one would be actively harmful while the owner is sole maintainer: `main-branch` has no bypass actors, and GitHub forbids self-approval, so a `CODEOWNERS` entry would hard-block the owner's own release PRs.
- **Check-context strings must match what Actions *reports*, not the job `name:`.** For a **matrix** job the reported context appends the matrix values — `ci.yml`'s `images` job carries both `name` and `context` keys, so it reports as `Docker images (build only) (backend, backend)`. Always verify against a real run before editing the list, or the branch blocks forever on an "Expected" check that never arrives:
  ```bash
  gh api "repos/<owner>/<repo>/commits/$(git rev-parse origin/develop)/check-runs" \
    --jq '.check_runs[].name' | sort -u
  ```
- **Repository-role bypass ids are asserted, not looked up** — a user-owned (non-org) repo has no roles listing endpoint. `5` is the admin role; the script verifies by asserting `current_user_can_bypass == "always"` after writing and exits non-zero if not, since a wrong id silently breaks the owner's direct pushes to `develop`.

### Where contributor PRs should target

`main` is still the default branch, so GitHub prefills `main` as the base for fork PRs and contributors have to retarget by hand. This is a known, accepted rough edge — the trunk-based model (PRs into `main`, release branches cut off it) is the ecosystem norm that contributors expect, whereas mdnest uses git-flow because it ships explicit versioned self-hosted releases with an in-app update banner keyed to GitHub Releases. Two ways to close it if the friction becomes real: make `develop` the default branch (**repoint `main-branch`'s condition from `~DEFAULT_BRANCH` to literal `refs/heads/main` first**, or the whole security gate silently follows the default onto `develop`), and/or add a required check on `main` that fails when a PR's head isn't `develop` / `release/*` / `hotfix/*`. Neither is in place yet.

## Debugging Practice

- **Read the error message literally** — "expected 12 not 11" means count your Scan args, don't blame Docker cache
- **Never assume the problem is external** (cache, stale code, old binary) without evidence — check YOUR code first
- When adding a column to a SQL query, grep ALL Scan() calls for that table and update every one
- When a fix doesn't work after 2 attempts, **stop guessing and look at the actual data**
- Read `mdnest.conf` and `.env` for ports, credentials, and config — never hardcode or guess
- Use the running server's API to fetch real content: `curl -s http://<BIND_ADDRESS>:<BACKEND_PORT>/api/note?ns=...`
- Use `python3 -c "print(repr(chunk))"` to see exact bytes (escapes, `<br/>` vs `\n`, whitespace)
- Check the live Docker containers: `docker ps | grep mdnest` — know which port serves what
- When the dev machine runs the same server the user tests against, use it directly instead of asking the user for logs

## What NOT to Do

- Do not add a database dependency in single mode — files are the source of truth for notes; Postgres is only for user/permission management in multi mode
- Do not add runtime namespace/workspace creation — namespaces come from mounts
- Do not use `new marked.Renderer()` — use plain object for marked v15
- Do not hardcode paths or credentials — everything from env/config
- Do not add SSR — frontend is fully static
- Do not add heavy editor libraries (CodeMirror, Monaco) — plain textarea
- Do not break single-mode behavior — multi-user features must be fully conditional

## Scope discipline

- **Solve only the problem that's ours to solve; do our best but don't over-engineer.** Fix what mdnest itself produces (e.g. *guarantee* readable mermaid contrast in our render layer), but don't try to police or re-educate the world outside our box — don't edit users' `CLAUDE.md` at install, lecture authors about their color choices, or build elaborate guidance systems for mistakes that originate upstream. The render-layer guarantee is ours; the author's input is theirs. Prefer the smallest change that genuinely fixes the user-visible problem.

- **The core stays lean; new capability arrives off-by-default behind a flag.** mdnest's promise is a single-box deployment anyone can stand up with `setup.sh` and reason about end to end, with plain files as the source of truth. Features that add real value are welcome — but an operator who doesn't need one must carry none of its weight or risk: no extra dependency, no new env var to understand, no new failure mode. Measure this, don't assert it. When judging whether a change kept the promise, check the numbers that matter: new entries in `go.mod` / `package.json`, gzipped bundle delta, and whether `setup.sh`, `mdnest.conf.sample`, `docker-compose.yml`, the Dockerfiles, `mdnest-server` and `nginx.conf` moved at all. v3.11.7 added ~3,180 lines but only 100 of runtime code, zero Go deps, +368 B gzipped, and left every file in that list untouched — that shape is fine. A feature that grows the default install is not.

- **A configuration surface must never outrun the code behind it.** The backend silently ignores env it doesn't read, so a knob whose implementation isn't merged doesn't fail — it lies. v3.11.7 shipped a Helm chart offering `storage.backend=s3`, `collab.redis.*` and `mcp.enabled` before any of that code existed: `s3` would have written notes to the PVC while looking configured for a bucket, and a multi-replica deploy would have split collaboration state per pod, both while reporting `Ready`. Guard the option (`mdnest.validateSupported` in `deploy/helm/mdnest/templates/_helpers.tpl`) so it fails at install time naming what's missing, assert both directions in CI (the supported config renders; the unsupported ones are rejected), and **delete a guard in the same change that lands the capability behind it.** (The `collab.redis` and `mcp.enabled` guards have since been removed as the Redis backplane and the streamable-HTTP MCP transport landed; `storage.backend=git` added a git-sync coexistence guard of its own; and the `s3` surface was removed outright — it was never implemented, so `mdnest.validateSupported` now simply rejects any `storage.backend` other than `local` or `git`.)

- **Changing what mdnest *is* is a conversation, not a diff.** Adding an option is ordinary work. Trading away a founding property — files as the source of truth, namespaces from mounts, no DB in single mode — is a maintainer decision to make before the code is reviewed, however good the code is. When an incoming change does both, ask for it split so the mechanical part can land while the contentious part is decided.

## Testing

**Tiered, fully-local test strategy — no CI/remote needed.** All of it runs on the
host via Docker; the pre-push hook (`.githooks/pre-push`) wires it into the
release flow so nothing broken reaches `main`. Fast checks run on every push; the
heavier end-to-end suites run only when pushing toward `main` (a `release/*` or
`main` ref — detected from the refs git feeds the hook on stdin). Emergency
override: `MDNEST_SKIP_E2E=1`.

- **Fast tier (every push):**
  - `tests/cli-unit.sh` — instant pure-function checks of the CLI helpers
    (`urlencode`/`urldecode`/`json_top_string`) plus the `list` renderers
    (`format_tree`/`format_namespaces`), run across **four** parser
    environments: real `python3`; a **noisy** python3 (a PATH shim that prints a
    `.pth` traceback to stderr on every start — the issue #87 repro); a
    **broken** python3 (exits non-zero); and `python3`/`jq` force-disabled. This
    is the cheap guard for the class of bug where the CLI breaks — or leaks
    someone else's traceback — because of the machine's python rather than ours.
    The rendering checks run in the with- and without-parser passes and must
    agree, which is what keeps a python3/jq tier from creeping back into output.
    Also carries, as of v4.3.2, an **unreachable-servers suite** (runs the
    real CLI against a throwaway `HOME` pointed at two closed loopback ports —
    instant, no network — pinning that `mdnest servers` exits 0, prints one row
    per registered server, labels the dead one, and that `api()` reports why;
    ten of its eleven checks fail against the pre-fix CLI, and the eleventh
    catches the *partial* fix that leaves a stray `curl_rc=$?` behind), a
    **version-comparison suite** for `version_gt`/`cli_update_notice`, and
    **`run_errexit_lint`** (see the CLI conventions above). Plus a
    **login argument-handling suite** (v4.1.3+) that runs the real
    CLI as a subprocess against a throwaway `HOME`: it pins the exit status, that
    a rejected login leaves *nothing* on disk, that the unreachable path never
    mentions `SERVER_ALIAS`, and that no suggested command contains an angle
    bracket. (Run those via `login_run`, never inside `$(…)` — a command
    substitution is a subshell, so the `HOME` and status it sets are lost and the
    assertions pass vacuously.)
  - `tests/pre-push-audit.sh` — **new in v4.4.0.** Drives the hook's own
    `npm_audit_check` against fake `npm` shims for all eleven outcomes, with no
    network. It exists because the hook conflated "npm audit found advisories"
    with "npm audit could not reach the endpoint" (see the gate section above),
    and the danger in fixing that is over-classifying: the load-bearing check is
    **"a real vulnerability still exits non-zero"**, not the skip cases. Verified
    by mutation — 8 of its 11 checks fail against the pre-fix hook, and the three
    that pass in both are exactly the ok/block cases that must not change. The
    helper is `sed`-extracted from the shipped hook so the test cannot drift from
    the code it pins.
  - `tests/cli-edit-etag.sh` — **new in v4.4.0.** Drives the real CLI against a
    throwaway-`HOME` and a fake backend that reports the request it received,
    pinning that `mdnest edit`'s PUT actually carries `If-Match` and that a save
    landing inside the read-modify-write window is refused rather than
    overwritten. It is separate from `cli-unit.sh` on purpose: the unit tier can
    only prove the splice helpers are correct, and **helpers that work while
    nothing consults them are exactly how this bug comes back** — deleting the
    `If-Match` line from `cmd_edit` leaves every unit check green. Verified by
    mutation: that deletion fails 7 of its 9 checks, including "the concurrent
    save survived". The fake backend mutates the note *when it serves the GET*,
    so the race is deterministic and there is nothing to flake. Needs python3
    for the fake backend only and SKIPs without it; the CLI's own no-python3
    tier stays covered by `cli-unit.sh` and `e2e-docker.sh`.
  - `tests/cli-approval.sh`: **new in v4.8.5.** Drives the real
    `mdnest approval request` / `done` / `notify` (and the keepalive
    stopped notice) against a fake backend, also with
    python3 and jq broken. The hook has two allowed outcomes, the server's
    answer byte for byte or NOTHING with exit 0 (the agent's terminal prompt
    then answers), and the test pins both, plus that no policy file, a tool
    not in TOOLS or a NEVER_REMOTE match sends nothing at all.
    `tests/setup-agent-approvals.sh` pins the ENABLE_AGENT_APPROVALS plumbing,
    and `tests/browser/approvals.spec.js` the card (the browser harness turns
    the switch on).
  - `tests/server-unit.sh` — **new in v4.1.3.** Pure-function checks of
    `mdnest-server`, loaded through its `MDNEST_SERVER_LIB=1 source` hook (the
    mirror of the client CLI's `MDNEST_LIB`). Currently covers namespace-drift
    reporting — `namespace_drift_report` is split out from the Docker-querying
    `namespace_drift` precisely so it can be tested with no Docker and no running
    stack. Assertions run against whitespace-normalized output so they pin the
    words, not the column padding.
    Uses the CLI's `MDNEST_LIB=1 source mdnest` hook to load the real functions.
  - Plus the existing builds, `npm test`, audits, version consistency, shellcheck.
- **CLI smoke test**: `tests/cli-smoke-test.sh` exercises every `mdnest` note
  operation (create/write/append/prepend/read/move/delete/search/list, subfolder
  scoping, `mdnest://` decode) plus the stdin edge cases end-to-end against a
  disposable namespace. Targets `testing_workspace` by default (add
  `MOUNT_testing_workspace=<host_path>` to `mdnest.conf` + `./mdnest-server
  reload`). Override with `MDNEST_TEST_NS` / `MDNEST_TEST_ALIAS` / `MDNEST_BIN`.
  Creates everything under a unique `__clitest_*` folder and deletes it on exit.
- **End-to-end tier (pushing toward `main`):**
  - `tests/e2e-docker.sh` — builds the **backend from the working tree**, boots a
    throwaway single-mode instance, mints a token, and runs the CLI smoke test
    against it **twice**: on the host (python3 present) and inside a **bare
    `alpine` container with no python3/jq** (the truest fresh-machine repro).
  - `tests/e2e-browser.sh` — builds **frontend + backend**, boots the full nginx
    stack, seeds a note, then runs the **Playwright** suite in `tests/browser/`
    (login, tree, open/render a note, Live [Crepe] + Basic editors, search,
    create-via-UI). Installs Playwright + Chromium into `tests/browser/` on first
    run. Exit code 2 = prerequisites (docker/node) missing → the hook SKIPs it.
  - `tests/setup-default-theme.sh` — **new in v4.3.0.** Asserts a config knob
    actually reaches the generated `.env`. This class of failure is silent: the
    backend ignores env it does not read, so broken plumbing does not error, it
    quietly reverts to a default. Runs in the pre-push hook alongside
    `tests/setup-marp-themes.sh`, which existed from v4.2.0 but was never
    invoked by anything until now.
  - `tests/setup-sso-options.sh` — **new in v4.5.4.** The same class for the
    SSO switches (`SSO_DISABLE_PASSWORD_LOGIN`, `SSO_AUTOPROVISION_USERS`,
    `OIDC_GROUPS_CLAIM`): each reaches `.env`, a typo in a boolean fails setup
    instead of silently meaning "off", and a value exported in the shell does
    not leak in. Written because `setup.sh` never forwarded the last two, so
    both were ignored on every setup.sh install and nothing said so.
- **Playwright pins `colorScheme: 'dark'`** in `tests/browser/playwright.config.js`.
  mdnest's default theme is `auto`, which follows `prefers-color-scheme`, and
  Playwright's own default emulation is *light* — so without that pin every
  existing spec would silently start running against the light palette. A spec
  that cares about a theme sets it with `page.emulateMedia()`.
- **A browser spec that seeds files must clean them up** (issue #114). The
  first transfer spec left fixtures at the namespace root, which pushed
  `tree-target.spec.js`'s drag row off-screen and failed it — a later spec,
  in another file. `transfer.spec.js` keeps each test's files in one folder
  and deletes it in `afterEach`. The harness mounts a second namespace,
  `zz_e2e_target`, named to sort AFTER `testing_workspace` so every other
  spec still opens in the namespace it expects.
- `tests/e2e-private-chats-multi.sh` — **issue #127.** Private chats against a
  real Postgres: the migration, the folder-prefix SQL behind move and copy,
  the row lock that keeps two members removing each other from leaving
  nobody, and a deleted account keeping its chat private. Not in the
  pre-push hook (needs Postgres); run it when touching chat membership or the
  permission checker. The route-by-route coverage is
  `backend/routes_chat_members_test.go`, against an in-memory store.
- `tests/e2e-transfer-multi.sh` — **issue #114.** Postgres + the backend from
  the working tree, real users, path-scoped grants, an access group and an API
  token driven through `/api/transfer` and `/api/download`, every allowed and
  denied case checked against the disk. The multi-mode counterpart of the unit
  fakes; not in the pre-push hook (it needs Postgres), run it when touching
  either endpoint or the permission checker.
- `tests/setup-download-limits.sh` — `DOWNLOAD_MAX_*` reach `.env`, defaults
  are written, a non-number is refused at setup, a shell export cannot leak
  in (it did, before the reset at the top of `setup.sh`).
- **A test that destroys user data must refuse to run against a real account.**
  `tests/browser/stickies.spec.js` wipes the sticky board of whatever account
  it signs in as, and a sticky exists nowhere else — no namespace, no git
  remote, no history — so there is nothing to restore from. Pointed at the
  owner's own account on the dev instance it silently deleted his real
  stickies, repeatedly, and nothing in the code objected; the intention not to
  do it again is exactly what failed. The suite now refuses to start unless
  `MDNEST_USER` looks like a throwaway (`e2e`/`test`) or
  `MDNEST_ALLOW_BOARD_WIPE=1` is set. Any future suite that destroys per-user
  state should carry the same guard.
- **Adding a regression test is part of fixing a bug** (see `md-fix-bugs`): add a
  check to the layer that would have caught it — a CLI-behaviour bug → a
  `cli-smoke-test.sh` assertion; a parser/fallback bug → a `cli-unit.sh` case; a
  UI bug → a `tests/browser` spec. The point of the harness is that the next
  regression of the same shape fails loudly and locally before merge.

## Documentation

See `docs/` for:
- `api.md` — Full API reference with curl examples
- `user-guide.md` — End-user guide
- `setup.md` — Setup and configuration
- `architecture.md` — Architecture overview
- `security.md` — Threat model and the five defense layers (layer 5, rendered-content sanitization, is v3.11.7+)
- `cli.md` — `mdnest` client CLI
- `kubernetes.md` — Optional Helm chart (v3.11.7+); says which options are gated off and why
- `sso-setup.md` / `firebase-setup.md` — Identity-provider setup
