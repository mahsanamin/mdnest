#!/usr/bin/env bash
#
# mdnest-server unit tests — pure functions, no Docker, no running stack
# ──────────────────────────────────────────────────────────────────────
# Sourced via the MDNEST_SERVER_LIB hook, so it runs the ACTUAL functions
# shipped in ./mdnest-server — not copies.
#
# Usage:  tests/server-unit.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '         %s\n' "$2"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi; }
# Assertions run against whitespace-normalized output so they pin the words and
# not the column padding, which is cosmetic and free to change.
norm() { printf '%s' "$1" | tr '\n' ' ' | tr -s ' '; }
has() { case "$(norm "$2")" in *"$3"*) ok "$1" ;; *) bad "$1" "[$3] not in [$(norm "$2")]" ;; esac; }
hasnt() { case "$(norm "$2")" in *"$3"*) bad "$1" "[$3] should not be in [$(norm "$2")]" ;; *) ok "$1" ;; esac; }

# mdnest-server runs under `set -e` and cd's to its own directory; sourcing it
# applies both here. Turn `set -e` back off so a check that deliberately
# exercises the drift (non-zero) path doesn't abort the run.
MDNEST_SERVER_LIB=1 source "$REPO_ROOT/mdnest-server"
set +e

echo "=== mdnest-server unit tests ==="
echo

# ── namespace drift ─────────────────────────────────────────────────────────
# Namespaces are Docker volume mounts, so editing mdnest.conf only changes the
# desired state — the running container keeps serving the mounts it was created
# with until a reload recreates it. Nothing surfaced that gap, so a namespace
# added to the conf just never appeared, which reads as mdnest losing it rather
# than as a step not taken yet.
echo "── namespace drift ──"

out="$(namespace_drift_report "brain
work" "brain
work")"; rc=$?
eq    "in sync: reports no drift"   "0"  "$rc"
eq    "in sync: says nothing"       ""   "$out"

out="$(namespace_drift_report "brain
work" "brain")"; rc=$?
eq    "pending: reports drift"      "1"  "$rc"
has   "pending: names the namespace" "$out" "configured, not live yet: work"
has   "pending: gives the command"   "$out" "./mdnest-server reload"
hasnt "pending: no false stale"      "$out" "still served"

out="$(namespace_drift_report "brain" "brain
work")"; rc=$?
eq    "stale: reports drift"        "1"  "$rc"
has   "stale: names the namespace"   "$out" "still served, not in conf: work"
hasnt "stale: no false pending"      "$out" "not live yet"

out="$(namespace_drift_report "brain
added" "brain
removed")"; rc=$?
eq    "both directions: reports drift" "1" "$rc"
has   "both directions: lists pending" "$out" "not live yet: added"
has   "both directions: lists stale"   "$out" "not in conf: removed"

# A conf with no MOUNT_ entries yet, or a container with none: empty strings
# must not be mistaken for a namespace named "".
out="$(namespace_drift_report "" "")"; rc=$?
eq    "both empty: no drift"        "0"  "$rc"
eq    "both empty: says nothing"    ""   "$out"

out="$(namespace_drift_report "brain" "")"; rc=$?
eq    "nothing live yet: drift"     "1"  "$rc"
has   "nothing live yet: names it"   "$out" "not live yet: brain"

# Substring names must not match each other — "work" is not "workspace".
out="$(namespace_drift_report "workspace" "work")"; rc=$?
eq    "substring names are distinct" "1" "$rc"
has   "substring: workspace pending" "$out" "not live yet: workspace"
has   "substring: work is stale"     "$out" "not in conf: work"

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
