#!/usr/bin/env bash
#
# pre-push hook — npm audit outcome classification
#
# `npm audit` exits non-zero for two completely different reasons: it found
# advisories, or it never reached the advisories endpoint. The hook used to
# discard stderr and call both of them VULNERABILITIES FOUND, so a run of 503s
# from /-/npm/v1/security/advisories/bulk blocked every push while naming the
# wrong cause. (The same outage seen from the other side is `npm audit fix`
# exiting 0 having applied nothing.)
#
# The fix classifies the two. The risk in a fix like that is reclassifying too
# much and silently disarming the check, so the load-bearing assertion here is
# "a REAL vulnerability still exits non-zero" — not the skip cases.
#
# No network: `npm_audit_check` is extracted from the hook and driven against
# fake `npm` shims that reproduce each outcome's real output.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/.githooks/pre-push"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '         %s\n' "$2"; }

echo "=== pre-push npm audit classification ==="

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-audit-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/proj"

# Pull the helper out of the hook itself, so this tests the shipped code and
# cannot drift from it.
sed -n '/^npm_audit_check()/,/^}/p' "$HOOK" > "$WORK/fn.sh"
if ! [ -s "$WORK/fn.sh" ]; then
  echo "  $(red FAIL) npm_audit_check not found in $HOOK"
  exit 1
fi
# shellcheck disable=SC1090
. "$WORK/fn.sh"

# check <label> <expected: ok|skip|block> <npm exit> <npm stderr>
check() {
  local label="$1" expect="$2" npm_rc="$3" msg="$4"
  cat > "$WORK/bin/npm" <<SHIM
#!/bin/sh
printf '%s\n' "$msg" >&2
exit $npm_rc
SHIM
  chmod +x "$WORK/bin/npm"
  local out rc=0
  out=$(PATH="$WORK/bin:$PATH" npm_audit_check "Test" "$WORK/proj" 2>&1) || rc=$?
  local got
  case "$rc:$out" in
    0:*OK*)                    got=ok ;;
    0:*SKIPPED*)               got=skip ;;
    *:*"VULNERABILITIES FOUND"*) got=block ;;
    *)                         got="unclassified(rc=$rc)" ;;
  esac
  if [ "$got" = "$expect" ]; then ok "$label -> $got"; else
    bad "$label" "expected [$expect] got [$got]: $(printf '%s' "$out" | tr -d '\n')"; fi
}

# A clean audit passes.
check "clean audit"          ok    0 "found 0 vulnerabilities"

# THE ONE THAT MATTERS. If this ever reports skip, the check is disarmed and a
# real advisory sails through the hook unnoticed.
check "real vulnerability"   block 1 "1 high severity vulnerability"
check "real vuln, moderate"  block 1 "3 vulnerabilities (2 moderate, 1 high)"

# Every shape of "npm never got an answer" seen in the wild. npm cannot have
# found a vulnerability it never received, so blocking on these is a false
# positive that points at the wrong problem.
check "endpoint error"       skip  1 "npm error audit endpoint returned an error"
check "503 Service Unavail." skip  1 "npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - Service Unavailable"
check "audit network timeout" skip 1 "npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk"
check "DNS failure"          skip  1 "npm error code ENOTFOUND"
check "DNS again"            skip  1 "npm error code EAI_AGAIN"
check "connect timeout"      skip  1 "npm error code ETIMEDOUT"
check "connection reset"     skip  1 "npm error code ECONNRESET"
check "socket hang up"       skip  1 "npm error socket hang up"

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
