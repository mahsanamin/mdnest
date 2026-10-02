#!/usr/bin/env bash
#
# setup.sh DEFAULT_THEME plumbing test — no network, no Docker
# ────────────────────────────────────────────────────────────
# DEFAULT_THEME is the theme a user sees before they have chosen one. It has to
# travel mdnest.conf -> setup.sh -> .env -> the backend container, and the
# backend reads it with a fallback to "auto". That fallback is the hazard: a
# knob the backend silently ignores does not fail, it lies. If setup.sh ever
# stops writing DEFAULT_THEME into .env, every install quietly reverts to auto
# and nothing anywhere reports it.
#
# So this pins both directions: the configured value reaches .env, and a value
# that is not auto/dark/light is rejected at setup time rather than persisted
# and ignored.
#
# Usage:  tests/setup-chat.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

# Run setup.sh in a sandbox with the given extra conf lines. Echoes the sandbox
# path; the caller inspects .env / docker-compose.yml and removes it.
generate() {
  local sandbox
  sandbox="$(mktemp -d)"
  cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sandbox"/
  {
    printf 'MOUNT_test=%s/notes\n' "$sandbox"
    printf '%s\n' "$@"
  } > "$sandbox/mdnest.conf"
  ( cd "$sandbox" && bash setup.sh ) >"$sandbox/setup.out" 2>&1
  printf '%s' "$sandbox"
}

echo "── setup.sh: ENABLE_CHAT ──"

# The backend ignores env it does not read, so a knob that never reaches .env
# does not fail — chat just silently stays off. Pin both directions.
sb="$(generate 'ENABLE_CHAT=true')"
if grep -qx 'ENABLE_CHAT=true' "$sb/.env" 2>/dev/null; then
  ok "ENABLE_CHAT=true reaches .env"
else
  bad "ENABLE_CHAT=true reaches .env" "got: $(grep '^ENABLE_CHAT=' "$sb/.env" 2>/dev/null || echo '<no ENABLE_CHAT line>')"
fi
rm -rf "$sb"

sb="$(generate 'ENABLE_TASK_BOARD=false')"
if grep -qx 'ENABLE_CHAT=false' "$sb/.env" 2>/dev/null; then
  ok "unset ENABLE_CHAT is written as false (off by default)"
else
  bad "unset ENABLE_CHAT is written as false (off by default)" "got: $(grep '^ENABLE_CHAT=' "$sb/.env" 2>/dev/null || echo '<no ENABLE_CHAT line>')"
fi
rm -rf "$sb"

if grep -q 'ENABLE_CHAT' "$REPO_ROOT/mdnest.conf.sample"; then
  ok "ENABLE_CHAT is documented in mdnest.conf.sample"
else
  bad "ENABLE_CHAT is documented in mdnest.conf.sample" "no mention in the sample conf"
fi

echo ""
printf 'setup-chat: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
