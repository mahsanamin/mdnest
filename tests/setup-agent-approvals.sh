#!/usr/bin/env bash
#
# setup.sh agent-approvals switch test: no network, no Docker
# ────────────────────────────────────────────────────────────
# ENABLE_AGENT_APPROVALS lets a browser answer an agent's permission prompt on
# every machine that opted in. It travels mdnest.conf -> setup.sh -> .env ->
# the backend, and the backend ignores env it does not read, so a switch
# setup.sh forgets does not fail, it quietly stays off (or, worse, a shell
# export quietly turns it on).
#
# Pins: the configured value reaches .env; unset is written as false; a typo is
# rejected at setup time; a value exported in the shell does not leak in; the
# backend reads the name; it is documented in mdnest.conf.sample.
#
# Usage:  tests/setup-agent-approvals.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY=ENABLE_AGENT_APPROVALS

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

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

line() { grep "^$2=" "$1/.env" 2>/dev/null || echo "<no $2 line>"; }

echo "── setup.sh: $KEY ──"

# 1) Configured values reach .env verbatim.
for kv in "$KEY=true" "$KEY=false"; do
  sb="$(generate "$kv")"
  if grep -qx "$kv" "$sb/.env" 2>/dev/null; then
    ok "$kv reaches .env"
  else
    bad "$kv reaches .env" "got: $(line "$sb" "$KEY")"
  fi
  rm -rf "$sb"
done

# 2) Unset is written as false: off by default, and readable in .env.
sb="$(generate)"
if grep -qx "$KEY=false" "$sb/.env" 2>/dev/null; then
  ok "unset $KEY is written as false"
else
  bad "unset $KEY is written as false" "got: $(line "$sb" "$KEY")"
fi
rm -rf "$sb"

# 3) A typo fails setup instead of silently meaning "off".
sb="$(generate "$KEY=yes")"
if [ ! -f "$sb/.env" ] || ! grep -q "^$KEY=yes" "$sb/.env"; then
  ok "an invalid $KEY is not persisted"
else
  bad "an invalid $KEY is not persisted" "setup.sh wrote $KEY=yes to .env"
fi
if grep -q "$KEY must be" "$sb/setup.out" 2>/dev/null; then
  ok "an invalid $KEY is reported by name"
else
  bad "an invalid $KEY is reported by name" "output: $(head -3 "$sb/setup.out" 2>/dev/null)"
fi
rm -rf "$sb"

# 4) A value exported in the operator's shell must not turn it on.
sb="$(ENABLE_AGENT_APPROVALS=true generate)"
if grep -qx "$KEY=false" "$sb/.env" 2>/dev/null; then
  ok "an exported $KEY does not leak into .env"
else
  bad "an exported $KEY does not leak into .env" "got: $(line "$sb" "$KEY")"
fi
rm -rf "$sb"

# 5) The backend reads the name setup.sh writes, and it is documented.
if grep -q "\"$KEY\"" "$REPO_ROOT/backend/main.go"; then
  ok "the backend reads $KEY"
else
  bad "the backend reads $KEY" "no env(\"$KEY\") in backend/main.go"
fi
if grep -q "$KEY" "$REPO_ROOT/mdnest.conf.sample"; then
  ok "$KEY is documented in mdnest.conf.sample"
else
  bad "$KEY is documented in mdnest.conf.sample" "no mention"
fi

echo ""
printf 'setup-agent-approvals: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
