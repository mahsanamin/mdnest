#!/usr/bin/env bash
# e2e-ha-durability.sh: the git-native HA topology (issue #147), end to end.
#
# Builds the backend from the working tree (or MDNEST_BUILD_ROOT=<checkout>),
# then runs Redis, one MDNEST_ROLE=writer and one MDNEST_ROLE=app replica, and
# checks the two things that caused a write outage before v4.8.11:
#
#   1. The durability stream only holds what the writer has not applied yet.
#      A burst of appends through the app replica lands on the writer's disk,
#      and the stream goes back to zero entries.
#   2. A writer that loses its lock while Redis is out of memory wins it back
#      on its own, without a restart, and applies the next save.
#
# Needs docker. Not in the pre-push hook; run it when touching backend/storage
# (queue, writer, leader) or the HA wiring. Exit 2 = docker missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="${MDNEST_BUILD_ROOT:-$REPO_ROOT}"
TAG="mdnest-ha-e2e-$$"
# shellcheck source=tests/lib/e2e-images.sh
. "$REPO_ROOT/tests/lib/e2e-images.sh"
BUILD_LOGS="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-e2e-build.XXXXXX")"
NET="$TAG"
REDIS="$TAG-redis"; WRITER="$TAG-writer"; APP="$TAG-app"
# Docker Desktop only shares some host folders, so keep the notes next to the repo.
NOTES_DIR="$(mktemp -d "$REPO_ROOT/../.mdnest-ha-e2e.XXXXXX")"
MESSAGES="${MDNEST_HA_MESSAGES:-300}"

pass=0; failed=0
log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; failed=$((failed + 1)); }

cleanup() {
  rm -rf "$BUILD_LOGS"
  docker rm -f -v "$APP" "$WRITER" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  e2e_rm_dirs "$NOTES_DIR"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "docker is required"; exit 2; }

log "Building the backend from $BUILD_ROOT"
IMAGE="$(e2e_backend_image "$BUILD_ROOT" "$BUILD_LOGS")"
docker network create "$NET" >/dev/null
mkdir -p "$NOTES_DIR/team"

rcli() { docker exec "$REDIS" redis-cli "$@"; }
docker run -d --name "$REDIS" --network "$NET" redis:7-alpine >/dev/null
for _ in $(seq 1 30); do rcli ping >/dev/null 2>&1 && break; sleep 0.5; done

common=(-e AUTH_MODE=single -e MDNEST_USER=e2e -e MDNEST_PASSWORD=e2epass123
        -e MDNEST_JWT_SECRET=e2e-ha-secret -e NOTES_DIR=/notes -e FRONTEND_ORIGIN=http://localhost
        -e STORAGE_BACKEND=git -e REDIS_URL="redis://$REDIS:6379/0" -e MDNEST_WRITER_LOCK_TTL=2s)
docker run -d --name "$WRITER" --hostname "$WRITER" --network "$NET" "${common[@]}" \
  -e MDNEST_ROLE=writer -v "$NOTES_DIR:/notes" "$IMAGE" >/dev/null
docker run -d --name "$APP" --hostname "$APP" --network "$NET" "${common[@]}" \
  -e MDNEST_ROLE=app -e WRITER_URL="http://$WRITER:8080" -p 127.0.0.1:0:8080 "$IMAGE" >/dev/null
BASE="http://127.0.0.1:$(docker port "$APP" 8080/tcp | head -1 | sed 's/.*://')"

for _ in $(seq 1 60); do curl -fsS "$BASE/api/config" >/dev/null 2>&1 && break; sleep 0.5; done
for _ in $(seq 1 60); do [ "$(rcli get mdnest:writer:leader)" = "$WRITER" ] && break; sleep 0.5; done
[ "$(rcli get mdnest:writer:leader)" = "$WRITER" ] && ok "writer holds the lock" || { bad "writer never became leader"; docker logs "$WRITER" | tail -20; exit 1; }

TOKEN="$(curl -fsS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"e2e","password":"e2epass123"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { bad "could not log in"; exit 1; }
api() { curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$@"; }

on_disk() { grep -c "$1" "$NOTES_DIR/team/chat.md" 2>/dev/null || true; }
wait_until() { # seconds, then a command that must succeed
  local s=$1; shift
  for _ in $(seq 1 $((s * 4))); do "$@" && return 0; sleep 0.25; done
  return 1
}

# ── 1. A burst of appends: everything lands, the stream drains to zero ──────
log "Appending $MESSAGES messages (2 KB each) through the app replica"
code="$(api -X POST "$BASE/api/note?ns=team&path=chat.md" --data-raw '# chat')"
[ "$code" = 200 ] || [ "$code" = 201 ] || bad "create returned $code"
pad="$(printf 'x%.0s' $(seq 1 2000))"
errs=0
for i in $(seq 1 "$MESSAGES"); do
  code="$(api -X PATCH "$BASE/api/note?ns=team&path=chat.md" --data-raw "
msg-$i $pad")"
  [ "$code" = 200 ] || errs=$((errs + 1))
done
[ "$errs" = 0 ] && ok "all $MESSAGES appends accepted" || bad "$errs appends refused"

all_on_disk() { [ "$(on_disk 'msg-[0-9]')" = "$MESSAGES" ]; }
wait_until 60 all_on_disk && ok "every message is on the writer's disk" || bad "writer's file has $(on_disk 'msg-[0-9]') of $MESSAGES messages"
stream_empty() { [ "$(rcli xlen mdnest:durability)" = 0 ]; }
wait_until 20 stream_empty && ok "durability stream drained to 0 entries" \
  || bad "durability stream still holds $(rcli xlen mdnest:durability) entries ($(rcli memory usage mdnest:durability) bytes)"

# ── 2. Lock lost while Redis is full: the same writer recovers ──────────────
started="$(docker inspect -f '{{.State.StartedAt}}' "$WRITER")"
log "Taking the lock away and filling Redis (maxmemory 1)"
rcli set mdnest:writer:leader someone-else px 4000 >/dev/null
rcli config set maxmemory 1 >/dev/null
code="$(api -X PATCH "$BASE/api/note?ns=team&path=chat.md" --data-raw $'\nrefused-while-full')"
[ "$code" -ge 500 ] && ok "a save while Redis is full is refused ($code), as in the report" || bad "save while full returned $code"
sleep 6
rcli config set maxmemory 0 >/dev/null

leader_back() { [ "$(rcli get mdnest:writer:leader)" = "$WRITER" ]; }
wait_until 45 leader_back && ok "the writer won the lock back by itself" || bad "lock is held by '$(rcli get mdnest:writer:leader)', writer did not campaign again"
code="$(api -X PATCH "$BASE/api/note?ns=team&path=chat.md" --data-raw $'\nafter-outage')"
[ "$code" = 200 ] || bad "save after the outage returned $code"
after_landed() { [ "$(on_disk after-outage)" = 1 ]; }
wait_until 30 after_landed && ok "a save after the outage reached the writer's disk" || bad "the save after the outage never reached disk"
[ "$(docker inspect -f '{{.State.StartedAt}}' "$WRITER")" = "$started" ] && ok "the writer was not restarted" || bad "the writer restarted"
wait_until 20 stream_empty && ok "stream back to 0 entries" || bad "stream holds $(rcli xlen mdnest:durability) entries"

echo
docker logs "$WRITER" 2>&1 | grep -E 'leader|durability' | tail -8
echo
echo "=== $((pass + failed)) checks: $pass passed, $failed failed ==="
[ "$failed" = 0 ]
