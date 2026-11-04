#!/usr/bin/env bash
#
# mdnest browser end-to-end test — local, Docker-based, no GitHub/remote
# ─────────────────────────────────────────────────────────────────────
# Builds the frontend AND backend from the working tree, boots the full stack
# (nginx frontend + backend on a private network), seeds a note into a disposable
# testing_workspace, then runs the Playwright browser suite (tests/browser)
# against it to catch UI regressions. Everything is torn down on exit.
#
# Playwright + its Chromium browser are installed on demand into tests/browser
# the first time (a few hundred MB). Subsequent runs reuse them.
#
# Usage:   tests/e2e-browser.sh
#          MDNEST_E2E_SHARDS=3 tests/e2e-browser.sh   (three stacks, see below)
#          MDNEST_E2E_SPECS="smoke.spec.js theme.spec.js" tests/e2e-browser.sh
#          MDNEST_E2E_ARGS="--repeat-each 3" MDNEST_E2E_SPECS=chat.spec.js tests/e2e-browser.sh
#
# Shards: the specs are split across MDNEST_E2E_SHARDS stacks (default: one
# per 3 CPUs, at most 3; tests/lib/e2e-images.sh e2e_shards). Each shard is a
# whole stack of its own (backend, nginx, notes folder, seeded notes) with one
# Playwright worker, so no two specs ever share a server, an account or a
# notes tree, the same isolation as one stack running them in turn.
# MDNEST_E2E_SHARDS=1 is the old single-stack run.
#
# Exit:    0 if the browser suite passes, 1 otherwise, 2 if prerequisites
#          (docker / node) are missing.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# shellcheck source=tests/lib/e2e-images.sh
. "$REPO_ROOT/tests/lib/e2e-images.sh"
SFX="$$"
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-e2e-browser.XXXXXX")"
# shellcheck disable=SC2086
SHARDS="$(e2e_cap_shards "$(e2e_shards)" ${MDNEST_E2E_SPECS:-})"
# Per shard: container names, network and notes folder. Every name carries the
# run's pid and the shard number, so parallel runs never touch each other.
# The notes folders live inside the repo, not the system temp dir: they are
# bind-mounted into the backend container, and on macOS mktemp lands in
# /var/folders, which Colima (and a Docker Desktop with narrowed file sharing)
# does not share; the container then saw an empty /notes and the run died at
# "could not seed note" before a single test ran.
BES=(); FES=(); NETS=(); NOTES=(); BASES=()

log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

cleanup() {
  local i
  for i in "${!BES[@]}"; do
    docker rm -f -v "${FES[$i]}" "${BES[$i]}" >/dev/null 2>&1 || true
    docker network rm "${NETS[$i]}" >/dev/null 2>&1 || true
    e2e_rm_dirs "${NOTES[$i]}"
  done
  [ -z "${KEEP:-}" ] && rm -rf "$LOGDIR"
  return 0
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { fail "docker is required"; exit 2; }
docker info >/dev/null 2>&1        || { fail "docker daemon isn't running"; exit 2; }
command -v node >/dev/null 2>&1    || { fail "node is required for Playwright"; exit 2; }
command -v npx  >/dev/null 2>&1    || { fail "npx is required for Playwright"; exit 2; }

BUDGET="$(e2e_budget_mode)"
if [ "$BUDGET" = only ]; then
  e2e_playwright_ready "$LOGDIR" || { fail "Playwright setup failed"; exit 1; }
  # shellcheck disable=SC2086
  e2e_has_budget ${MDNEST_E2E_SPECS:-} || { pass "no @budget tests in the selected specs, nothing to run"; exit 0; }
fi

# ── Build both images from the working tree (or reuse them) ─────────────────
# Tagged by a hash of the tree (tests/lib/e2e-images.sh), so a tree that was
# already built, by this harness or another one, is not built again.
log "Building backend + frontend images from the working tree"
BE_IMAGE="$(e2e_backend_image "$REPO_ROOT" "$LOGDIR")" || { fail "backend build failed"; exit 1; }
# The frontend image serves the repo-root CLI at /cli/mdnest; it comes in as
# the named "cli" build context (see frontend/Dockerfile).
FE_IMAGE="$(e2e_frontend_image "$REPO_ROOT" "$LOGDIR")" || { fail "frontend build failed"; exit 1; }
pass "images ready: $BE_IMAGE, $FE_IMAGE"

# ── Boot one shard's stack and seed it ─────────────────────────────────────
# boot_shard I: start shard I's backend + nginx and seed its notes. Sets
# BASE_URL and TOKEN for that shard.
boot_shard() {
  local i="$1"
  BE="mdnest-e2e-be-$SFX-$i"; FE="mdnest-e2e-fe-$SFX-$i"; NET="mdnest-e2e-net-$SFX-$i"
  NOTES_DIR="$(e2e_notes_dir "$REPO_ROOT")"
  BES[i]="$BE"; FES[i]="$FE"; NETS[i]="$NET"; NOTES[i]="$NOTES_DIR"
  mkdir -p "$NOTES_DIR/testing_workspace"
  # A second namespace for the move/copy-between-namespaces specs. Named to sort
  # after testing_workspace, which stays the namespace every other spec opens in.
  mkdir -p "$NOTES_DIR/zz_e2e_target"
  docker network create "$NET" >/dev/null

  log "Starting backend (network alias 'backend' so nginx can proxy to it)"
  docker run -d --name "$BE" --network "$NET" --network-alias backend \
    -e AUTH_MODE=single \
    -e MDNEST_USER=e2e \
    -e MDNEST_PASSWORD=e2epass123 \
    -e MDNEST_JWT_SECRET=e2e-test-secret \
    -e NOTES_DIR=/notes \
    -e FRONTEND_ORIGIN=http://localhost \
    -e ENABLE_TASK_BOARD=true \
    -e ENABLE_EXCALIDRAW=true \
    -e ENABLE_MARP=true \
    -e ENABLE_MARP_THEMES=true \
    -e ENABLE_LIVE_COLLAB=true \
    -e ENABLE_AGENT_APPROVALS=true \
    -v "$NOTES_DIR:/notes" "$BE_IMAGE" >/dev/null

  log "Starting frontend (nginx) on an ephemeral host port"
  docker run -d --name "$FE" --network "$NET" \
    -p 127.0.0.1:0:80 "$FE_IMAGE" >/dev/null

  PORT="$(docker port "$FE" 80/tcp | head -1 | sed 's/.*://')"
  [ -n "$PORT" ] || { fail "couldn't determine frontend port"; docker logs "$FE"; exit 1; }
  BASE_URL="http://127.0.0.1:$PORT"

  log "Waiting for the stack at $BASE_URL"
  healthy=0
  for _ in $(seq 1 40); do
    # /api/config is proxied by nginx to the backend — proves BOTH are up + wired.
    if curl -fsS "$BASE_URL/api/config" >/dev/null 2>&1; then healthy=1; break; fi
    sleep 1
  done
  [ "$healthy" = 1 ] || { fail "stack never became healthy"; docker logs "$BE"; docker logs "$FE"; exit 1; }
  pass "stack healthy"

  # ── Seed a note (via the proxied API) so the read/search/editor tests have data ─
  log "Seeding a note into testing_workspace"
  TOKEN="$(curl -fsS -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"username":"e2e","password":"e2epass123"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [ -n "$TOKEN" ] || { fail "could not mint a token"; exit 1; }
  curl -fsS -X POST "$BASE_URL/api/note?ns=testing_workspace&path=$SEED_FILE" \
    -H "Authorization: Bearer $TOKEN" \
    --data "# E2E Seed

This note exists so the browser tests have content to open, render and search.
Unique token: $SEED_TOKEN
" >/dev/null || { fail "could not seed note"; exit 1; }
  pass "seeded $SEED_FILE (token $SEED_TOKEN)"

  # A mermaid flowchart, so the suite can prove diagram labels actually render.
  # Mermaid draws flowchart labels inside <foreignObject>; a sanitizer that drops
  # that element leaves the boxes but silently deletes every label (v3.11.7).
  #
  # Node C carries a pale author fill on purpose. Rendering a label is not the
  # same as rendering a READABLE one: in dark mode every such label used to be
  # painted with the light ink, because the contrast walk measured mermaid's
  # zero-area label spacer (which inherits the dark themed mainBkg) instead of
  # the node the text actually sits on. mermaid-contrast.spec.js pins that.
  curl -fsS -X POST "$BASE_URL/api/note?ns=testing_workspace&path=$MERMAID_FILE" \
    -H "Authorization: Bearer $TOKEN" \
    --data "# Mermaid render check

\`\`\`mermaid
flowchart TD
  A[$MERMAID_LABEL] -->|\"$MERMAID_EDGE\"| B[Second Node]
  B --> C[$MERMAID_PALE]
  classDef pale fill:#cfe4ff,stroke:#2557d6,stroke-width:2px;
  class C pale;
\`\`\`
" >/dev/null || { fail "could not seed mermaid note"; exit 1; }
  pass "seeded $MERMAID_FILE (label $MERMAID_LABEL)"

  # A note with task-list items, so the suite can drive the kanban board and the
  # Live editor's checkbox round-trip. Ticking a checkbox is a mouse-only
  # interaction handled inside ProseMirror — it never produces a keydown or a
  # document-level mousedown, which is exactly how the save gate came to swallow
  # those edits for a whole session (v4.0.0).
  curl -fsS -X POST "$BASE_URL/api/note?ns=testing_workspace&path=$BOARD_FILE" \
    -H "Authorization: Bearer $TOKEN" \
    --data "# Sprint

The line of prose keeps this note in the editor: a note of tasks only opens on the board.

- [ ] $BOARD_TASK
  - priority: high
  - tags: [release]
- [x] Already finished
" >/dev/null || { fail "could not seed board note"; exit 1; }
  pass "seeded $BOARD_FILE (task $BOARD_TASK)"

  # Two more board notes, one per mutating spec, so the checkbox round-trip tests
  # never depend on each other's edits and no test has to reset shared state
  # mid-run (resetting a note the app already has open leaves the editor holding
  # a stale ETag, which masks the very thing these specs measure).
  for pair in "tick:[ ]" "untick:[x]"; do
    name="${pair%%:*}"; box="${pair##*:}"
    curl -fsS -X POST "$BASE_URL/api/note?ns=testing_workspace&path=e2e-board-$name.md" \
      -H "Authorization: Bearer $TOKEN" \
      --data "# $name

A line of prose, so the note opens in the editor.

- $box $BOARD_TASK
  - priority: high
" >/dev/null || { fail "could not seed e2e-board-$name.md"; exit 1; }
  done
  pass "seeded e2e-board-tick.md / e2e-board-untick.md"

  BASES[i]="$BASE_URL"
  return 0
}

SEED_FILE="e2e-seed.md"
SEED_TOKEN="zzq${SFX}marker"
MERMAID_FILE="e2e-mermaid.md"
MERMAID_LABEL="zzm${SFX}label"
MERMAID_PALE="zzp${SFX}pale"
MERMAID_EDGE="zze${SFX}edge"
BOARD_FILE="e2e-board.md"
BOARD_TASK="zzt${SFX}task"
for ((s = 0; s < SHARDS; s++)); do
  log "Shard $((s + 1)) of $SHARDS"
  boot_shard "$s" || exit 1
done
# The /cli/ checks below run against the first shard's stack.
BASE_URL="${BASES[0]}"
TOKEN="$(curl -fsS -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"e2e","password":"e2epass123"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"

# ── The CLI this server serves, and what the /cli/ location must not change ──
log "Checking /cli/ and the routes around it"
CLI_TMP="$(mktemp -d)"
code_of() { curl -s -o "$CLI_TMP/body" -w '%{http_code}' "$1"; }
if [ "$(code_of "$BASE_URL/cli/mdnest")" = "200" ] && cmp -s "$CLI_TMP/body" mdnest; then
  pass "/cli/mdnest is byte-identical to the repo-root mdnest"
else
  fail "/cli/mdnest is not the repo-root mdnest"; exit 1
fi
if [ "$(code_of "$BASE_URL/cli/install.sh")" = "200" ] && cmp -s "$CLI_TMP/body" frontend/public/cli/install.sh; then
  pass "/cli/install.sh is served"
else
  fail "/cli/install.sh is not served"; exit 1
fi
[ "$(code_of "$BASE_URL/cli/nope")" = "404" ] || { fail "/cli/ miss is not a 404"; exit 1; }
pass "/cli/ miss is a 404, not the app"
[ "$(code_of "$BASE_URL/assets/no-such-chunk.js")" = "404" ] || { fail "/assets/ miss is no longer a 404"; exit 1; }
pass "/assets/ miss is still a 404"
if [ "$(code_of "$BASE_URL/some/app/route")" = "200" ] && grep -q 'id="root"' "$CLI_TMP/body"; then
  pass "an app route still falls back to index.html"
else
  fail "the SPA fallback changed"; exit 1
fi
[ "$(code_of "$BASE_URL/api/config")" = "200" ] || { fail "/api/ is no longer proxied"; exit 1; }
pass "/api/ is still proxied"

# The Install and Connect commands the Settings CLI tab shows, run for real in
# a throwaway HOME: install from this server, then log in pasting a token at
# the prompt. The login runs on a pty because it reads the token from the
# terminal.
if command -v python3 >/dev/null 2>&1; then
  API_TOKEN="$(curl -fsS -X POST "$BASE_URL/api/auth/tokens" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d '{"name":"e2e-cli"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [ -n "$API_TOKEN" ] || { fail "could not create an API token"; exit 1; }
  mkdir -p "$CLI_TMP/home" "$CLI_TMP/bin"
  # Step "Install", exactly as the tab shows it.
  if HOME="$CLI_TMP/home" MDNEST_BIN_DIR="$CLI_TMP/bin" \
     bash -c "curl -fsSL $BASE_URL/cli/install.sh | bash -s -- $BASE_URL" >"$CLI_TMP/install.out" 2>&1 </dev/null &&
     cmp -s "$CLI_TMP/bin/mdnest" mdnest; then
    pass "install command from the CLI tab installs this server's CLI"
  else
    fail "install command from the CLI tab failed"; cat "$CLI_TMP/install.out"; exit 1
  fi
  # Step "Connect": the login command, pasting a token at the prompt.
  if HOME="$CLI_TMP/home" \
     PTY_PROMPTS="$(printf 'Name for this server: \nToken (not shown): ')" \
     PTY_ANSWERS="$(printf 'e2e\n%s' "$API_TOKEN")" \
     python3 tests/pty-drive.py -- "$CLI_TMP/bin/mdnest" login "$BASE_URL" >"$CLI_TMP/login.out" 2>&1; then
    pass "connect command from the CLI tab logs in with a pasted token"
  else
    fail "connect command from the CLI tab failed"; sed 's/mdnest_[A-Za-z0-9_]*/mdnest_REDACTED/g' "$CLI_TMP/login.out"; exit 1
  fi
  if HOME="$CLI_TMP/home" "$CLI_TMP/bin/mdnest" servers 2>&1 | grep -q '@e2e' &&
     HOME="$CLI_TMP/home" "$CLI_TMP/bin/mdnest" list @e2e 2>&1 | grep -q testing_workspace; then
    pass "the installed CLI runs 'servers' and 'list' against this server"
  else
    fail "the installed CLI could not use the login"; exit 1
  fi
else
  log "python3 not present: skipping the install-and-login run"
fi
rm -rf "$CLI_TMP"

# ── Install Playwright + Chromium on demand ──────────────────────────────────
log "Preparing Playwright (installs Chromium on first run)"
e2e_playwright_ready "$LOGDIR" || { fail "Playwright setup failed (see $LOGDIR/playwright-*.log)"; KEEP=1; exit 1; }
pass "Playwright ready"

# ── Run the browser suite, one Playwright process per shard ─────────────────
# pw_run I ARGS...: playwright against shard I's stack.
pw_run() {
  local i="$1"; shift
  # shellcheck disable=SC2086
  cd tests/browser && \
    MDNEST_BASE_URL="${BASES[$i]}" \
    MDNEST_USER=e2e MDNEST_PASSWORD=e2epass123 \
    MDNEST_SEED_FILE="$SEED_FILE" MDNEST_SEED_TOKEN="$SEED_TOKEN" \
    MDNEST_MERMAID_FILE="$MERMAID_FILE" MDNEST_MERMAID_LABEL="$MERMAID_LABEL" \
    MDNEST_MERMAID_PALE="$MERMAID_PALE" MDNEST_MERMAID_EDGE="$MERMAID_EDGE" \
    MDNEST_BOARD_FILE="$BOARD_FILE" MDNEST_BOARD_TASK="$BOARD_TASK" \
    MDNEST_NOTES_DIR="${NOTES[$i]}" \
    npx playwright test "$@" ${MDNEST_E2E_ARGS:-} ${MDNEST_E2E_SPECS:-}
}
# shellcheck disable=SC2046
run_shard() { pw_run "$1" $(e2e_shard_args "$1" "$SHARDS") $(e2e_main_args "$BUDGET"); }
rc=0
if [ "$BUDGET" != only ]; then
  log "Running the browser suite on $SHARDS shard(s): ${BASES[*]}"
  e2e_run_shards "$SHARDS" "$LOGDIR" run_shard || rc=1
fi
if [ "$BUDGET" = after ] || [ "$BUDGET" = only ]; then
  # The timing-budget tests, alone on the first stack, with nothing else from
  # this run using the CPU.
  log "Running the @budget timing tests alone on ${BASES[0]}"
  # shellcheck disable=SC2046
  ( pw_run 0 $(e2e_quiet_args) ) || rc=1
fi
if [ "$rc" -eq 0 ]; then
  pass "BROWSER E2E: all specs passed"
  exit 0
else
  fail "BROWSER E2E: failures above (traces/screenshots in tests/browser-results)"
  exit 1
fi
