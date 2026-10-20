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
# Needs:  docker, node, curl, python3. Exit 0 if every spec passes, 2 if a
#         prerequisite is missing.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

BE_IMAGE="mdnest-e2e-backend:test"
FE_IMAGE="mdnest-e2e-frontend:test"
SFX="$$"
NET="mdnest-e2e-collab-net-$SFX"
PG="mdnest-e2e-collab-pg-$SFX"
BE="mdnest-e2e-collab-be-$SFX"
FE="mdnest-e2e-collab-fe-$SFX"
# Under the repo, not /tmp: the Docker VM may not see the host's temp dir.
NOTES_DIR="$(mktemp -d "$REPO_ROOT/.e2e-notes.XXXXXX")"

fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }

cleanup() {
  if [ -n "${KEEP_LOGS:-}" ]; then docker logs "$BE" >"$KEEP_LOGS" 2>&1 || true; fi
  docker rm -f "$FE" "$BE" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$NOTES_DIR" "$NOTES_DIR.cli"
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
docker build -t "$BE_IMAGE" "$BUILD_ROOT/backend/" >/tmp/mdnest-e2e-collab-be.log 2>&1 \
  || { fail "backend build failed"; tail -30 /tmp/mdnest-e2e-collab-be.log; exit 1; }
docker build --build-context cli="$BUILD_ROOT" -t "$FE_IMAGE" "$BUILD_ROOT/frontend/" >/tmp/mdnest-e2e-collab-fe.log 2>&1 \
  || { fail "frontend build failed"; tail -30 /tmp/mdnest-e2e-collab-fe.log; exit 1; }
pass "images built"

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

log "Preparing Playwright"
( cd tests/browser
  [ -d node_modules ] || npm install --no-audit --no-fund >/tmp/mdnest-pw-npm.log 2>&1
  npx playwright install chromium >/tmp/mdnest-pw-browser.log 2>&1
) || { fail "Playwright setup failed (see /tmp/mdnest-pw-*.log)"; exit 1; }

log "Running the two-user specs against $BASE"
# shellcheck disable=SC2086
if ( cd tests/browser && \
     MDNEST_BASE_URL="$BASE" \
     MDNEST_USER=alice MDNEST_PASSWORD=alicepass123 \
     MDNEST_USER2=bob MDNEST_PASSWORD2=bobpass123 \
     MDNEST_NOTES_DIR="$NOTES_DIR" \
     MDNEST_CLI="$REPO_ROOT/mdnest" MDNEST_CLI_HOMES="$CLI_DIR" \
     npx playwright test ${MDNEST_E2E_SPECS:-collab-shared-editing.spec.js collab-cli.spec.js presence.spec.js} ); then
  pass "COLLAB E2E: all specs passed"
  exit 0
else
  fail "COLLAB E2E: failures above (traces in tests/browser/test-results)"
  exit 1
fi
