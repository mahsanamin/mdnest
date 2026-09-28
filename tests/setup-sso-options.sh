#!/usr/bin/env bash
#
# setup.sh SSO option plumbing test — no network, no Docker
# ─────────────────────────────────────────────────────────
# The SSO switches decide who can sign in, and each has to travel
# mdnest.conf -> setup.sh -> .env -> the backend. The backend reads them with a
# fallback, so a switch setup.sh forgets does not fail, it lies: before v4.5.4
# setup.sh never forwarded SSO_AUTOPROVISION_USERS or OIDC_GROUPS_CLAIM, so an
# operator who set either in mdnest.conf got neither, and nothing said so.
#
# Pins, for SSO_DISABLE_PASSWORD_LOGIN, SSO_AUTOPROVISION_USERS and
# OIDC_GROUPS_CLAIM: the configured value reaches .env; unset boolean switches
# are written as false; a typo in a boolean is rejected at setup time instead
# of silently meaning "off"; a value exported in the shell does not leak in;
# the backend reads the name; it is documented.
#
# Usage:  tests/setup-sso-options.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

# A minimal valid SSO config; placeholder credentials only.
SSO_BASE=(
  'AUTH_MODE=multi'
  'POSTGRES_PASSWORD=test'
  'USER_PROVIDER=sso'
  'SSO_ISSUER_URL=https://accounts.google.com'
  'SSO_CLIENT_ID=test-client'
  'SSO_CLIENT_SECRET=test-secret'
)

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

echo "── setup.sh: SSO options ──"

# 1) Configured values reach .env verbatim.
for kv in SSO_DISABLE_PASSWORD_LOGIN=true SSO_DISABLE_PASSWORD_LOGIN=false \
          SSO_AUTOPROVISION_USERS=true SSO_AUTOPROVISION_USERS=false \
          OIDC_GROUPS_CLAIM=groups; do
  sb="$(generate "${SSO_BASE[@]}" "$kv")"
  if grep -qx "$kv" "$sb/.env" 2>/dev/null; then
    ok "$kv reaches .env"
  else
    bad "$kv reaches .env" "got: $(line "$sb" "${kv%%=*}")"
  fi
  rm -rf "$sb"
done

# 2) Unset boolean switches are written as false, explicitly — off by default,
#    and readable in .env.
sb="$(generate "${SSO_BASE[@]}")"
for k in SSO_DISABLE_PASSWORD_LOGIN SSO_AUTOPROVISION_USERS; do
  if grep -qx "$k=false" "$sb/.env" 2>/dev/null; then
    ok "unset $k is written as false"
  else
    bad "unset $k is written as false" "got: $(line "$sb" "$k")"
  fi
done
rm -rf "$sb"

# 3) A typo in a boolean fails setup. "yes" would reach the backend, compare
#    unequal to "true", and leave the switch in the state the operator did not
#    ask for.
for k in SSO_DISABLE_PASSWORD_LOGIN SSO_AUTOPROVISION_USERS; do
  sb="$(generate "${SSO_BASE[@]}" "$k=yes")"
  if [ ! -f "$sb/.env" ] || ! grep -q "^$k=yes" "$sb/.env"; then
    ok "an invalid $k is not persisted"
  else
    bad "an invalid $k is not persisted" "setup.sh wrote $k=yes to .env"
  fi
  if grep -q "$k must be" "$sb/setup.out" 2>/dev/null; then
    ok "an invalid $k is reported by name"
  else
    bad "an invalid $k is reported by name" "output: $(head -3 "$sb/setup.out" 2>/dev/null)"
  fi
  rm -rf "$sb"
done

# 4) A value exported in the operator's shell must not leak into .env.
sb="$(SSO_AUTOPROVISION_USERS=true OIDC_GROUPS_CLAIM=leaked generate "${SSO_BASE[@]}")"
if grep -qx 'SSO_AUTOPROVISION_USERS=false' "$sb/.env" 2>/dev/null && ! grep -q 'leaked' "$sb/.env"; then
  ok "exported shell variables do not leak into .env"
else
  bad "exported shell variables do not leak into .env" \
      "got: $(line "$sb" SSO_AUTOPROVISION_USERS) / $(line "$sb" OIDC_GROUPS_CLAIM)"
fi
rm -rf "$sb"

# 5) The backend reads the name setup.sh writes, and it is documented.
for k in SSO_DISABLE_PASSWORD_LOGIN SSO_AUTOPROVISION_USERS OIDC_GROUPS_CLAIM; do
  if grep -q "\"$k\"" "$REPO_ROOT/backend/main.go"; then
    ok "the backend reads $k"
  else
    bad "the backend reads $k" "no env(\"$k\") in backend/main.go"
  fi
  if grep -q "$k" "$REPO_ROOT/mdnest.conf.sample"; then
    ok "$k is documented in mdnest.conf.sample"
  else
    bad "$k is documented in mdnest.conf.sample" "no mention"
  fi
done

echo ""
printf 'setup-sso-options: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
