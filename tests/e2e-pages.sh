#!/usr/bin/env bash
#
# mdnest HTML pages end-to-end test, local and Docker-based
# ──────────────────────────────────────────────────────────
# Builds the backend and frontend from the working tree and runs
# tests/browser/pages.spec.js twice, against a stack in each pages mode:
#
#   static: ENABLE_PAGES=true, no PAGES_ORIGIN. Page files come from mdnest's
#           own address with scripts off.
#   script: PAGES_ORIGIN on a second address (another host name and port),
#           served by the backend's pages listener. Scripts run, sandboxed.
#
# The app is opened as http://127.0.0.1:<port> and the pages origin is
# http://localhost:<other port>, so the two never share an origin, as in a
# real script-mode install. The flag-off checks are pages-off.spec.js, which
# runs in tests/e2e-browser.sh (that stack has pages off).
#
# Usage:   tests/e2e-pages.sh
# Exit:    0 if both modes pass, 1 otherwise, 2 if docker or node is missing.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# shellcheck source=tests/lib/e2e-images.sh
. "$REPO_ROOT/tests/lib/e2e-images.sh"
SFX="$$"
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-e2e-pages.XXXXXX")"
BE="mdnest-e2e-pages-be-$SFX"; FE="mdnest-e2e-pages-fe-$SFX"; NET="mdnest-e2e-pages-net-$SFX"
NOTES_DIR=""
SECRET="e2e-pages-secret-$SFX"

log()  { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

stop_stack() {
  docker rm -f -v "$FE" "$BE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup() {
  stop_stack
  [ -n "$NOTES_DIR" ] && e2e_rm_dirs "$NOTES_DIR"
  [ -z "${KEEP:-}" ] && rm -rf "$LOGDIR"
  return 0
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { fail "docker is required"; exit 2; }
docker info >/dev/null 2>&1        || { fail "docker daemon isn't running"; exit 2; }
command -v node >/dev/null 2>&1    || { fail "node is required for Playwright"; exit 2; }

# free_port: a TCP port nothing listens on right now.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

log "Building backend + frontend images from the working tree"
BE_IMAGE="$(e2e_backend_image "$REPO_ROOT" "$LOGDIR")" || { fail "backend build failed"; exit 1; }
FE_IMAGE="$(e2e_frontend_image "$REPO_ROOT" "$LOGDIR")" || { fail "frontend build failed"; exit 1; }
pass "images ready: $BE_IMAGE, $FE_IMAGE"

e2e_playwright_ready "$LOGDIR" || { fail "Playwright setup failed (see $LOGDIR/playwright-*.log)"; KEEP=1; exit 1; }
pass "Playwright ready"

NOTES_DIR="$(e2e_notes_dir "$REPO_ROOT")"
mkdir -p "$NOTES_DIR/testing_workspace" "$NOTES_DIR/zz_pages_settings"
printf '# Pages e2e\n\nA note, so the namespace is not empty.\n' > "$NOTES_DIR/testing_workspace/pages-e2e.md"

# boot MODE: start the stack in static or script mode. Sets BASE_URL and
# PAGES_ORIGIN (empty in static mode).
boot() {
  local mode="$1" app_port pages_port extra=()
  app_port="$(free_port)"
  BASE_URL="http://127.0.0.1:$app_port"
  PAGES_ORIGIN=""
  # Exercise git-backed pages and legacy separate storage in the two modes.
  if [ "$mode" = static ]; then extra=(-e PAGES_IN_GIT=true); fi
  if [ "$mode" = script ]; then
    pages_port="$(free_port)"
    PAGES_ORIGIN="http://localhost:$pages_port"
    extra=(-e "PAGES_ORIGIN=$PAGES_ORIGIN" -e PAGES_LISTEN_PORT=8081 -p "127.0.0.1:$pages_port:8081")
  fi
  docker network create "$NET" >/dev/null
  # As the host user, so the spec can remove a handle file behind mdnest's
  # back, the way git sync would.
  docker run -d --name "$BE" --network "$NET" --network-alias backend \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e AUTH_MODE=single -e MDNEST_USER=e2e -e MDNEST_PASSWORD=e2epass123 \
    -e MDNEST_JWT_SECRET="$SECRET" -e NOTES_DIR=/notes \
    -e FRONTEND_ORIGIN="$BASE_URL" -e DISABLE_UPDATE_CHECK=true \
    -e ENABLE_PAGES=true -e PAGES_DIR=/tmp/pages -e PAGES_MAX_MB=1 -e PAGES_MAX_FILES=50 \
    ${extra[@]+"${extra[@]}"} \
    -v "$NOTES_DIR:/notes" "$BE_IMAGE" >/dev/null
  docker run -d --name "$FE" --network "$NET" -p "127.0.0.1:$app_port:80" "$FE_IMAGE" >/dev/null
  local _
  for _ in $(seq 1 40); do
    if curl -fsS "$BASE_URL/api/config" 2>/dev/null | grep -q '"pages"'; then return 0; fi
    sleep 1
  done
  fail "the $mode stack never came up with pages on"; docker logs "$BE" 2>&1 | tail -20
  return 1
}

rc=0
for mode in static script; do
  log "Pages, $mode mode"
  boot "$mode" || { rc=1; stop_stack; continue; }
  scripts="$(curl -fsS "$BASE_URL/api/config" | sed -n 's/.*"pages":{[^}]*"scripts":\([a-z]*\).*/\1/p')"
  if { [ "$mode" = static ] && [ "$scripts" = false ]; } || { [ "$mode" = script ] && [ "$scripts" = true ]; }; then
    pass "/api/config reports scripts=$scripts"
  else
    fail "/api/config reports scripts=$scripts in $mode mode"; rc=1
  fi
  cli_home="$LOGDIR/cli-$mode"
  mkdir -p "$cli_home"
  cli_token="$(curl -fsS -H 'Content-Type: application/json' --data-raw '{"username":"e2e","password":"e2epass123"}' "$BASE_URL/api/auth/login" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')" || cli_token=""
  if HOME="$cli_home" MDNEST_AGENT_SKILLS=0 ./mdnest login @pages "$BASE_URL" "$cli_token" >"$LOGDIR/cli-login-$mode.log" 2>&1 && \
     HOME="$cli_home" MDNEST_TEST_ALIAS=pages MDNEST_TEST_NS=zz_pages_settings MDNEST_TEST_NS2=testing_workspace MDNEST_TEST_PAGES_BACKUP=1 \
     bash tests/cli-smoke-test.sh >"$LOGDIR/cli-$mode.log" 2>&1; then
    pass "$mode mode: CLI smoke including namespace page backups"
  else
    fail "$mode mode: CLI smoke failed (see $LOGDIR/cli-$mode.log)"; rc=1; KEEP=1
  fi
  if ( cd tests/browser && \
       MDNEST_BASE_URL="$BASE_URL" MDNEST_USER=e2e MDNEST_PASSWORD=e2epass123 \
       MDNEST_PAGES_MODE="$mode" MDNEST_PAGES_ORIGIN="$PAGES_ORIGIN" MDNEST_JWT_SECRET="$SECRET" \
       MDNEST_NOTES_DIR="$NOTES_DIR" \
       npx playwright test pages.spec.js pages-settings.spec.js --output="../browser-results/pages-$mode" ${MDNEST_E2E_ARGS:-} ); then
    pass "$mode mode: pages.spec.js passed"
  else
    fail "$mode mode: pages.spec.js failed"; rc=1
  fi
  stop_stack
done

if [ "$rc" -eq 0 ]; then
  pass "PAGES E2E: both modes passed"
else
  fail "PAGES E2E: failures above (traces in tests/browser-results/pages-*)"
fi
exit "$rc"
