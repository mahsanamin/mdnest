#!/usr/bin/env bash
#
# setup.sh HTML pages test: no network, no Docker needed
# ───────────────────────────────────────────────────────
# ENABLE_PAGES and the PAGES_* settings travel mdnest.conf -> setup.sh -> .env
# and docker-compose.yml -> the backend. The backend ignores env it does not
# read, so a setting setup.sh drops does not fail, it quietly does nothing.
#
# Pins:
#   - pages off: .env, docker-compose.yml and Caddyfile are byte-identical to
#     what origin/develop's setup.sh writes (the default install does not grow);
#   - static mode: the settings reach .env, page files get their own volume
#     (named, or a host folder with PAGES_DIR), and no second port appears;
#   - script mode: the second port is published to the backend's pages
#     listener, or Caddy gets a site for the pages hostname;
#   - mistakes are refused at setup time (typo in a switch, no port without
#     Caddy, PAGES_ORIGIN equal to FRONTEND_ORIGIN);
#   - the backend reads every key, and mdnest.conf.sample documents it.
#
# Usage:  tests/setup-pages.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }
has() { if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else bad "$1" "[$3] not in $(basename "$2")"; fi; }
hasnt() { if grep -qF -- "$3" "$2" 2>/dev/null; then bad "$1" "[$3] found in $(basename "$2")"; else ok "$1"; fi; }

SANDBOXES=()
cleanup() { local d; for d in "${SANDBOXES[@]}"; do rm -rf "$d"; done; return 0; }
trap cleanup EXIT

# generate <setup.sh source> <conf lines...>: prints the sandbox; setup's exit
# status is in <sandbox>/rc.
generate() {
  local src="$1" sandbox
  shift
  sandbox="$(mktemp -d)"
  SANDBOXES+=("$sandbox")
  cp "$src" "$sandbox/setup.sh"
  cp "$REPO_ROOT/mdnest.conf.sample" "$sandbox"/
  {
    printf 'MOUNT_test=%s/notes\n' "$sandbox"
    printf '%s\n' "$@"
  } > "$sandbox/mdnest.conf"
  ( cd "$sandbox" && bash setup.sh ) >"$sandbox/setup.out" 2>&1
  echo $? > "$sandbox/rc"
  printf '%s' "$sandbox"
}

# Lines that differ on every run whatever the code.
stable() { grep -vE '^(BUILD_TIME|GIT_COMMIT)=' "$1" 2>/dev/null; }

echo "── setup.sh: HTML pages ──"

# 1) Pages off: byte-identical to develop, with and without Caddy.
BASE_SETUP="$(mktemp)"
SANDBOXES+=("$BASE_SETUP")
if git -C "$REPO_ROOT" show origin/develop:setup.sh > "$BASE_SETUP" 2>/dev/null; then
  for conf in "" "ENABLE_PAGES=false" "CADDY_DOMAIN=notes.example.com"; do
    # shellcheck disable=SC2086
    a="$(generate "$BASE_SETUP" $conf)"; b="$(generate "$REPO_ROOT/setup.sh" $conf)"
    same=1
    for f in .env docker-compose.yml Caddyfile; do
      [ -e "$a/$f" ] || [ -e "$b/$f" ] || continue
      if ! diff <(stable "$a/$f" | sed "s|$a|SANDBOX|g") <(stable "$b/$f" | sed "s|$b|SANDBOX|g") >/dev/null; then
        same=0
        bad "pages off (${conf:-no settings}): $f matches develop" "$(diff <(stable "$a/$f" | sed "s|$a|SANDBOX|g") <(stable "$b/$f" | sed "s|$b|SANDBOX|g") | head -5)"
      fi
    done
    [ "$same" = 1 ] && ok "pages off (${conf:-no settings}): generated files match develop byte for byte"
  done
else
  echo "  SKIP pages-off comparison: origin/develop is not fetched"
fi

# 2) Static mode, named volume.
sb="$(generate "$REPO_ROOT/setup.sh" ENABLE_PAGES=true PAGES_MAX_MB=10)"
has "static: ENABLE_PAGES reaches .env" "$sb/.env" "ENABLE_PAGES=true"
has "static: PAGES_DIR is the container path" "$sb/.env" "PAGES_DIR=/data/pages"
has "static: PAGES_MAX_MB reaches .env" "$sb/.env" "PAGES_MAX_MB=10"
has "static: PAGES_MAX_FILES defaults to 500" "$sb/.env" "PAGES_MAX_FILES=500"
has "static: PAGES_NETWORK defaults to strict" "$sb/.env" "PAGES_NETWORK=strict"
hasnt "static: no PAGES_ORIGIN" "$sb/.env" "PAGES_ORIGIN="
has "static: page files on a named volume" "$sb/docker-compose.yml" "- mdnest-pages:/data/pages"
has "static: the named volume is declared" "$sb/docker-compose.yml" "  mdnest-pages:"
hasnt "static: no pages port" "$sb/docker-compose.yml" ":8081"

# 3) Static mode, host folder.
sb="$(generate "$REPO_ROOT/setup.sh" ENABLE_PAGES=true "PAGES_DIR=$REPO_ROOT/.pages-test-unused")"
rmdir "$REPO_ROOT/.pages-test-unused" 2>/dev/null
has "PAGES_DIR: bound from the host folder" "$sb/docker-compose.yml" "- $REPO_ROOT/.pages-test-unused:/data/pages"
hasnt "PAGES_DIR: no named volume" "$sb/docker-compose.yml" "mdnest-pages"

# 4) Script mode on a second port, two bind addresses.
sb="$(generate "$REPO_ROOT/setup.sh" ENABLE_PAGES=true PAGES_ORIGIN=http://localhost:3237 PAGES_NETWORK=open BIND_ADDRESS=127.0.0.1,0.0.0.0)"
has "script: PAGES_ORIGIN reaches .env" "$sb/.env" "PAGES_ORIGIN=http://localhost:3237"
has "script: the listener port reaches .env" "$sb/.env" "PAGES_LISTEN_PORT=8081"
has "script: PAGES_NETWORK reaches .env" "$sb/.env" "PAGES_NETWORK=open"
has "script: second port published on the first address" "$sb/docker-compose.yml" '"127.0.0.1:3237:8081"'
has "script: second port published on the second address" "$sb/docker-compose.yml" '"0.0.0.0:3237:8081"'

# 4b) Script mode behind your own proxy: public hostname, PAGES_PORT on the host.
sb="$(generate "$REPO_ROOT/setup.sh" ENABLE_PAGES=true PAGES_ORIGIN=https://pages.example.com PAGES_PORT=3237)"
has "own proxy: PAGES_PORT is published to the pages listener" "$sb/docker-compose.yml" '"127.0.0.1:3237:8081"'
has "own proxy: the public address is what the backend gets" "$sb/.env" "PAGES_ORIGIN=https://pages.example.com"

# 5) Script mode through Caddy: a second hostname, then a second port.
sb="$(generate "$REPO_ROOT/setup.sh" ENABLE_PAGES=true CADDY_DOMAIN=notes.example.com FRONTEND_ORIGIN=https://notes.example.com PAGES_ORIGIN=https://pages.example.com)"
has "caddy: a site for the pages hostname" "$sb/Caddyfile" "https://pages.example.com {"
has "caddy: it goes to the pages listener" "$sb/Caddyfile" "reverse_proxy backend:8081"
hasnt "caddy: no extra port for a hostname on 443" "$sb/docker-compose.yml" '"8443:8443"'
sb="$(generate "$REPO_ROOT/setup.sh" ENABLE_PAGES=true CADDY_DOMAIN=notes.example.com FRONTEND_ORIGIN=https://notes.example.com PAGES_ORIGIN=https://notes.example.com:8443)"
has "caddy: a second port is published on Caddy" "$sb/docker-compose.yml" '"8443:8443"'

# 6) Refused at setup time.
refused() {
  local label="$1" want="$2" sb
  shift 2
  sb="$(generate "$REPO_ROOT/setup.sh" "$@")"
  if [ "$(cat "$sb/rc")" != 0 ] && grep -qF -- "$want" "$sb/setup.out" && [ ! -e "$sb/.env" ]; then
    ok "$label"
  else
    bad "$label" "rc=$(cat "$sb/rc"), output: $(head -3 "$sb/setup.out")"
  fi
}
refused "a typo in ENABLE_PAGES is refused" "ENABLE_PAGES must be true or false" ENABLE_PAGES=yes
refused "a typo in PAGES_NETWORK is refused" "PAGES_NETWORK must be strict or open" ENABLE_PAGES=true PAGES_NETWORK=loose
refused "a non-number PAGES_MAX_MB is refused" "PAGES_MAX_MB must be a whole number" ENABLE_PAGES=true PAGES_MAX_MB=lots
refused "a pages origin with a path is refused" "bare origin" ENABLE_PAGES=true PAGES_ORIGIN=http://localhost:3237/pages
refused "no port and no Caddy is refused" "has no port" ENABLE_PAGES=true PAGES_ORIGIN=https://pages.example.com
refused "a non-number PAGES_PORT is refused" "PAGES_PORT must be a whole number" ENABLE_PAGES=true PAGES_ORIGIN=https://pages.example.com PAGES_PORT=x
refused "PAGES_ORIGIN equal to FRONTEND_ORIGIN is refused" "must differ from FRONTEND_ORIGIN" ENABLE_PAGES=true FRONTEND_ORIGIN=http://localhost:3236 PAGES_ORIGIN=http://localhost:3236

# 7) Every key is read by the backend and documented.
for k in ENABLE_PAGES PAGES_DIR PAGES_ORIGIN PAGES_NETWORK PAGES_MAX_MB PAGES_MAX_FILES PAGES_LISTEN_PORT; do
  if grep -q "\"$k\"" "$REPO_ROOT/backend/main.go"; then ok "backend reads $k"; else bad "backend reads $k" "no env(\"$k\") in backend/main.go"; fi
done
for k in ENABLE_PAGES PAGES_DIR PAGES_ORIGIN PAGES_NETWORK PAGES_MAX_MB PAGES_MAX_FILES PAGES_PORT; do
  if grep -q "^#* *$k=" "$REPO_ROOT/mdnest.conf.sample"; then ok "mdnest.conf.sample documents $k"; else bad "mdnest.conf.sample documents $k" "no $k= line"; fi
done

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
