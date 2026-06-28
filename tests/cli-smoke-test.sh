#!/usr/bin/env bash
#
# mdnest CLI smoke-test harness
# ─────────────────────────────
# Exercises every mdnest CLI note operation end-to-end against a dedicated,
# disposable namespace so a code change can be verified to not have broken
# anything. Designed to be run after any change to the `mdnest` CLI.
#
# Usage:
#   tests/cli-smoke-test.sh
#
# Configuration (env vars, all optional):
#   MDNEST_BIN          Path to the CLI under test   (default: ./mdnest in repo root)
#   MDNEST_TEST_NS      Namespace to test against    (default: testing_workspace)
#   MDNEST_TEST_ALIAS   Server alias to prefix paths (default: none → single-server shorthand)
#
# The harness creates everything under a unique, prefixed folder inside the
# test namespace and deletes it on exit, so it never touches real notes.
#
# Exit code: 0 if every check passes, 1 if any check fails.

set -uo pipefail

# ── Locate the CLI under test (prefer the working-tree copy) ────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MDNEST_BIN="${MDNEST_BIN:-$REPO_ROOT/mdnest}"
NS="${MDNEST_TEST_NS:-testing_workspace}"
ALIAS="${MDNEST_TEST_ALIAS:-}"

# Base path: "@alias/ns" when an alias is given, else single-server "ns" shorthand.
BASE="${ALIAS:+@${ALIAS}/}${NS}"

# Unique, self-cleaning working folder for this run.
RUN_DIR="__clitest_$$_${RANDOM}"
ROOT="${BASE}/${RUN_DIR}"

PASS=0
FAIL=0

# ── Tiny assertion helpers ──────────────────────────────────────────────────
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

ok()   { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; [ -n "${2:-}" ] && printf '         %s\n' "$2"; }

# assert_eq <label> <expected> <actual>
assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}
# assert_contains <label> <needle> <haystack>
assert_contains() {
  case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "[$2] not found in [$3]" ;; esac
}
# assert_succeeds <label> -- <cmd...>
assert_succeeds() {
  local label="$1"; shift; [ "$1" = "--" ] && shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else bad "$label" "command failed (exit $?): $*"; fi
}
# assert_fails <label> -- <cmd...>  (command MUST exit non-zero)
assert_fails() {
  local label="$1"; shift; [ "$1" = "--" ] && shift
  if "$@" >/dev/null 2>&1; then bad "$label" "command unexpectedly succeeded: $*"; else ok "$label"; fi
}

m() { "$MDNEST_BIN" "$@"; }

cleanup() { m delete "$ROOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "=== mdnest CLI smoke test ==="
echo "  binary : $MDNEST_BIN"
echo "  target : $ROOT"
echo

# ── Preflight: binary exists and server reachable ───────────────────────────
[ -x "$MDNEST_BIN" ] || { echo "$(red FATAL): CLI not found/executable at $MDNEST_BIN"; exit 1; }

# ── 1. create (inline content) ──────────────────────────────────────────────
m create "$ROOT/inline.md" "# Inline" >/dev/null 2>&1
assert_eq "create (inline) writes body" "# Inline" "$(m read "$ROOT/inline.md" 2>/dev/null)"

# ── 2. create (stdin via -) — the core regression: body must NOT be "-" ─────
printf '%s' "# From stdin" | m create "$ROOT/stdin.md" - >/dev/null 2>&1
assert_eq "create (stdin -) writes piped body, not '-'" "# From stdin" "$(m read "$ROOT/stdin.md" 2>/dev/null)"

# ── 3. create with '-' but nothing piped → must fail, no file ───────────────
assert_fails "create '-' with no stdin fails" -- m create "$ROOT/nope.md" - </dev/null
assert_fails "  …and no file was created" -- m read "$ROOT/nope.md"

# ── 4. create with empty content → must fail, no file ───────────────────────
assert_fails "create empty content fails" -- m create "$ROOT/empty.md" ""
assert_fails "  …and no file was created" -- m read "$ROOT/empty.md"

# ── 5. create duplicate → must fail (create = NEW file only) ────────────────
assert_fails "create on existing path fails" -- m create "$ROOT/inline.md" "dup"

# ── 6. write (overwrite existing) ───────────────────────────────────────────
m write "$ROOT/inline.md" "# Overwritten" >/dev/null 2>&1
assert_eq "write overwrites existing" "# Overwritten" "$(m read "$ROOT/inline.md" 2>/dev/null)"

# ── 7. write to missing path → must fail (404) ──────────────────────────────
assert_fails "write to missing path fails" -- m write "$ROOT/ghost.md" "x"

# ── 8. write empty content → must fail ──────────────────────────────────────
assert_fails "write empty content fails" -- m write "$ROOT/inline.md" ""

# ── 9. append / prepend ordering ────────────────────────────────────────────
printf '%s' "mid" | m create "$ROOT/order.md" - >/dev/null 2>&1
printf '%s' "bottom" | m append  "$ROOT/order.md" - >/dev/null 2>&1
printf '%s' "top"    | m prepend "$ROOT/order.md" - >/dev/null 2>&1
body="$(m read "$ROOT/order.md" 2>/dev/null)"
assert_contains "append/prepend produce ordered body" "top" "$body"
# top must come before mid which comes before bottom
expected="$(printf 'top\nmid\nbottom')"
assert_eq "append/prepend exact order" "$expected" "$body"

# ── 10. append empty → must fail ────────────────────────────────────────────
assert_fails "append empty content fails" -- m append "$ROOT/order.md" ""

# ── 11. move / rename within namespace ──────────────────────────────────────
m create "$ROOT/src.md" "moving" >/dev/null 2>&1
m move "$ROOT/src.md" "${RUN_DIR}/dst.md" >/dev/null 2>&1
assert_eq "move places file at new path" "moving" "$(m read "$ROOT/dst.md" 2>/dev/null)"
assert_fails "move removes the old path" -- m read "$ROOT/src.md"

# ── 11b. move with a full/ns-qualified destination keeps the content ─────────
# (Regression: a full "@alias/ns/path" or "ns/path" destination used to relocate
# the file to a bogus path, so the destination read empty / 404'd.)
m move "$ROOT/dst.md" "$ROOT/dst2.md" >/dev/null 2>&1
assert_eq "move with full destination keeps content" "moving" "$(m read "$ROOT/dst2.md" 2>/dev/null)"
assert_succeeds "moved file is writable (not orphaned)" -- m write "$ROOT/dst2.md" "rewritten"

# ── 12. search finds a unique token ─────────────────────────────────────────
token="zzq${RANDOM}marker"
printf '%s' "needle $token here" | m create "$ROOT/search.md" - >/dev/null 2>&1
sleep 1   # let any search index/cache settle
assert_contains "search finds unique token" "$token" "$(m search "$BASE" "$token" 2>/dev/null)"

# ── 13. list shows the namespace tree ───────────────────────────────────────
assert_contains "list namespace returns the run folder" "$RUN_DIR" "$(m list "$BASE" 2>/dev/null)"

# ── 13b. list scopes to a subfolder (not the whole namespace) ────────────────
sublist="$(m list "$ROOT" 2>/dev/null)"
assert_contains "list subfolder is scoped to that folder" "\"name\": \"$RUN_DIR\"" "$sublist"
assert_contains "list subfolder shows its own files" "order.md" "$sublist"
assert_fails "list missing subfolder errors" -- m list "$ROOT/does-not-exist"

# ── 14. delete removes a file ───────────────────────────────────────────────
m delete "$ROOT/search.md" >/dev/null 2>&1
assert_fails "delete removes the file" -- m read "$ROOT/search.md"

# ── 15. mdnest:// copy-path URI with %-encoding decodes to the right file ────
m create "$ROOT/sp ace.md" "spaced body" >/dev/null 2>&1
assert_eq "mdnest:// URI percent-decodes to the spaced file" "spaced body" "$(m read "mdnest://${BASE}/${RUN_DIR}/sp%20ace.md" 2>/dev/null)"
m delete "$ROOT/sp ace.md" >/dev/null 2>&1

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
