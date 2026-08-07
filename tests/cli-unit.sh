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

# Load the real CLI functions without dispatching a command. The CLI runs under
# `set -e`, and sourcing it applies that to this shell too — which would abort
# the run at the first check that deliberately exercises a failure path. Turn it
# back off; each check asserts on the status it captured.
MDNEST_LIB=1 source "$REPO_ROOT/mdnest"
set +e

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

# ── list rendering ──────────────────────────────────────────────────────────
# `mdnest list <namespace>` used to print the raw API JSON, which is unreadable
# for a namespace of any size (issue #87). These pin the tree rendering: it is
# awk-only by design, so it must produce byte-identical output on every machine
# — no python3/jq tier to disagree with. The names below are written the way the
# Go API actually encodes them: \u0026 for &, \u003c/\u003e for <>, \" for a
# quote — so the string decoder is covered too, not just the layout.
TREE_JSON='{"name":"root","type":"folder","children":[{"name":"docs","type":"folder","path":"docs","children":[{"name":"a \u0026 b \u003cx\u003e.md","type":"file","path":"docs/a \u0026 b \u003cx\u003e.md"},{"name":"deep","type":"folder","path":"docs/deep","children":[{"name":"q\"uote.md","type":"file","path":"docs/deep/q\"uote.md"}]}]},{"name":"empty","type":"folder","path":"empty"},{"name":"top.md","type":"file","path":"top.md"}]}'

run_list_suite() {
  echo "── $1 ──"
  local want got

  want='ns
├── docs/
│   ├── a & b <x>.md
│   └── deep/
│       └── q"uote.md
├── empty/
└── top.md

3 folders, 3 files'
  eq "tree: whole namespace" "$want" "$(format_tree "$TREE_JSON" ns)"

  want='ns/docs
├── a & b <x>.md
└── deep/
    └── q"uote.md

1 folder, 2 files'
  eq "tree: scoped to a subfolder" "$want" "$(format_tree "$TREE_JSON" ns/docs docs)"

  eq "tree: scoped to a file"  "ns/top.md"    "$(format_tree "$TREE_JSON" ns/top.md top.md)"
  eq "tree: empty folder"      "ns/empty
  (empty)"                                    "$(format_tree "$TREE_JSON" ns/empty empty)"

  got="$(format_tree "$TREE_JSON" ns/nope nope 2>/dev/null)"; local rc=$?
  eq "tree: missing path fails"    "3"  "$rc"
  eq "tree: missing path is quiet" ""   "$got"
  eq "tree: missing path explains itself" "Error: path not found in namespace: nope" \
     "$(format_tree "$TREE_JSON" ns/nope nope 2>&1 >/dev/null)"

  eq "namespaces: one per line" "one
two & three" "$(format_namespaces '["one","two & three"]')"
}

# ── login argument handling ─────────────────────────────────────────────────
# Four bugs were reported together against v4.1.1, all in `mdnest login`:
#   * an unreachable server was reported as "this server has no SERVER_ALIAS
#     configured" — a claim about an mdnest.conf we never read;
#   * the recovery hint was rebuilt from the raw positionals, so it preserved
#     the user's bad argument and silently dropped the token;
#   * the hint's placeholder was `@<name>`, and `<name>` is a shell
#     redirection, so pasting the suggested fix errored in zsh and bash;
#   * a non-URL was written to disk anyway with only a warning, and on a fresh
#     machine became the DEFAULT server — aiming every later command at it.
# The e2e checks run the real CLI as a subprocess against a throwaway HOME, so
# they also pin that a rejected login leaves nothing behind. No network needed:
# the unreachable case points at a closed port on localhost.
LOGIN_RC=0
LOGIN_HOME=""
LOGIN_OUT=""
# Runs the real CLI and leaves its combined output in $LOGIN_OUT, its status in
# $LOGIN_RC, and its throwaway config dir in $LOGIN_HOME. Deliberately NOT via
# command substitution: that runs in a subshell, so the HOME and status it set
# would be lost and every assertion on them would pass vacuously.
login_run() {
  LOGIN_HOME="$(mktemp -d "$SHIM_DIR/home.XXXXXX")"
  LOGIN_RC=0
  LOGIN_OUT="$(HOME="$LOGIN_HOME" "$REPO_ROOT/mdnest" login "$@" 2>&1)" || LOGIN_RC=$?
}
# Every command we print for the user to RUN must be pasteable as-is. Angle
# brackets are the trap: the shell reads them as redirections.
no_angle_brackets() {
  case "$1" in *'<'*|*'>'*) return 1 ;; *) return 0 ;; esac
}
saved_files() { find "$LOGIN_HOME" -type f 2>/dev/null | wc -l | tr -d ' '; }

run_login_suite() {
  echo "── login argument handling ──"
  local out

  eq "valid_url: https"          "0" "$(valid_url 'https://x.example.com'; echo $?)"
  eq "valid_url: http"           "0" "$(valid_url 'http://x.example.com'; echo $?)"
  eq "valid_url: bare word"      "1" "$(valid_url 'pnest'; echo $?)"
  eq "valid_url: scheme only"    "1" "$(valid_url 'https://'; echo $?)"
  eq "valid_url: no scheme"      "1" "$(valid_url 'x.example.com'; echo $?)"
  eq "curl_reason: DNS"          "the host name could not be resolved (DNS)" "$(curl_reason 6)"
  eq "curl_reason: refused"      "the connection was refused"               "$(curl_reason 7)"
  eq "curl_reason: unknown code" "curl exited 99"                           "$(curl_reason 99)"
  eq "parse_server_alias"        "my-srv" "$(parse_server_alias "$CONFIG_JSON")"
  eq "parse_server_alias: none"  ""       "$(parse_server_alias '{"version":"1.0.0"}')"

  # Alias without its '@' — the hint must name the same server AND keep the
  # token, so it works verbatim.
  login_run pnest https://pnest.example.com mdnest_abc123; out="$LOGIN_OUT"
  eq "login: missing @ fails"   "1" "$LOGIN_RC"
  eq "login: missing @ saves nothing" "0" "$(saved_files)"
  case "$out" in
    *"mdnest login @pnest https://pnest.example.com mdnest_abc123"*)
      ok "login: missing-@ hint is runnable verbatim" ;;
    *) bad "login: missing-@ hint is runnable verbatim" "got [$out]" ;;
  esac
  if no_angle_brackets "$out"; then ok "login: missing-@ hint is paste-safe"
  else bad "login: missing-@ hint is paste-safe" "angle brackets in [$out]"; fi

  # A non-URL must never reach the config directory.
  login_run @tmptest aaa bbb; out="$LOGIN_OUT"
  eq "login: non-URL fails"        "1" "$LOGIN_RC"
  eq "login: non-URL saves nothing" "0" "$(saved_files)"
  if no_angle_brackets "$out"; then ok "login: non-URL hint is paste-safe"
  else bad "login: non-URL hint is paste-safe" "angle brackets in [$out]"; fi

  # Unreachable server: say we couldn't reach it, and say NOTHING about the
  # server's SERVER_ALIAS — we never got to look at it. Mentioning that knob at
  # all is what sent people off to edit and rebuild a blameless server.
  login_run http://127.0.0.1:1 mdnest_tok; out="$LOGIN_OUT"
  eq "login: unreachable fails" "1" "$LOGIN_RC"
  eq "login: unreachable saves nothing" "0" "$(saved_files)"
  case "$out" in
    *"couldn't reach"*) ok "login: unreachable says so" ;;
    *) bad "login: unreachable says so" "got [$out]" ;;
  esac
  case "$out" in
    *SERVER_ALIAS*) bad "login: unreachable doesn't blame the server's config" "got [$out]" ;;
    *) ok "login: unreachable doesn't blame the server's config" ;;
  esac
  if no_angle_brackets "$out"; then ok "login: unreachable hint is paste-safe"
  else bad "login: unreachable hint is paste-safe" "angle brackets in [$out]"; fi

  # A stray extra positional is rejected, not ignored.
  login_run @tmptest https://x.example.com mdnest_tok extra; out="$LOGIN_OUT"
  eq "login: extra arg fails"        "1" "$LOGIN_RC"
  eq "login: extra arg saves nothing" "0" "$(saved_files)"
  case "$out" in
    *"too many arguments"*) ok "login: extra arg says which form is right" ;;
    *) bad "login: extra arg says which form is right" "got [$out]" ;;
  esac
}

echo "=== mdnest CLI unit tests ==="
echo

# Pass 1: whatever parser is actually present (python3 on most machines).
if command -v python3 >/dev/null 2>&1; then
  run_suite "with python3"
else
  echo "── (python3 not present — skipping the python3 pass) ──"
fi
run_list_suite "list rendering"

# Passes 2 and 3 need a python3 stand-in on PATH, so they're driven through a
# shim directory. This is the issue-#87 class of bug: on the reporter's Fedora
# box a stale matplotlib .pth made EVERY python3 start print a traceback to
# stderr, and that traceback landed in the middle of mdnest's output. The CLI
# must (a) not leak python's stderr, and (b) still produce correct values —
# whether python3 is merely noisy or outright broken.
REAL_PY="$(command -v python3 || true)"
SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-unit.XXXXXX")"
trap 'rm -rf "$SHIM_DIR"' EXIT

make_shim() {  # make_shim <mode: noisy|broken>
  # PATH is restored to the pre-shim value before exec'ing the real python3:
  # a version-manager shim (pyenv et al.) re-resolves "python3" through PATH,
  # which would otherwise find this shim again and recurse forever.
  cat > "$SHIM_DIR/python3" <<SHIM
#!/bin/sh
echo "Error processing line 1 of /home/u/.local/lib/python3.14/site-packages/x-nspkg.pth:" >&2
echo "AttributeError: 'NoneType' object has no attribute 'loader'" >&2
echo "Remainder of file ignored" >&2
$([ "$1" = "broken" ] && echo 'exit 1' || printf 'PATH=%s; export PATH; exec "%s" "$@"' "'$PATH'" "$REAL_PY")
SHIM
  chmod +x "$SHIM_DIR/python3"
}

# Pass 2: python3 works but prints startup noise on every run (the exact repro).
if [ -n "$REAL_PY" ]; then
  make_shim noisy
  PATH="$SHIM_DIR:$PATH" run_suite "noisy python3 (broken .pth on stderr)"
  eq "noisy python3: nothing leaks to stderr" "" \
     "$(PATH="$SHIM_DIR:$PATH" urlencode '19 Jun 2026.md' 2>&1 >/dev/null)"
  eq "noisy python3: json parse leaks nothing" "" \
     "$(printf '%s' "$CONFIG_JSON" | PATH="$SHIM_DIR:$PATH" json_top_string version 2>&1 >/dev/null)"
else
  echo "── (python3 not present — skipping the noisy-python3 pass) ──"
fi

# Pass 3: python3 is present but exits non-zero — the CLI must degrade to the
# pure-bash/awk fallbacks instead of returning empty/wrong values.
make_shim broken
PATH="$SHIM_DIR:$PATH" run_suite "broken python3 (exits 1)"
eq "broken python3: nothing leaks to stderr" "" \
   "$(PATH="$SHIM_DIR:$PATH" urlencode 'x&y=z?q' 2>&1 >/dev/null)"

# Pass 4: force the pure-bash/awk fallbacks by making `have` deny python3 + jq.
# This is the fresh-machine path — the one the recent regression broke.
have() { case "$1" in python3|jq) return 1 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
run_suite "fallback (no python3/jq)"
# Same listings again with no parser at all: the rendering must be identical,
# since it is awk-only. A difference here means a python3/jq tier crept back in.
run_list_suite "list rendering (no python3/jq)"

# Argument handling is pure bash and parser-independent, so it runs once. It
# needs SHIM_DIR for its throwaway HOMEs, hence its place at the end.
run_login_suite

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
