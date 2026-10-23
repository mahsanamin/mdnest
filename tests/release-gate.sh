#!/usr/bin/env bash
# release-gate.sh: everything a release must pass, run BEFORE pushing it.
#
#   bash tests/release-gate.sh              # gate the committed HEAD
#   MDNEST_GATE_ALL=1 bash tests/release-gate.sh   # also every optional suite
#
# Why a separate script: git opens the SSH connection to GitHub first and runs
# the pre-push hook after, so a hook that runs the full release tier (20+
# minutes) has its connection dropped before the push happens (v4.8.11). This
# script runs the same tier, and more, with no connection open. When every
# check passes it records the exact tree it tested in .git/mdnest-release-gate.
# The pre-push hook accepts a push to main or release/* only when the tree being
# pushed is that tree, so a release can no longer reach GitHub with a change
# made after the gate ran.
#
# What it runs:
#   1. the pre-push hook in release mode: builds, unit tests, CLI suites,
#      audits, govulncheck, version consistency, e2e-docker, e2e-sec-multi,
#      backend-image-init, e2e-browser
#   2. Go vet + go test -race WITH a real Redis (host Go, else Docker), so the
#      durability-queue tests run instead of skipping
#   3. shellcheck (host, else Docker)
#   4. e2e-collab-multi.sh always (live collaboration only runs in multi
#      mode), and the suites the changed files call for, compared with
#      origin/main:
#        backend/storage, deploy/helm, factory     -> e2e-ha-durability.sh
#        chat members, permission middleware       -> e2e-private-chats-multi.sh
#        transfer, download                        -> e2e-transfer-multi.sh
#      MDNEST_GATE_ALL=1 runs all four whatever changed.
#
# Needs docker and node. Exits 0 only if every step passed; nothing is recorded
# otherwise.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
STAMP="$(git rev-parse --git-path mdnest-release-gate)"
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-gate.XXXXXX")"
GO_VER="$(awk '/^go[[:space:]]/{print $2; exit}' backend/go.mod)"

pass=0; failed=0; ran=()
step() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; pass=$((pass + 1)); ran+=("$1"); }
bad()  { printf '  \033[31mFAIL\033[0m %s (log: %s)\n' "$1" "$2"; failed=$((failed + 1)); }
have() { command -v "$1" >/dev/null 2>&1; }

# The gate tests the working tree, and records HEAD's tree. They must be the
# same, or the record would vouch for code that was never tested.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first: the gate records the committed tree,"
  echo "so it must test exactly that."
  git status --short --untracked-files=no
  exit 1
fi
have docker && docker info >/dev/null 2>&1 || { echo "docker is required"; exit 2; }
have node || { echo "node is required"; exit 2; }

TREE="$(git rev-parse 'HEAD^{tree}')"
rm -f "$STAMP"
git fetch -q origin main 2>/dev/null || true
CHANGED="$(git diff --name-only origin/main...HEAD 2>/dev/null || git diff --name-only origin/main HEAD)"
echo "Gating $(git rev-parse --short HEAD) ($(echo "$CHANGED" | grep -c . ) files changed since origin/main). Logs: $LOGDIR"

run() { # name, log, command...
  local name="$1" log="$LOGDIR/$2"; shift 2
  step "$name"
  if "$@" >"$log" 2>&1; then ok "$name"; else bad "$name" "$log"; fi
}

# 1. The pre-push hook, in release mode, run here instead of inside a push.
hook_release() {
  printf 'HEAD %s refs/heads/release/gate 0000000000000000000000000000000000000000\n' "$(git rev-parse HEAD)" \
    | MDNEST_GATE_INNER=1 bash .githooks/pre-push
}
run "pre-push hook, release tier (builds, unit, CLI, audits, e2e-docker, e2e-sec-multi, image init, e2e-browser)" hook.log hook_release

# 2. Go with a real Redis.
go_suite() {
  if have go; then
    local rname="mdnest-gate-redis-$$"
    docker run -d --rm --name "$rname" -p 127.0.0.1:0:6379 redis:7-alpine >/dev/null || return 1
    local port; port="$(docker port "$rname" 6379/tcp | head -1 | sed 's/.*://')"
    sleep 1
    (cd backend && go vet ./... && MDNEST_TEST_REDIS_URL="redis://127.0.0.1:$port/15" go test -race -count=1 ./...)
    local rc=$?; docker rm -f "$rname" >/dev/null 2>&1; return $rc
  fi
  local net="mdnest-gate-$$" rname="mdnest-gate-redis-$$"
  docker network create "$net" >/dev/null || return 1
  docker run -d --rm --name "$rname" --network "$net" redis:7-alpine >/dev/null
  docker volume create mdnest-gomod >/dev/null; docker volume create mdnest-gobuild >/dev/null
  docker run --rm --network "$net" -e MDNEST_TEST_REDIS_URL="redis://$rname:6379/15" \
    -v "$REPO_ROOT/backend:/src" -v mdnest-gomod:/go/pkg/mod -v mdnest-gobuild:/root/.cache/go-build \
    -w /src "golang:$GO_VER" sh -c 'go vet ./... && go test -race -count=1 ./...'
  local rc=$?
  docker rm -f "$rname" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1
  return $rc
}
run "Go vet + go test -race, with Redis" go.log go_suite

# 3. shellcheck, the same files and severity as CI.
SC_FILES=(setup.sh mdnest-server mdnest git-sync/sync.sh install-cli.sh .githooks/pre-push tests/release-gate.sh)
shellcheck_suite() {
  if have shellcheck; then shellcheck -S error "${SC_FILES[@]}"; else
    docker run --rm -v "$REPO_ROOT:/mnt" -w /mnt koalaman/shellcheck:stable -S error "${SC_FILES[@]}"
  fi
}
run "shellcheck" shellcheck.log shellcheck_suite

# 4. The suites the changes call for.
wants() { [ "${MDNEST_GATE_ALL:-0}" = 1 ] || echo "$CHANGED" | grep -qE "$1"; }
optional() { # pattern, script, why
  if wants "$1"; then
    run "$2 ($3)" "$2.log" bash "tests/$2"
  else
    echo "  skip $2: nothing it covers changed"
  fi
}
optional '^backend/storage/|^deploy/helm/|^backend/main\.go' e2e-ha-durability.sh "HA writer, queue, leader"
# Always: live collaboration and shared editing exist only in multi mode, so
# this is the only suite that runs them, and a lockout of every Live note
# (v4.8.10 to v4.8.12, behind a proxy) needed no change to any file above.
run "e2e-collab-multi.sh (live collaboration and shared editing, multi mode)" e2e-collab-multi.sh.log bash tests/e2e-collab-multi.sh
optional 'chat_members|^backend/middleware/permission|^backend/store/chat' e2e-private-chats-multi.sh "private chats"
optional '^backend/handlers/(transfer|download|treecopy)' e2e-transfer-multi.sh "move, copy, download"

echo
echo "=== release gate: $pass passed, $failed failed ==="
if [ "$failed" -ne 0 ]; then
  echo "Nothing recorded. Fix the failures and run the gate again."
  exit 1
fi
printf '%s %s %s\n' "$TREE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(IFS=,; echo "${ran[*]}" | tr ' ' '_')" > "$STAMP"
echo "Recorded: tree $TREE passed. Push the release branch now; the hook will accept exactly this tree."
