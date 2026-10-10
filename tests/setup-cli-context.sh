#!/usr/bin/env bash
#
# setup.sh: the frontend's "cli" build context and the Compose version check
# ───────────────────────────────────────────────────────────────────────────
# The frontend image serves the repo-root `mdnest` CLI at /cli/mdnest. The
# script sits outside the frontend build context, so the compose file setup.sh
# writes passes the repo root in as a second, named context (`cli`). Compose
# only understands that key from 2.17, and an older Compose fails every command
# with a schema error that says nothing useful, so setup.sh checks the version
# first and names it.
#
# Fast checks (no network, no real Docker; a PATH shim plays `docker`):
#   - the generated compose gives the frontend `additional_contexts: cli: .`
#   - Compose 2.16 is refused, by version, and no compose file is written
#   - 2.17, a "v"-prefixed version, and no docker at all all pass
#
# With --build (needs Docker; slow, a full frontend image build): runs setup.sh
# in a throwaway copy of the repo, then a real `docker compose build frontend`
# from the generated file, and checks the image serves /cli/mdnest
# byte-identical to the repo-root script. A YAML text check alone cannot prove
# Compose accepts the file or that the COPY finds the script.
#
# Usage:  tests/setup-cli-context.sh [--build]
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

SHIMS="$(mktemp -d)"
trap 'rm -rf "$SHIMS"' EXIT

# A `docker` that reports the given Compose version (or none: "absent").
shim_docker() {
  rm -rf "$SHIMS/bin"; mkdir -p "$SHIMS/bin"
  if [ "$1" != "absent" ]; then
    cat > "$SHIMS/bin/docker" <<EOF
#!/bin/sh
if [ "\$1 \$2 \$3" = "compose version --short" ]; then echo "$1"; exit 0; fi
exit 0
EOF
    chmod +x "$SHIMS/bin/docker"
  fi
}

# Run setup.sh in a sandbox; PATH holds only the shim dir plus the basics, so
# the real docker is never consulted. Echoes the sandbox path.
generate() {
  local sandbox
  sandbox="$(mktemp -d)"
  cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sandbox"/
  printf 'MOUNT_test=%s/notes\n' "$sandbox" > "$sandbox/mdnest.conf"
  ( cd "$sandbox" && PATH="$SHIMS/bin:/usr/bin:/bin:/usr/sbin:/sbin" bash setup.sh ) >"$sandbox/setup.out" 2>&1
  echo "$?" > "$sandbox/setup.rc"
  printf '%s' "$sandbox"
}

echo "── setup.sh: frontend cli build context ──"

shim_docker "2.29.1"
sb="$(generate)"
if awk '/^  frontend:/{f=1} f&&/^  [a-z]/&&!/^  frontend:/{f=0} f' "$sb/docker-compose.yml" \
     | grep -v '^ *#' | tr -d '\n' | grep -q 'context: ./frontend *additional_contexts: *cli: \.'; then
  ok "frontend build gets additional_contexts cli: ."
else
  bad "frontend build gets additional_contexts cli: ." \
      "frontend service was: $(awk '/^  frontend:/,/restart:/' "$sb/docker-compose.yml" 2>/dev/null)"
fi
rm -rf "$sb"

shim_docker "2.16.0"
sb="$(generate)"
if [ "$(cat "$sb/setup.rc")" != "0" ] && grep -q '2.17' "$sb/setup.out" && grep -q '2.16.0' "$sb/setup.out"; then
  ok "Compose 2.16 is refused, naming both versions"
else
  bad "Compose 2.16 is refused, naming both versions" "rc=$(cat "$sb/setup.rc") out: $(cat "$sb/setup.out")"
fi
if [ ! -f "$sb/docker-compose.yml" ]; then
  ok "a refused Compose leaves no compose file behind"
else
  bad "a refused Compose leaves no compose file behind" "docker-compose.yml was written"
fi
rm -rf "$sb"

for v in 2.17.0 v2.40.3 5.5.1 absent; do
  shim_docker "$v"
  sb="$(generate)"
  if [ "$(cat "$sb/setup.rc")" = "0" ] && [ -f "$sb/docker-compose.yml" ]; then
    ok "Compose $v passes"
  else
    bad "Compose $v passes" "rc=$(cat "$sb/setup.rc") out: $(tail -3 "$sb/setup.out")"
  fi
  rm -rf "$sb"
done

if [ "${1:-}" = "--build" ]; then
  echo "── real compose build of the frontend (slow) ──"
  if ! docker info >/dev/null 2>&1; then
    bad "real compose build" "docker is not available"
  else
    work="$(mktemp -d)"
    # The parts setup.sh and the frontend build read. node_modules and dist
    # are left out; the image installs its own.
    mkdir -p "$work/frontend"
    cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$REPO_ROOT/mdnest" "$work"/
    ( cd "$REPO_ROOT/frontend" && tar cf - --exclude node_modules --exclude dist . ) | ( cd "$work/frontend" && tar xf - )
    mkdir -p "$work/backend"   # named in the compose file; not built here
    printf 'MOUNT_test=%s/notes\n' "$work" > "$work/mdnest.conf"
    project="mdnest-clictx-$$"
    if ( cd "$work" && bash setup.sh >/dev/null 2>&1 &&
         docker compose -p "$project" build frontend ) >"$work/build.log" 2>&1; then
      ok "docker compose build frontend succeeds from the generated file"
      img="${project}-frontend"
      if docker run --rm --entrypoint cat "$img" /usr/share/nginx/html/cli/mdnest 2>/dev/null \
           | cmp -s - "$REPO_ROOT/mdnest"; then
        ok "the image holds /cli/mdnest byte-identical to the repo-root mdnest"
      else
        bad "the image holds /cli/mdnest byte-identical to the repo-root mdnest" "content differs or missing"
      fi
      docker image rm "$img" >/dev/null 2>&1 || true
    else
      bad "docker compose build frontend succeeds from the generated file" "$(tail -20 "$work/build.log")"
    fi
    rm -rf "$work"
  fi
fi

echo
echo "  ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
