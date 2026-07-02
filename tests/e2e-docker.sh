#!/usr/bin/env bash
#
# mdnest end-to-end test — local, Docker-based, no GitHub/remote
# ──────────────────────────────────────────────────────────────
# Builds the backend image FROM THE WORKING TREE, runs a throwaway single-mode
# instance, mints a token, and drives the REAL mdnest CLI against it:
#
#   Layer A — the host CLI (python3 present): the normal-machine path.
#   Layer B — the CLI inside a bare bash+curl container with NO python3/jq:
#             the truest reproduction of a fresh machine — exactly the
#             environment the recent CLI regression broke on.
#
# Everything is disposable and cleaned up on exit. Nothing touches the user's
# real notes, real CLI config, or any remote.
#
# Usage:   tests/e2e-docker.sh
# Exit:    0 if both layers pass, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="mdnest-e2e-backend:test"
SFX="$$"
CONTAINER="mdnest-e2e-be-$SFX"
NET="mdnest-e2e-net-$SFX"
NOTES_DIR="$(mktemp -d)"
CLI_HOME="$(mktemp -d)"
FAILED=0

log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

cleanup() {
  docker rm -f "$CONTAINER"  >/dev/null 2>&1 || true
  docker network rm "$NET"   >/dev/null 2>&1 || true
  rm -rf "$NOTES_DIR" "$CLI_HOME"
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { fail "docker is required for the E2E test"; exit 1; }
docker info >/dev/null 2>&1        || { fail "docker daemon isn't running"; exit 1; }

# ── Build the backend from the working tree ──────────────────────────────────
log "Building backend image from the working tree"
if ! docker build -t "$IMAGE" backend/ >/tmp/mdnest-e2e-build.log 2>&1; then
  fail "backend image build failed"; tail -30 /tmp/mdnest-e2e-build.log; exit 1
fi
pass "backend image built"

# ── Start a throwaway single-mode instance ───────────────────────────────────
mkdir -p "$NOTES_DIR/testing_workspace"
docker network create "$NET" >/dev/null

log "Starting disposable single-mode backend"
docker run -d --name "$CONTAINER" --network "$NET" \
  -e AUTH_MODE=single \
  -e MDNEST_USER=e2e \
  -e MDNEST_PASSWORD=e2epass123 \
  -e MDNEST_JWT_SECRET=e2e-test-secret \
  -e NOTES_DIR=/notes \
  -e FRONTEND_ORIGIN=http://localhost \
  -v "$NOTES_DIR:/notes" \
  -p 127.0.0.1:0:8080 "$IMAGE" >/dev/null

# Discover the ephemeral host port docker assigned.
PORT="$(docker port "$CONTAINER" 8080/tcp | head -1 | sed 's/.*://')"
[ -n "$PORT" ] || { fail "couldn't determine mapped port"; docker logs "$CONTAINER"; exit 1; }
BASE_URL="http://127.0.0.1:$PORT"

log "Waiting for backend health at $BASE_URL/api/config"
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "$BASE_URL/api/config" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
[ "$healthy" = 1 ] || { fail "backend never became healthy"; docker logs "$CONTAINER"; exit 1; }
pass "backend healthy"

# ── Mint a token (single-mode login returns a JWT the CLI accepts) ────────────
log "Minting a token via /api/auth/login"
LOGIN_JSON="$(curl -fsS -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e","password":"e2epass123"}' 2>/dev/null)"
TOKEN="$(printf '%s' "$LOGIN_JSON" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] || { fail "could not mint a token (login response: $LOGIN_JSON)"; exit 1; }
pass "token minted"

# ── Layer A: host CLI (python3 present) ───────────────────────────────────────
log "Layer A — host CLI against the live backend (normal machine)"
HOME="$CLI_HOME" "$REPO_ROOT/mdnest" login @e2e "$BASE_URL" "$TOKEN" >/dev/null 2>&1
if HOME="$CLI_HOME" MDNEST_BIN="$REPO_ROOT/mdnest" MDNEST_TEST_ALIAS=e2e \
     bash "$REPO_ROOT/tests/cli-smoke-test.sh"; then
  pass "Layer A (host CLI) passed"
else
  fail "Layer A (host CLI) failed"; FAILED=1
fi

# ── Layer B: bare container, NO python3/jq (fresh-machine reproduction) ───────
log "Layer B — CLI inside a bare bash+curl container (NO python3/jq)"
# alpine ships neither python3 nor jq; we add only bash + curl. The CLI reaches
# the backend over the docker network by container name. If the CLI has any hard
# python3 dependency, this layer fails — which is exactly what we want to catch.
if docker run --rm --network "$NET" \
     -e TOKEN="$TOKEN" \
     -e BE_URL="http://$CONTAINER:8080" \
     -v "$REPO_ROOT:/src:ro" \
     alpine:latest sh -c '
       set -e
       apk add --no-cache bash curl >/dev/null 2>&1
       if command -v python3 >/dev/null 2>&1 || command -v jq >/dev/null 2>&1; then
         echo "WARN: python3/jq present — not a true fresh-machine test" >&2
       fi
       export HOME=/root
       # Copy the CLI to a writable path so it runs directly as an executable
       # (the smoke test invokes "$MDNEST_BIN" as a single command, and /src is
       # a read-only mount). /bin/bash exists after the apk add above.
       cp /src/mdnest /usr/local/bin/mdnest && chmod +x /usr/local/bin/mdnest
       /usr/local/bin/mdnest login @e2e "$BE_URL" "$TOKEN" >/dev/null 2>&1
       MDNEST_BIN=/usr/local/bin/mdnest MDNEST_TEST_ALIAS=e2e bash /src/tests/cli-smoke-test.sh
     '; then
  pass "Layer B (no-python3 CLI) passed"
else
  fail "Layer B (no-python3 CLI) failed"; FAILED=1
fi

echo
if [ "$FAILED" = 0 ]; then
  pass "END-TO-END: all layers passed"
else
  fail "END-TO-END: failures above"
fi
exit "$FAILED"
