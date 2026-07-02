#!/usr/bin/env bash
#
# mdnest CLI unit tests — pure functions, no network, no Docker
# ─────────────────────────────────────────────────────────────
# Fast (<1s) checks of the CLI's pure helpers, run TWICE: once with the real
# python3 parser, and once with python3/jq force-disabled to exercise the
# pure-bash/awk fallbacks. This is the cheap guard that catches the class of
# regression that broke the CLI on a fresh machine (a hard python3 dependency
# with no fallback), without needing a running server.
#
# Sourced via the CLI's MDNEST_LIB test hook, so it runs the ACTUAL functions
# shipped in ./mdnest — not copies.
#
# Usage:  tests/cli-unit.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '         %s\n' "$2"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi; }

# Load the real CLI functions without dispatching a command.
MDNEST_LIB=1 source "$REPO_ROOT/mdnest"

# A representative /api/config body: latestRelease.version ("3.11.1") comes
# BEFORE the top-level version ("9.9.9-test"), so a naive grep|head picks the
# WRONG one. The parser MUST return the top-level value.
CONFIG_JSON='{"authMode":"single","commit":"abc1234","latestRelease":{"name":"v3.11.1","notes":"has {braces} and \"quotes\"","version":"3.11.1"},"serverAlias":"my-srv","version":"9.9.9-test"}'

run_suite() {
  local mode="$1"
  echo "── $mode ──"
  eq "urlencode: spaces"            "19%20Jun%202026.md"        "$(urlencode '19 Jun 2026.md')"
  eq "urlencode: keeps slashes"     "a/b%20c.md"                "$(urlencode 'a/b c.md')"
  eq "urlencode: reserved & = ?"    "x%26y%3Dz%3Fq"             "$(urlencode 'x&y=z?q')"
  eq "urldecode: spaces"            "19 Jun 2026.md"            "$(urldecode '19%20Jun%202026.md')"
  eq "urldecode: round-trip"        "a/b c&d=e.md"              "$(urldecode "$(urlencode 'a/b c&d=e.md')")"
  eq "urldecode: utf-8 ellipsis"    "note….md"                 "$(urldecode 'note%E2%80%A6.md')"
  eq "json: top-level version"      "9.9.9-test"                "$(printf '%s' "$CONFIG_JSON" | json_top_string version)"
  eq "json: commit"                 "abc1234"                   "$(printf '%s' "$CONFIG_JSON" | json_top_string commit)"
  eq "json: serverAlias"            "my-srv"                    "$(printf '%s' "$CONFIG_JSON" | json_top_string serverAlias)"
  eq "json: missing field is empty" ""                          "$(printf '%s' "$CONFIG_JSON" | json_top_string nope)"
}

echo "=== mdnest CLI unit tests ==="
echo

# Pass 1: whatever parser is actually present (python3 on most machines).
if command -v python3 >/dev/null 2>&1; then
  run_suite "with python3"
else
  echo "── (python3 not present — skipping the python3 pass) ──"
fi

# Pass 2: force the pure-bash/awk fallbacks by making `have` deny python3 + jq.
# This is the fresh-machine path — the one the recent regression broke.
have() { case "$1" in python3|jq) return 1 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
run_suite "fallback (no python3/jq)"

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
