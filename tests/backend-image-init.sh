#!/usr/bin/env bash
#
# Backend image init test: PID 1 must reap orphaned processes.
#
# git spawns transport helpers (git-remote-https, ssh) that can outlive git and
# get reparented to PID 1. If PID 1 is mdnest itself, nothing ever waits on
# them, and each one stays a zombie until the container's PID limit is hit
# (a writer pod reached tens of thousands this way). Builds the backend image
# from the working tree, orphans a short-lived process inside the running
# container, and checks it is reaped.
#
# Usage:   tests/backend-image-init.sh
# Exit:    0 pass, 1 fail, 2 docker missing.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker not found"; exit 2; }

IMAGE="mdnest-init-backend:test"
CONTAINER="mdnest-init-be-$$"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1; }
trap cleanup EXIT

if ! docker build -q -t "$IMAGE" backend/ >/tmp/mdnest-init-build.log 2>&1; then
  echo "FAIL: backend image build (see /tmp/mdnest-init-build.log)"
  exit 1
fi

docker run -d --name "$CONTAINER" \
  -e AUTH_MODE=single -e MDNEST_USER=e2e -e MDNEST_PASSWORD=e2epass123 \
  -e MDNEST_JWT_SECRET=e2e-test-secret -e NOTES_DIR=/notes \
  "$IMAGE" >/dev/null || { echo "FAIL: container did not start"; exit 1; }

fail=0
pid1=$(docker exec "$CONTAINER" cat /proc/1/comm)
mdnest_ppid=$(docker exec "$CONTAINER" sh -c 'for d in /proc/[0-9]*; do [ "$(cat $d/comm 2>/dev/null)" = mdnest ] && awk "{print \$4}" $d/stat; done' | head -1)
if [ "$mdnest_ppid" = "1" ] && [ "$pid1" != "mdnest" ]; then
  echo "ok: PID 1 is $pid1, mdnest runs under it"
else
  echo "FAIL: PID 1 is '$pid1' (mdnest parent: '${mdnest_ppid:-none}')"
  fail=1
fi

# The subshell exits at once, so sleep is orphaned to PID 1 and exits 1s later.
docker exec "$CONTAINER" sh -c '(sleep 1 &)'
sleep 3
zombies=$(docker exec "$CONTAINER" sh -c 'grep -l "^State:.*Z" /proc/[0-9]*/status 2>/dev/null | wc -l')
if [ "$zombies" = "0" ]; then
  echo "ok: orphaned process was reaped"
else
  echo "FAIL: $zombies zombie process(es) left after an orphan exited"
  fail=1
fi

exit $fail
