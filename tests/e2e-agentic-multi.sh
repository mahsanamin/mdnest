#!/usr/bin/env bash
# Real multi-mode chat/CLI/MCP acceptance, with two distinct mounted folders.
# KEEP=1 retains this isolated fixture for inspection. Credentials are private
# files under a fresh /tmp directory, never terminal output or repository data.
set -uo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
. "$ROOT/tests/lib/e2e-images.sh"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-agentic-multi.XXXXXX")"
# The mounted namespace folders live under the repo, not the temp dir: the
# Docker VM may not share the system temp dir, and then the container sees
# an empty folder. Credentials stay in the private FIXTURE above.
NOTES="$(e2e_notes_dir "$ROOT")"
SFX="$$-$RANDOM"
NET="mdnest-agentic-net-$SFX"
PG="mdnest-agentic-pg-$SFX"
BE="mdnest-agentic-be-$SFX"
FE="mdnest-agentic-fe-$SFX"
cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    printf 'Inspection fixture retained: %s (notes: %s)\n' "$FIXTURE" "$NOTES"
    return 0
  fi
  docker rm -f -v "$FE" "$BE" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  e2e_rm_dirs "$FIXTURE" "$NOTES"
}
trap cleanup EXIT
command -v docker >/dev/null && docker info >/dev/null 2>&1 || exit 2
command -v node >/dev/null || exit 2
node tests/agentic-multi.mjs init "$FIXTURE" "$PG" "$NOTES" || exit 1
# umask 077 keeps the credential files private, but the mounted namespace
# folders must be usable by the backend's non-root user. On Docker Desktop
# (macOS) the host uid does not match, so 0700/0600 gives a 404 on every note.
chmod -R a+rwX "$NOTES" || exit 1
if [ -n "$(find "$NOTES/team-alpha" "$NOTES/team-beta" ! -perm -o+rw -print -quit)" ]; then
  echo "FAIL namespace folders are not readable and writable by the container user" >&2; exit 1
fi
e2e_playwright_ready "$FIXTURE/logs" || exit 1
BE_IMAGE="$(e2e_backend_image "$ROOT" "$FIXTURE/logs")" || exit 1
FE_IMAGE="$(e2e_frontend_image "$ROOT" "$FIXTURE/logs")" || exit 1
# Fail here, not with a 404 later, if Docker cannot see the notes.
for ns in team-alpha team-beta; do
  docker run --rm -v "$NOTES/$ns:/x" alpine test -f /x/Welcome.md || {
    echo "FAIL Docker sees an empty $ns folder at $NOTES/$ns (not shared with the Docker VM?)" >&2; exit 1; }
done
docker network create "$NET" >/dev/null || exit 1
docker run -d --name "$PG" --network "$NET" --env-file "$FIXTURE/postgres.env" postgres:16-alpine >/dev/null || exit 1
for _ in $(seq 1 40); do docker exec "$PG" pg_isready -U mdnest >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name "$BE" --network "$NET" --network-alias backend --env-file "$FIXTURE/backend.env" \
  -v "$NOTES/team-alpha:/notes/team-alpha" -v "$NOTES/team-beta:/notes/team-beta" \
  -p 127.0.0.1:0:8080 "$BE_IMAGE" >/dev/null || exit 1
docker run -d --name "$FE" --network "$NET" -p 127.0.0.1:0:80 "$FE_IMAGE" >/dev/null || exit 1
BE_PORT="$(docker port "$BE" 8080/tcp | cut -d: -f2)"
FE_PORT="$(docker port "$FE" 80/tcp | cut -d: -f2)"
BASE="http://127.0.0.1:$FE_PORT"
for _ in $(seq 1 60); do curl -fsS "$BASE/api/config" >/dev/null 2>&1 && break; sleep 1; done
node tests/agentic-multi.mjs configure "$FIXTURE" "$BASE" "http://127.0.0.1:$BE_PORT" "$BE" "$FE" "$PG" "$NET" "$BE_IMAGE" "$FE_IMAGE" "$NOTES" || exit 1
GIT_HEAD="$(git rev-parse HEAD)" GIT_TREE="$(e2e_tree_hash "$ROOT" backend frontend mdnest mcp-server tests/e2e-agentic-multi.sh tests/agentic-multi.mjs)" \
  node tests/agentic-multi.mjs manifest "$FIXTURE" || exit 1
printf 'Multi-user inspection site: %s\nNamespaces: team-alpha, team-beta\nPrivate login details: %s/login-details.txt\n' "$BASE" "$FIXTURE"
node tests/agentic-multi.mjs run "$FIXTURE"
RC=$?
GIT_HEAD="$(git rev-parse HEAD)" GIT_TREE="$(e2e_tree_hash "$ROOT" backend frontend mdnest mcp-server tests/e2e-agentic-multi.sh tests/agentic-multi.mjs)" \
  node tests/agentic-multi.mjs manifest "$FIXTURE" || RC=1
docker logs "$BE" >"$FIXTURE/logs/backend.log" 2>&1 || true
exit "$RC"
