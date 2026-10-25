#!/usr/bin/env bash
#
# Shared editing in a real two-user setup
# ───────────────────────────────────────
# The single-mode browser stack (tests/e2e-browser.sh) has one account and no
# second person, so nothing there can show two people typing into one note.
# This boots Postgres, the backend and the nginx frontend from the working
# tree in multi mode with ENABLE_LIVE_COLLAB=true, creates two accounts with
# write access to testing_workspace, and runs the two-browser specs against
# them. The notes folder is on the host, so a spec can check the bytes on disk.
#
# Usage:  tests/e2e-collab-multi.sh            (runs the collab-*.spec.js + presence)
#         MDNEST_E2E_SPECS=collab-shared-editing.spec.js tests/e2e-collab-multi.sh
#         MDNEST_E2E_SHARDS=1 tests/e2e-collab-multi.sh   (one stack, the old run)
#         MDNEST_E2E_ARGS="--repeat-each 3"   (extra playwright arguments)
#
# Shards: the specs are split across MDNEST_E2E_SHARDS stacks (default: one
# per 3 CPUs, at most 3). Each shard has its own Postgres, backend, nginx,
# notes folder, alice and bob and CLI logins, with one Playwright worker, so
# no two specs ever share a server or an account.
# Needs:  docker, node, curl, python3. Exit 0 if every spec passes, 2 if a
#         prerequisite is missing.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# shellcheck source=tests/lib/e2e-images.sh
. "$REPO_ROOT/tests/lib/e2e-images.sh"
SFX="$$"
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-e2e-collab.XXXXXX")"
# Per shard: names carry the run's pid and the shard number. The notes folders
# are under the repo, not /tmp: the Docker VM may not see the host's temp dir.
PGS=(); BES=(); FES=(); NETS=(); NOTES=(); BASES=()

fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }

cleanup() {
  local i
  for i in "${!BES[@]}"; do
    # KEEP_LOGS=FILE saves the backend log; with shards, FILE.2, FILE.3, ...
    # hold the other shards' logs.
    if [ -n "${KEEP_LOGS:-}" ]; then
      docker logs "${BES[$i]}" >"$KEEP_LOGS$([ "$i" -gt 0 ] && echo ".$((i + 1))")" 2>&1 || true
    fi
    docker rm -f -v "${FES[$i]}" "${BES[$i]}" "${PGS[$i]}" >/dev/null 2>&1 || true
    docker network rm "${NETS[$i]}" >/dev/null 2>&1 || true
    e2e_rm_dirs "${NOTES[$i]}" "${NOTES[$i]}.cli"
  done
  rm -rf "$LOGDIR"
  return 0
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { fail "docker is required"; exit 2; }
command -v node >/dev/null 2>&1 || { fail "node is required for Playwright"; exit 2; }
command -v python3 >/dev/null 2>&1 || { fail "python3 is required"; exit 2; }

# MDNEST_BUILD_ROOT builds the app from another checkout (an older release
# in a throwaway worktree, say) while the specs, the CLI and this script stay
# the current ones. MDNEST_E2E_BACKEND_ENV adds backend settings, for example
# "SHARED_EDITING=false".
BUILD_ROOT="${MDNEST_BUILD_ROOT:-$REPO_ROOT}"
EXTRA_ENV=()
for kv in ${MDNEST_E2E_BACKEND_ENV:-}; do EXTRA_ENV+=(-e "$kv"); done
log "Building backend + frontend images from $BUILD_ROOT"
# Tagged by a hash of that tree (tests/lib/e2e-images.sh): a tree already
# built, by this harness or another, is reused.
BE_IMAGE="$(e2e_backend_image "$BUILD_ROOT" "$LOGDIR")" || { fail "backend build failed"; exit 1; }
FE_IMAGE="$(e2e_frontend_image "$BUILD_ROOT" "$LOGDIR")" || { fail "frontend build failed"; exit 1; }
pass "images ready: $BE_IMAGE, $FE_IMAGE"

DEFAULT_SPECS="collab-shared-editing.spec.js collab-cli.spec.js presence.spec.js shared-unavailable.spec.js live-never-blocks.spec.js content-loss.spec.js"
# shellcheck disable=SC2086
SHARDS="$(e2e_cap_shards "$(e2e_shards)" ${MDNEST_E2E_SPECS:-$DEFAULT_SPECS})"
BUDGET="$(e2e_budget_mode)"
if [ "$BUDGET" = only ]; then
  e2e_playwright_ready "$LOGDIR" || { fail "Playwright setup failed"; exit 1; }
  # shellcheck disable=SC2086
  e2e_has_budget ${MDNEST_E2E_SPECS:-$DEFAULT_SPECS} || { pass "no @budget tests in the selected specs, nothing to run"; exit 0; }
fi

# boot_shard I: Postgres, backend and nginx for shard I, then alice and bob
# with write access and a CLI login each.
boot_shard() {
  local i="$1"
  NET="mdnest-e2e-collab-net-$SFX-$i"; PG="mdnest-e2e-collab-pg-$SFX-$i"
  BE="mdnest-e2e-collab-be-$SFX-$i"; FE="mdnest-e2e-collab-fe-$SFX-$i"
  NOTES_DIR="$(e2e_notes_dir "$REPO_ROOT")"
  PGS[i]="$PG"; BES[i]="$BE"; FES[i]="$FE"; NETS[i]="$NET"; NOTES[i]="$NOTES_DIR"

  mkdir -p "$NOTES_DIR/testing_workspace"
  chmod -R a+rwX "$NOTES_DIR"
  docker network create "$NET" >/dev/null
  docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=mdnest -e POSTGRES_PASSWORD=pw \
    -e POSTGRES_DB=mdnest postgres:16-alpine >/dev/null
  for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U mdnest >/dev/null 2>&1 && break; sleep 1; done

  docker run -d --name "$BE" --network "$NET" --network-alias backend \
    -e AUTH_MODE=multi -e POSTGRES_HOST="$PG" -e POSTGRES_PASSWORD=pw \
    -e MDNEST_USER=admin -e MDNEST_PASSWORD=adminpass123 -e MDNEST_JWT_SECRET=e2e-collab-secret \
    -e NOTES_DIR=/notes -e FRONTEND_ORIGIN=http://localhost \
    -e ENABLE_LIVE_COLLAB=true -e ENABLE_AGENT_APPROVALS=true ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} \
    -v "$NOTES_DIR:/notes" "$BE_IMAGE" >/dev/null
  docker run -d --name "$FE" --network "$NET" -p 127.0.0.1:0:80 "$FE_IMAGE" >/dev/null
  PORT="$(docker port "$FE" 80/tcp | head -1 | sed 's/.*://')"
  BASE="http://127.0.0.1:$PORT"
  for _ in $(seq 1 60); do curl -fsS "$BASE/api/config" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "$BASE/api/config" | tr -d ' ' | grep -q '"liveCollab":true' \
    || { fail "stack not healthy or live collab off"; docker logs "$BE" | tail -30; exit 1; }
  pass "multi-mode stack with live collab at $BASE"

  # Two collaborators with write access to testing_workspace. An invited account
  # must change its password at first sign-in; do that here so the browser signs
  # in straight to the app with the final password.
  # Each account also gets an API token and a CLI login in its own HOME, so a
  # spec can drive the real ./mdnest at a note open in a browser.
  CLI_DIR="$NOTES_DIR.cli"
  mkdir -p "$CLI_DIR"
  BASE="$BASE" CLI_DIR="$CLI_DIR" python3 - <<'PY' || { fail "could not seed users"; exit 1; }
import json, os, urllib.request, urllib.error
BASE = os.environ["BASE"]
def call(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data: req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, e.read().decode(errors="replace")
def login(user, pw, final):
    code, r = call("POST", "/api/auth/login", body={"username": user, "password": pw})
    if isinstance(r, dict) and r.get("status") == "change_password_required":
        code, r = call("POST", "/api/auth/change-password-forced", body={"tempToken": r["tempToken"], "newPassword": final})
    assert isinstance(r, dict) and r.get("token"), f"login {user}: {code} {r}"
    return r["token"]
admin = login("admin", "adminpass123", "adminpass123")
for name in ("alice", "bob"):
    code, r = call("POST", "/api/admin/invite", admin, {"email": f"{name}@e2e.local", "username": name, "password": name + "temp123", "role": "collaborator"})
    assert code in (200, 201), f"invite {name}: {code} {r}"
code, users = call("GET", "/api/admin/users", admin)
ids = {u["username"]: u["id"] for u in (users if isinstance(users, list) else users.get("users", []))}
for name in ("alice", "bob"):
    code, r = call("POST", "/api/admin/grants", admin, {"user_id": ids[name], "namespace": "testing_workspace", "path": "/", "permission": "write"})
    assert code in (200, 201), f"grant {name}: {code} {r}"
    tok = login(name, name + "temp123", name + "pass123")
    code, r = call("POST", "/api/auth/tokens", tok, {"name": "e2e-cli"})
    assert code in (200, 201) and isinstance(r, dict) and r.get("token"), f"token {name}: {code} {r}"
    with open(os.path.join(os.environ["CLI_DIR"], name + ".token"), "w") as f:
        f.write(r["token"])
print("seeded alice + bob")
PY
  pass "two collaborators seeded"
  for name in alice bob; do
    mkdir -p "$CLI_DIR/$name-home"
    HOME="$CLI_DIR/$name-home" ./mdnest login "@$name" "$BASE" "$(cat "$CLI_DIR/$name.token")" >/dev/null 2>&1 \
      || { fail "CLI login for $name failed"; exit 1; }
  done
  pass "CLI logged in as alice (@alice) and bob (@bob)"
  BASES[i]="$BASE"
  return 0
}

for ((s = 0; s < SHARDS; s++)); do
  log "Shard $((s + 1)) of $SHARDS"
  boot_shard "$s" || exit 1
done

log "Preparing Playwright"
e2e_playwright_ready "$LOGDIR" || { fail "Playwright setup failed"; cat "$LOGDIR"/playwright-*.log; exit 1; }

# pw_run I ARGS...: playwright against shard I's stack.
pw_run() {
  local i="$1"; shift
  # shellcheck disable=SC2086
  cd tests/browser && \
    MDNEST_BASE_URL="${BASES[$i]}" \
    MDNEST_USER=alice MDNEST_PASSWORD=alicepass123 \
    MDNEST_USER2=bob MDNEST_PASSWORD2=bobpass123 \
    MDNEST_NOTES_DIR="${NOTES[$i]}" MDNEST_BACKEND_CONTAINER="${BES[$i]}" \
    MDNEST_CLI="$REPO_ROOT/mdnest" MDNEST_CLI_HOMES="${NOTES[$i]}.cli" \
    npx playwright test "$@" ${MDNEST_E2E_ARGS:-} ${MDNEST_E2E_SPECS:-$DEFAULT_SPECS}
}
# shellcheck disable=SC2046
run_shard() { pw_run "$1" $(e2e_shard_args "$1" "$SHARDS") $(e2e_main_args "$BUDGET"); }
rc=0
if [ "$BUDGET" != only ]; then
  log "Running the two-user specs on $SHARDS shard(s): ${BASES[*]}"
  e2e_run_shards "$SHARDS" "$LOGDIR" run_shard || rc=1
fi
if [ "$BUDGET" = after ] || [ "$BUDGET" = only ]; then
  # The timing-budget tests, alone on the first stack (see e2e_budget_mode).
  log "Running the @budget timing tests alone on ${BASES[0]}"
  # shellcheck disable=SC2046
  ( pw_run 0 $(e2e_quiet_args) ) || rc=1
fi
if [ "$rc" -eq 0 ]; then
  pass "COLLAB E2E: all specs passed"
  exit 0
else
  fail "COLLAB E2E: failures above (traces in tests/browser-results)"
  exit 1
fi
