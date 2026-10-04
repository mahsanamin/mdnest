#!/usr/bin/env bash
#
# setup.sh DOWNLOAD_* plumbing test — no network, no Docker
# ─────────────────────────────────────────────────────────
# DOWNLOAD_MAX_FILES / DOWNLOAD_MAX_MB / DOWNLOAD_MAX_CONCURRENT bound folder
# downloads and cross-namespace transfers. They travel mdnest.conf -> setup.sh
# -> .env -> the backend container, and the backend falls back to its default
# for a value it cannot use. That fallback is the hazard: a knob that never
# reaches .env, or a typo in one, does not fail — the server just quietly runs
# on the defaults. So this pins both directions: configured values reach .env,
# unset ones are written as the defaults, and a non-number is refused at setup.
#
# Usage:  tests/setup-download-limits.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

# Run setup.sh in a sandbox with the given extra conf lines. Echoes the sandbox
# path; the caller inspects .env / setup.out and removes it.
generate() {
  local sandbox
  sandbox="$(mktemp -d)"
  cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sandbox"/
  {
    printf 'MOUNT_test=%s/notes\n' "$sandbox"
    printf '%s\n' "$@"
  } > "$sandbox/mdnest.conf"
  ( cd "$sandbox" && env -u DOWNLOAD_MAX_FILES -u DOWNLOAD_MAX_MB -u DOWNLOAD_MAX_CONCURRENT bash setup.sh ) >"$sandbox/setup.out" 2>&1
  echo $? > "$sandbox/setup.rc"
  printf '%s' "$sandbox"
}

line() { grep "^$2=" "$1/.env" 2>/dev/null || echo "<no $2 line>"; }

echo "── setup.sh: DOWNLOAD_* limits ──"

sb="$(generate 'DOWNLOAD_MAX_FILES=1200' 'DOWNLOAD_MAX_MB=250' 'DOWNLOAD_MAX_CONCURRENT=4')"
for kv in DOWNLOAD_MAX_FILES=1200 DOWNLOAD_MAX_MB=250 DOWNLOAD_MAX_CONCURRENT=4; do
  if grep -qx "$kv" "$sb/.env" 2>/dev/null; then
    ok "$kv reaches .env"
  else
    bad "$kv reaches .env" "got: $(line "$sb" "${kv%%=*}")"
  fi
done
rm -rf "$sb"

sb="$(generate)"
for kv in DOWNLOAD_MAX_FILES=500 DOWNLOAD_MAX_MB=100 DOWNLOAD_MAX_CONCURRENT=2; do
  if grep -qx "$kv" "$sb/.env" 2>/dev/null; then
    ok "unset ${kv%%=*} is written as the default (${kv#*=})"
  else
    bad "unset ${kv%%=*} is written as the default" "got: $(line "$sb" "${kv%%=*}")"
  fi
done
rm -rf "$sb"

for bad_value in 'DOWNLOAD_MAX_MB=100MB' 'DOWNLOAD_MAX_FILES=0' 'DOWNLOAD_MAX_CONCURRENT=-1'; do
  sb="$(generate "$bad_value")"
  if [ "$(cat "$sb/setup.rc")" != "0" ] && grep -q "${bad_value%%=*} must be a positive whole number" "$sb/setup.out"; then
    ok "$bad_value is refused at setup"
  else
    bad "$bad_value is refused at setup" "setup exited $(cat "$sb/setup.rc"); .env has $(line "$sb" "${bad_value%%=*}")"
  fi
  rm -rf "$sb"
done

# A value exported in the operator's shell must not leak into .env.
sb="$(mktemp -d)"
cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sb"/
printf 'MOUNT_test=%s/notes\n' "$sb" > "$sb/mdnest.conf"
( cd "$sb" && DOWNLOAD_MAX_MB=7 bash setup.sh ) >/dev/null 2>&1
if grep -qx 'DOWNLOAD_MAX_MB=100' "$sb/.env" 2>/dev/null; then
  ok "a DOWNLOAD_MAX_MB exported in the shell does not leak into .env"
else
  bad "a DOWNLOAD_MAX_MB exported in the shell does not leak into .env" "got: $(line "$sb" DOWNLOAD_MAX_MB)"
fi
rm -rf "$sb"

for knob in DOWNLOAD_MAX_FILES DOWNLOAD_MAX_MB DOWNLOAD_MAX_CONCURRENT; do
  if grep -q "$knob" "$REPO_ROOT/mdnest.conf.sample" && grep -q "$knob" "$REPO_ROOT/deploy/compose/docker-compose.yml" \
     && grep -q "$knob" "$REPO_ROOT/deploy/helm/mdnest/templates/configmap-env.yaml" && grep -rqF "\"$knob\"" "$REPO_ROOT/backend" --include='*.go'; then
    ok "$knob is in the sample conf, the plain compose file, the Helm configmap, and read by the backend"
  else
    bad "$knob is documented and read everywhere" "missing from one of: mdnest.conf.sample, deploy/compose, Helm configmap, backend"
  fi
done

echo ""
printf 'setup-download-limits: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
