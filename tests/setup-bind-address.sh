#!/usr/bin/env bash
#
# setup.sh BIND_ADDRESS warning test — no network, no Docker
# ───────────────────────────────────────────────────────────
# Docker publishes a port only if its host IP is on an interface when the
# container starts. A Tailscale, VPN or DHCP address can come up after Docker
# does, and the container then runs with no port published and nothing logged
# (issue #126). setup.sh cannot fix that, but it can say so when the config
# depends on it. This pins that the warning appears for such an address, stays
# quiet for loopback and 0.0.0.0, and that the port mappings are unchanged.
#
# Usage:  tests/setup-bind-address.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

echo "── setup.sh: BIND_ADDRESS ──"

for quiet in "" "BIND_ADDRESS=127.0.0.1" "BIND_ADDRESS=0.0.0.0"; do
  label="${quiet:-unset BIND_ADDRESS}"
  sb="$(generate "$quiet")"
  if grep -q 'Warning: BIND_ADDRESS' "$sb/setup.out"; then
    bad "$label: no warning" "got: $(grep -A1 'Warning: BIND_ADDRESS' "$sb/setup.out")"
  else
    ok "$label: no warning"
  fi
  rm -rf "$sb"
done

sb="$(generate 'BIND_ADDRESS=127.0.0.1,100.64.0.5')"
if grep -q 'Warning: BIND_ADDRESS includes 100.64.0.5\.' "$sb/setup.out"; then
  ok "overlay IP: warning names the address"
else
  bad "overlay IP: warning names the address" "output: $(head -20 "$sb/setup.out")"
fi
if grep -q '127.0.0.1, ' "$sb/setup.out"; then
  bad "overlay IP: loopback is not listed as fragile" "$(grep 'BIND_ADDRESS includes' "$sb/setup.out")"
else
  ok "overlay IP: loopback is not listed as fragile"
fi
if grep -q '"100.64.0.5:3236:80"' "$sb/docker-compose.yml" && grep -q '"127.0.0.1:3236:80"' "$sb/docker-compose.yml"; then
  ok "overlay IP: still bound as configured (warning only)"
else
  bad "overlay IP: still bound as configured (warning only)" "$(grep -n ':3236:80' "$sb/docker-compose.yml")"
fi
rm -rf "$sb"

# A value exported in the shell must not leak in and fake a warning.
sb="$(mktemp -d)"
cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sb"/
printf 'MOUNT_test=%s/notes\n' "$sb" > "$sb/mdnest.conf"
( cd "$sb" && BIND_FRAGILE=10.0.0.9 bash setup.sh ) >"$sb/setup.out" 2>&1
if grep -q 'Warning: BIND_ADDRESS' "$sb/setup.out"; then
  bad "exported BIND_FRAGILE does not leak in" "$(grep 'Warning: BIND_ADDRESS' "$sb/setup.out")"
else
  ok "exported BIND_FRAGILE does not leak in"
fi
rm -rf "$sb"

echo ""
printf 'setup-bind-address: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
