#!/usr/bin/env bash
# check.sh: the three test levels, from quick to complete.
#
#   bash tests/check.sh                    # --level develop (the default)
#   bash tests/check.sh --level iterate    # while working on a branch
#   bash tests/check.sh --level develop    # before merging into develop
#   bash tests/check.sh --level ship       # a release; same as tests/release-gate.sh
#
# iterate (target: under 5 minutes). Only what the change touches, each run
#   once: go vet + go test -race for the backend packages that changed,
#   npm test if frontend/ changed, cli-unit.sh if the CLI changed, and the
#   browser specs named in MDNEST_E2E_SPECS (on tests/e2e-browser.sh, or on
#   tests/e2e-collab-multi.sh with MDNEST_E2E_HARNESS=collab). No full suites.
#
# develop (target: about 15 to 20 minutes). Before a branch is merged into
#   develop: the pre-push hook's fast tier, go vet + go test -race on the whole
#   backend with a real Redis, shellcheck, and the end-to-end suites picked by
#   the files changed since origin/develop, each run once, sharded. Nothing is
#   recorded.
#
# ship. The release gate, the only level that runs everything: the hook's
#   release tier, Go with Redis, shellcheck and every end-to-end suite
#   (MDNEST_GATE_ALL=1 is implied), compared with origin/main. It refuses a
#   dirty tree and, when every check passed, records the tree it tested in
#   .git/mdnest-release-gate. The pre-push hook accepts a push to main or
#   release/* only for that tree (git opens the SSH connection before the hook
#   runs, and GitHub drops it after about 10 minutes, so the hook cannot run
#   this itself). Upgrade checks when stored data changed are still a manual
#   step of md-ship.
#
# develop and ship build the e2e images once (tagged by the tree's hash, see
# tests/lib/e2e-images.sh) and run two lanes side by side: the browser lane
# (e2e-browser, then e2e-collab-multi, each sharded) and the other lane
# (everything without a browser). Timing-budget tests (@budget) run last,
# alone, once both lanes are done. MDNEST_GATE_LANES=1 runs the lanes one
# after the other.
#
# Needs docker and node (iterate needs docker only for browser specs). Exits 0
# only if every check passed.
set -uo pipefail

LEVEL=develop
while [ $# -gt 0 ]; do
  case "$1" in
    --level) LEVEL="${2:-}"; shift 2 ;;
    --level=*) LEVEL="${1#--level=}"; shift ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)"; exit 2 ;;
  esac
done
case "$LEVEL" in
  iterate|develop|ship) ;;
  *) echo "unknown level: $LEVEL (iterate, develop or ship)"; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
STAMP="$(git rev-parse --git-path mdnest-release-gate)"
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-check.XXXXXX")"
GO_VER="$(awk '/^go[[:space:]]/{print $2; exit}' backend/go.mod)"

pass=0; failed=0; ran=()
step() { printf '\033[36m==>\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# shellcheck source=tests/lib/e2e-images.sh
. "$REPO_ROOT/tests/lib/e2e-images.sh"

if [ "$LEVEL" = ship ]; then
  # The gate tests the working tree, and records HEAD's tree. They must be the
  # same, or the record would vouch for code that was never tested.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Commit or stash your changes first: the gate records the committed tree,"
    echo "so it must test exactly that."
    git status --short --untracked-files=no
    exit 1
  fi
  BASE=main
  rm -f "$STAMP"
else
  BASE=develop
fi
if [ "$LEVEL" != iterate ]; then
  have docker && docker info >/dev/null 2>&1 || { echo "docker is required"; exit 2; }
  have node || { echo "node is required"; exit 2; }
fi

git fetch -q origin "$BASE" 2>/dev/null || true
CHANGED="$(git diff --name-only "origin/$BASE...HEAD" 2>/dev/null || git diff --name-only "origin/$BASE" HEAD)"
if [ "$LEVEL" != ship ]; then
  # Below ship, uncommitted and untracked work counts too: it is what is
  # being tested.
  CHANGED="$(printf '%s\n%s\n%s\n' "$CHANGED" "$(git diff --name-only HEAD)" \
    "$(git ls-files --others --exclude-standard)" | grep . | sort -u)"
fi
echo "Level $LEVEL on $(git rev-parse --short HEAD) ($(echo "$CHANGED" | grep -c .) files changed since origin/$BASE). Logs: $LOGDIR"

# run NAME LOG COMMAND...: run one check, record its exit code next to its log.
# Results are read back from those files, because the checks run in two
# background lanes and a subshell cannot update this shell's counters.
run() {
  local name="$1" log="$LOGDIR/$2" t0=$SECONDS rc; shift 2
  step "$name"
  "$@" >"$log" 2>&1; rc=$?
  # SOFT=1: a failure is a warning (rc 3), counted in neither total.
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ] && [ "${SOFT:-0}" = 1 ]; then
    printf '  \033[33mWARN\033[0m %s failed at load %s, not blocking at this level (log: %s)\n' \
      "$name" "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo unknown)" "$log"
    printf '%s\n' "$name" >"$log.name"; echo 3 >"$log.rc"
    return 0
  fi
  printf '%s\n' "$name" >"$log.name"; echo "$rc" >"$log.rc"
  case "$rc" in
    0) printf '  \033[32mPASS\033[0m %s (%ds)\n' "$name" "$((SECONDS - t0))" ;;
    2) printf '  \033[33mSKIP\033[0m %s, prerequisites missing (log: %s)\n' "$name" "$log" ;;
    *) printf '  \033[31mFAIL\033[0m %s (%ds, log: %s)\n' "$name" "$((SECONDS - t0))" "$log" ;;
  esac
  return 0
}

# wants PATTERN: does this level run the check guarded by PATTERN? ship runs
# everything; the other levels only what the changed files call for.
wants() { [ "$LEVEL" = ship ] || [ "${MDNEST_GATE_ALL:-0}" = 1 ] || echo "$CHANGED" | grep -qE "$1"; }
suite() { # pattern, script, why
  if wants "$1"; then
    run "$2 ($3)" "$2.log" env "${@:4}" bash "tests/$2"
  else
    echo "  skip $2: nothing it covers changed"
  fi
}

# A change to the shared e2e library or a harness reruns the suites using it.
LIB='^tests/lib/'

# Go with a real Redis. PKGS (default ./...) limits which packages run.
go_suite() {
  local pkgs="${PKGS:-./...}"
  if have go; then
    local rname="mdnest-gate-redis-$$"
    docker run -d --rm --name "$rname" -p 127.0.0.1:0:6379 redis:7-alpine >/dev/null || return 1
    local port; port="$(docker port "$rname" 6379/tcp | head -1 | sed 's/.*://')"
    sleep 1
    # shellcheck disable=SC2086
    (cd backend && go vet $pkgs && MDNEST_TEST_REDIS_URL="redis://127.0.0.1:$port/15" go test -race -count=1 $pkgs)
    local rc=$?; docker rm -f -v "$rname" >/dev/null 2>&1; return $rc
  fi
  local net="mdnest-gate-$$" rname="mdnest-gate-redis-$$"
  docker network create "$net" >/dev/null || return 1
  docker run -d --rm --name "$rname" --network "$net" redis:7-alpine >/dev/null
  docker volume create mdnest-gomod >/dev/null; docker volume create mdnest-gobuild >/dev/null
  docker run --rm --network "$net" -e MDNEST_TEST_REDIS_URL="redis://$rname:6379/15" \
    -v "$REPO_ROOT/backend:/src" -v mdnest-gomod:/go/pkg/mod -v mdnest-gobuild:/root/.cache/go-build \
    -w /src "golang:$GO_VER" sh -c "go vet $pkgs && go test -race -count=1 $pkgs"
  local rc=$?
  docker rm -f -v "$rname" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1
  return $rc
}

# Tally the recorded results and print the summary line. Returns non-zero when
# anything failed.
tally() {
  local rcfile name
  for rcfile in "$LOGDIR"/*.rc; do
    [ -e "$rcfile" ] || continue
    name="$(cat "${rcfile%.rc}.name")"
    case "$(cat "$rcfile")" in
      0) pass=$((pass + 1)); ran+=("$name") ;;
      2) ;;  # reported as SKIP above, as the hook always has
      3) ;;  # reported as WARN above (SOFT=1)
      *) failed=$((failed + 1)) ;;
    esac
  done
  echo
  echo "=== $LEVEL check: $pass passed, $failed failed ==="
  [ "$failed" -eq 0 ]
}

# ── iterate ──────────────────────────────────────────────────────────────────
if [ "$LEVEL" = iterate ]; then
  t0=$SECONDS
  PKGS="$(echo "$CHANGED" | grep -E '^backend/.*\.go$' | sed -E 's|^backend/||; s|/[^/]*$||; s|^[^/]*\.go$|.|' \
    | sort -u | sed 's|^|./|; s|^\./\.$|.|' | tr '\n' ' ')"
  if [ -n "$PKGS" ]; then
    run "go vet + go test -race ($PKGS)" go.log go_suite
  else
    echo "  skip Go: no backend Go file changed"
  fi
  if echo "$CHANGED" | grep -q '^frontend/'; then
    e2e_npm_ready frontend "$LOGDIR/npm-ci.log" || { echo "  npm ci failed in frontend (log: $LOGDIR/npm-ci.log)"; exit 1; }
    run "frontend npm test" frontend.log sh -c 'cd frontend && npm test --silent'
  else
    echo "  skip npm test: nothing in frontend/ changed"
  fi
  if echo "$CHANGED" | grep -qE '^mdnest$|^tests/cli-unit\.sh$'; then
    run "cli-unit.sh" cli-unit.log bash tests/cli-unit.sh
  fi
  if echo "$CHANGED" | grep -qE '^tests/lib/|^tests/e2e-lib-unit\.sh$'; then
    run "e2e-lib-unit.sh" e2e-lib-unit.log bash tests/e2e-lib-unit.sh
  fi
  if [ -n "${MDNEST_E2E_SPECS:-}" ]; then
    harness=e2e-browser.sh
    [ "${MDNEST_E2E_HARNESS:-browser}" = collab ] && harness=e2e-collab-multi.sh
    run "$harness: $MDNEST_E2E_SPECS" e2e.log bash "tests/$harness"
  else
    echo "  no browser specs: name the feature's specs in MDNEST_E2E_SPECS to run them"
  fi
  echo "  done ($((SECONDS - t0))s)"
  tally; exit $?
fi

# ── develop and ship ─────────────────────────────────────────────────────────
# The hook's lock-file checks (npm ls) compare against what is installed, so
# a missing install (a fresh worktree) or a stale one (node_modules from
# before a lock change) would read as a lock problem. e2e_npm_ready runs
# npm ci in either case; npm ci refuses a lock file out of step with
# package.json, so a real lock problem still fails here, with npm's message.
for d in frontend mcp-server tests/browser; do
  e2e_npm_ready "$d" "$LOGDIR/npm-ci-${d//\//-}.log" \
    || { echo "  npm ci failed in $d: the lock file does not match package.json, or the registry is unreachable (log: $LOGDIR/npm-ci-${d//\//-}.log)"; exit 1; }
done

# Which end-to-end suites this run needs. ship takes all of them.
BROWSER_PAT="^frontend/|^backend/|^mdnest$|^tests/browser/|^tests/e2e-browser\.sh$|$LIB"
COLLAB_PAT="^frontend/src/(App\.jsx|sharedDoc|sharedText|sharedEligible|collab|echo-gate|frontMatter|caret|api\.js)|^frontend/src/components/(LiveEditor|live-editor|Editor\.jsx)|^backend/collab/|^backend/handlers/(notes|ws|config)|^backend/main\.go|^mdnest$|^tests/browser/(collab|presence|shared|cli-vs-typing|live-)|^tests/e2e-collab-multi\.sh$|$LIB"

# Build the two images once. Every suite below finds them by the tree's hash
# and skips its own build (tests/lib/e2e-images.sh).
if wants "$BROWSER_PAT|$COLLAB_PAT|^backend/|^mdnest$|^tests/e2e-"; then
  step "Building the e2e images for this tree"
  t0=$SECONDS
  e2e_backend_image "$REPO_ROOT" "$LOGDIR" >/dev/null && e2e_frontend_image "$REPO_ROOT" "$LOGDIR" >/dev/null \
    && e2e_playwright_ready "$LOGDIR" \
    || { echo "  image build or Playwright setup failed, logs in $LOGDIR"; exit 1; }
  echo "  ready ($((SECONDS - t0))s)"
fi

# The pre-push hook. ship runs its release tier (its end-to-end suites run in
# the lanes below instead of inside the hook); develop runs the fast tier a
# feature-branch push runs.
hook_tier() {
  local ref=refs/heads/feature/check
  [ "$LEVEL" = ship ] && ref=refs/heads/release/gate
  printf 'HEAD %s %s 0000000000000000000000000000000000000000\n' "$(git rev-parse HEAD)" "$ref" \
    | MDNEST_GATE_INNER=1 MDNEST_GATE_SUITES_OUTSIDE=1 bash .githooks/pre-push
}

# Shell lint (shellcheck), the same files and severity as CI.
SC_FILES=(setup.sh mdnest-server mdnest git-sync/sync.sh install-cli.sh .githooks/pre-push
  tests/release-gate.sh tests/check.sh tests/lib/e2e-images.sh)
shellcheck_suite() {
  if have shellcheck; then shellcheck -S error "${SC_FILES[@]}"; else
    docker run --rm -v "$REPO_ROOT:/mnt" -w /mnt koalaman/shellcheck:stable -S error "${SC_FILES[@]}"
  fi
}

# Two lanes run side by side. The browser lane holds the two Playwright
# harnesses (each already split into shards); the other lane holds everything
# that needs no browser. Inside a lane the checks run one after another, so the
# machine never runs more than one browser harness at a time.
browser_lane() {
  suite "$BROWSER_PAT" e2e-browser.sh "UI, single mode" MDNEST_E2E_BUDGET=skip
  # ship always runs this: live collaboration and shared editing exist only in
  # multi mode, so it is the only suite that runs them, and a lockout of every
  # Live note (v4.8.10 to v4.8.12, behind a proxy) needed no change to any
  # file it watches.
  suite "$COLLAB_PAT" e2e-collab-multi.sh "live collaboration and shared editing, multi mode" MDNEST_E2E_BUDGET=skip
}
other_lane() {
  run "pre-push hook, $([ "$LEVEL" = ship ] && echo release || echo fast) tier (builds, unit, CLI, audits)" hook.log hook_tier
  run "Go vet + go test -race, with Redis" go.log go_suite
  run "shellcheck" shellcheck.log shellcheck_suite
  suite "^mdnest$|^backend/|^tests/e2e-docker\.sh$|^tests/cli-smoke-test\.sh$|$LIB" e2e-docker.sh "CLI against the backend, host and bare alpine"
  suite "^backend/(middleware|handlers|store|relpath|storage|collab)/|^backend/main\.go$|^tests/e2e-sec-multi\.sh$|$LIB" e2e-sec-multi.sh "multi-mode access"
  suite "^backend/Dockerfile$|^backend/gitproc/|^tests/backend-image-init\.sh$|$LIB" backend-image-init.sh "tini reaps orphans"
  suite "^backend/storage/|^deploy/helm/|^backend/main\.go$|^tests/e2e-ha-durability\.sh$|$LIB" e2e-ha-durability.sh "HA writer, queue, leader"
  suite "chat_members|^backend/middleware/permission|^backend/store/chat|^tests/e2e-private-chats-multi\.sh$|$LIB" e2e-private-chats-multi.sh "private chats"
  suite "^backend/handlers/(transfer|download|treecopy)|^tests/e2e-transfer-multi\.sh$|$LIB" e2e-transfer-multi.sh "move, copy, download"
}
t0=$SECONDS
if [ "${MDNEST_GATE_LANES:-2}" = 1 ]; then
  other_lane; browser_lane
else
  browser_lane & bpid=$!
  other_lane
  wait "$bpid"
fi
echo "  parallel part done ($((SECONDS - t0))s)"

# The timing-budget tests (@budget, see tests/lib/e2e-images.sh), last and
# alone: they compare against a fixed number of milliseconds, so they only
# mean something once nothing else from this run is using the CPU. They also
# react to load from anything else on the machine, so:
#   ship     runs them always, and a failure blocks the release;
#   develop  runs them only when the diff touches a @budget spec or the code
#            one of them times (BUDGET_CODE_PAT), and a failure is a warning
#            showing the machine's load, since ship runs them again.
# When you tag a new test @budget, add the code it times to BUDGET_CODE_PAT.
BUDGET_CODE_PAT='^frontend/src/(chat\.js|components/Chat|collab\.js|sharedDoc\.js|App\.jsx|components/LiveEditorCrepe\.jsx)'
BUDGET_SPECS="$(grep -l "tag: '@budget'" tests/browser/*.spec.js 2>/dev/null | tr '\n' '|' | sed 's/|$//; s/\./\\./g')"
budget_wanted() {
  [ "$LEVEL" = ship ] && return 0
  echo "$CHANGED" | grep -qE "$BUDGET_CODE_PAT${BUDGET_SPECS:+|^($BUDGET_SPECS)\$}"
}
budget_soft=1; [ "$LEVEL" = ship ] && budget_soft=0
t0=$SECONDS
if budget_wanted; then
  if wants "$BROWSER_PAT"; then
    SOFT=$budget_soft run "@budget timing tests, single mode (alone)" budget-browser.log \
      env MDNEST_E2E_BUDGET=only MDNEST_E2E_SHARDS=1 bash tests/e2e-browser.sh
  fi
  if wants "$COLLAB_PAT"; then
    SOFT=$budget_soft run "@budget timing tests, multi mode (alone)" budget-collab.log \
      env MDNEST_E2E_BUDGET=only MDNEST_E2E_SHARDS=1 bash tests/e2e-collab-multi.sh
  fi
else
  echo "  skip @budget timing tests: the diff touches no @budget spec and none of the code they time"
fi
echo "  quiet part done ($((SECONDS - t0))s)"

if ! tally; then
  [ "$LEVEL" = ship ] && echo "Nothing recorded. Fix the failures and run the gate again."
  exit 1
fi
if [ "$LEVEL" = ship ]; then
  TREE="$(git rev-parse 'HEAD^{tree}')"
  printf '%s %s %s\n' "$TREE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(IFS=,; echo "${ran[*]}" | tr ' ' '_')" > "$STAMP"
  echo "Recorded: tree $TREE passed. Push the release branch now; the hook will accept exactly this tree."
fi
exit 0
