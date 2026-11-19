# Testing notes (full)

The long form of `tests/AGENTS.md`.


**Three test levels: run the one that fits the step, not everything every
time.** The entry point is `bash tests/check.sh --level <level>` (default
`develop`). Balance accuracy and speed: no hour-long verification below ship.

| Level | When | What runs | Target |
|---|---|---|---|
| `iterate` | while working on a branch | only what the change touches: `go vet` + `go test -race` for the changed backend packages, `npm test` if `frontend/` changed, `cli-unit.sh` if the CLI changed, and the feature's browser specs named in `MDNEST_E2E_SPECS` (add `MDNEST_E2E_HARNESS=collab` for two-user specs). Each once, no full suites | under 5 min |
| `develop` | before merging a branch into develop | the pre-push fast tier, `go vet` + `go test -race` on the whole backend with Redis, shellcheck, and the e2e suites the files changed since `origin/develop` call for, each once, sharded. A spec whose flake was just fixed gets `MDNEST_E2E_ARGS="--repeat-each 3"`, not 10 | about 15 to 20 min |
| `ship` | `md-ship`: a `release/*` or `main` push | the full gate, the only level that runs everything: every suite, compared with `origin/main`, recorded in `.git/mdnest-release-gate` for the hook. `bash tests/release-gate.sh` is the same thing. Upgrade checks when stored data changed stay a manual `md-ship` step | as long as it takes |

Optional local chat coordination has two focused fake-only suites:
`node tests/chat-runner.mjs` and `npm --prefix mcp-server test` (including
`test_chat_coordination.mjs`). They never launch a provider or use live notes.
The runner suite checks trigger data, persona refresh, leases/ack, local limits
and process-group cleanup. The MCP suite checks trusted local launch opt-in,
concurrent caps, subscriptions and shutdown. Backend coordination and stream
contracts run under Go race tests; the Agents popup has unit/browser coverage.

At `develop` and `ship` the images are built once and the browser suites run
in one lane beside everything else. The `@budget` timing tests run last,
alone: always at `ship`, where a failure blocks; at `develop` only when the
diff touches a `@budget` spec or the code it times (`BUDGET_CODE_PAT` in
`tests/check.sh`), and there a failure is a warning that prints the machine's
load, because those budgets react to load from other projects on the box. The pre-push hook is unchanged: it still refuses a `release/*` or
`main` push of a tree the ship level did not pass.

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
- **Images are built once per tree, and the browser suites run in shards**
  (FAST-1). Every harness gets its images from `tests/lib/e2e-images.sh`,
  which tags them `mdnest-e2e-backend:<hash>` / `mdnest-e2e-frontend:<hash>`
  from a hash of `backend/` (or `frontend/` plus the `mdnest` CLI) as the
  working tree has it, uncommitted and untracked files included, and skips the
  build when that tag exists. So the release gate and every suite in it share
  one build, and two runs on different trees can never swap each other's
  image (the old fixed `:test` tag allowed exactly that). Containers,
  networks and notes folders carry the run's pid and shard number, so
  harnesses can run side by side. `MDNEST_E2E_REBUILD=1` builds anyway;
  `MDNEST_E2E_KEEP_IMAGES` (default 4) is how many tags `e2e_prune_images`
  keeps. `e2e-browser.sh` and `e2e-collab-multi.sh` split their specs across
  `MDNEST_E2E_SHARDS` stacks (default one per 3 CPUs, at most 3) with
  `playwright test --shard=i/N`. Each shard is a whole stack of its own
  (backend, Postgres where used, nginx, notes folder, accounts, CLI logins)
  with one worker, so no two specs share a server, which keeps the isolation
  the suite had on one stack: a spec that wipes the sticky board or relies on
  the tree's layout is still alone on its server. `MDNEST_E2E_SHARDS=1` is
  the old single-stack run. Each shard's traces go to
  `tests/browser-results/shard-N` (all output is outside `tests/browser`, the folder Playwright walks for specs, or a shard can crash on another one's half-written folder). There are no test-only knobs that
  shorten the app's poll intervals: the slow specs (`collab-idle`
  and `cli-vs-typing`) exist to prove behaviour across those real
  intervals.
  Timing-budget tests (a fixed millisecond limit, like chat.spec.js "typing
  stays fast in a long chat") carry `{ tag: '@budget' }`. The shards skip
  them and one stack runs them alone afterwards (`MDNEST_E2E_BUDGET`:
  `after` is the default, `skip`, `only`, or `inline` for no split), because
  a budget measured while other shards use the CPU fails for reasons that
  have nothing to do with the app. `tests/check.sh` runs them last, after
  all of its parallel work (see the levels table above). Tag any new test
  that compares a duration with a fixed number, and add the code it times to
  `BUDGET_CODE_PAT` in `tests/check.sh`.
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
- `tests/e2e-collab-multi.sh`: **shared editing (v4.8.10).** Postgres + backend + nginx from the working tree, two accounts with write on testing_workspace, runs `tests/browser/collab-shared-editing.spec.js` (two contexts typing at once, open-and-leave keeps the bytes, saver closing mid-debounce, outside PUT merging in, front matter kept, folder move closes the room, Basic switching to Live), `collab-cli.spec.js` (the REAL ./mdnest, logged in with API tokens in throwaway HOMEs, at a note open in a browser: write/append/prepend/edit show live, a disk write shows via the saver's 20 s check, CLI changes during typing merge), `collab-idle.spec.js` (a note left open a minute: no remount, no change inside the editor, no reconnect), `cli-vs-typing.spec.js` (one person typing past the 60 s poll while the CLI appends: the CLI line must reach disk; prints a RESULT line per run) and `presence.spec.js`. `MDNEST_BUILD_ROOT=<checkout>` builds the app from another tree (an older tag in a throwaway worktree) with today's specs and CLI; `MDNEST_E2E_BACKEND_ENV="SHARED_EDITING=false"` adds backend settings. That is how v4.8.9 was shown to lose CLI text and v4.8.10 not. The notes dir is on the host so specs check disk bytes. Not in the pre-push hook (needs Postgres); run it when touching collab, App's save paths or the Live editor.
- `tests/release-gate.sh`: **the release gate (v4.8.12), now the ship level of `tests/check.sh`.** Run on the release commit before pushing it. It builds the e2e images once, then runs two lanes side by side: the browser lane (`e2e-browser.sh`, then `e2e-collab-multi.sh`, each sharded) and the other lane (the pre-push hook's release tier inline with `MDNEST_GATE_SUITES_OUTSIDE=1`, so the hook leaves its end-to-end suites to the gate; inside a push, GitHub dropped the SSH connection after 10 minutes; Go vet + `go test -race` with a real Redis (host Go or Docker), shellcheck (host or Docker), `e2e-docker`, `e2e-sec-multi`, `backend-image-init`, and the suites picked by the files changed since `origin/main` (`MDNEST_GATE_ALL=1` runs them all)). `MDNEST_GATE_LANES=1` runs the lanes one after the other. On success it writes the tested tree to `.git/mdnest-release-gate`; the hook refuses a `release/*` or `main` push of any other tree. It refuses to run with uncommitted tracked changes, since the record must name the tree it tested.
- `tests/e2e-ha-durability.sh`: **issue #147.** Redis + one `MDNEST_ROLE=writer` + one `MDNEST_ROLE=app` from the working tree (or `MDNEST_BUILD_ROOT=<checkout>`): a burst of appends must land on the writer's disk with the durability stream back at 0 entries, and a writer whose lock is taken away while Redis is at maxmemory must win it back and apply the next save without a restart. Against v4.8.10 it fails 4 of 9. The unit layer is `backend/storage/redis_queue_test.go`, which needs `MDNEST_TEST_REDIS_URL` (CI's backend job runs a Redis service for it; locally the tests skip without it). Not in the pre-push hook; run it when touching the queue, writer or leader.
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

