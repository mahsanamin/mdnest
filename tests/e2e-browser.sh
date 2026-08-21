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
# Exit:    0 if the browser suite passes, 1 otherwise, 2 if prerequisites
#          (docker / node) are missing.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BE_IMAGE="mdnest-e2e-backend:test"
FE_IMAGE="mdnest-e2e-frontend:test"
SFX="$$"
BE="mdnest-e2e-be-$SFX"
FE="mdnest-e2e-fe-$SFX"
NET="mdnest-e2e-net-$SFX"
NOTES_DIR="$(mktemp -d)"

log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

cleanup() {
  docker rm -f "$FE" "$BE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$NOTES_DIR"
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { fail "docker is required"; exit 2; }
docker info >/dev/null 2>&1        || { fail "docker daemon isn't running"; exit 2; }
command -v node >/dev/null 2>&1    || { fail "node is required for Playwright"; exit 2; }
command -v npx  >/dev/null 2>&1    || { fail "npx is required for Playwright"; exit 2; }

# ── Build both images from the working tree ──────────────────────────────────
log "Building backend + frontend images from the working tree"
if ! docker build -t "$BE_IMAGE" backend/  >/tmp/mdnest-be-build.log 2>&1; then
  fail "backend build failed"; tail -30 /tmp/mdnest-be-build.log; exit 1
fi
if ! docker build -t "$FE_IMAGE" frontend/ >/tmp/mdnest-fe-build.log 2>&1; then
  fail "frontend build failed"; tail -30 /tmp/mdnest-fe-build.log; exit 1
fi
pass "images built"

# ── Boot the stack ───────────────────────────────────────────────────────────
mkdir -p "$NOTES_DIR/testing_workspace"
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
SEED_FILE="e2e-seed.md"
SEED_TOKEN="zzq${SFX}marker"
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
MERMAID_FILE="e2e-mermaid.md"
MERMAID_LABEL="zzm${SFX}label"
MERMAID_PALE="zzp${SFX}pale"
curl -fsS -X POST "$BASE_URL/api/note?ns=testing_workspace&path=$MERMAID_FILE" \
  -H "Authorization: Bearer $TOKEN" \
  --data "# Mermaid render check

\`\`\`mermaid
flowchart TD
  A[$MERMAID_LABEL] --> B[Second Node]
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
BOARD_FILE="e2e-board.md"
BOARD_TASK="zzt${SFX}task"
curl -fsS -X POST "$BASE_URL/api/note?ns=testing_workspace&path=$BOARD_FILE" \
  -H "Authorization: Bearer $TOKEN" \
  --data "# Sprint

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

- $box $BOARD_TASK
  - priority: high
" >/dev/null || { fail "could not seed e2e-board-$name.md"; exit 1; }
done
pass "seeded e2e-board-tick.md / e2e-board-untick.md"

# ── Install Playwright + Chromium on demand ──────────────────────────────────
log "Preparing Playwright (installs Chromium on first run)"
(
  cd tests/browser
  [ -d node_modules ] || npm install --no-audit --no-fund >/tmp/mdnest-pw-npm.log 2>&1
  # Install just the Chromium browser if it isn't cached yet.
  npx playwright install chromium >/tmp/mdnest-pw-browser.log 2>&1
) || { fail "Playwright setup failed (see /tmp/mdnest-pw-*.log)"; exit 1; }
pass "Playwright ready"

# ── Run the browser suite ────────────────────────────────────────────────────
log "Running the browser suite against $BASE_URL"
if ( cd tests/browser && \
     MDNEST_BASE_URL="$BASE_URL" \
     MDNEST_USER=e2e MDNEST_PASSWORD=e2epass123 \
     MDNEST_SEED_FILE="$SEED_FILE" MDNEST_SEED_TOKEN="$SEED_TOKEN" \
     MDNEST_MERMAID_FILE="$MERMAID_FILE" MDNEST_MERMAID_LABEL="$MERMAID_LABEL" \
     MDNEST_MERMAID_PALE="$MERMAID_PALE" \
     MDNEST_BOARD_FILE="$BOARD_FILE" MDNEST_BOARD_TASK="$BOARD_TASK" \
     MDNEST_NOTES_DIR="$NOTES_DIR" \
     npx playwright test ); then
  pass "BROWSER E2E: all specs passed"
  exit 0
else
  fail "BROWSER E2E: failures above (traces/screenshots in tests/browser/test-results)"
  exit 1
fi
