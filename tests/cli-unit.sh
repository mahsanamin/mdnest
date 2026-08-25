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

# ── unreachable servers must degrade, not kill the script ───────────────────
# `mdnest servers` printed the table header, then exited with curl's own 28 and
# nothing else, whenever ANY registered server was unreachable. The cause is a
# shell trap rather than a networking one: the CLI runs under `set -e`, and a
# plain `cfg=$(curl ...)` assignment takes the command substitution's exit
# status — so the script died mid-loop, before the first row, and every branch
# written for this exact case (the `unreachable (DNS|refused|timeout|TLS)`
# labels, the "works in your browser?" hint, api()'s three error messages) was
# unreachable code. Because the server list is globbed alphabetically, one dead
# server also hid every healthy server sorting after it.
#
# Both fixtures point at closed ports on loopback: connection-refused is
# instant, needs no network, and triggers the identical failure path a timeout
# does — the bug fires on any non-zero curl status, not on a particular one.
srv_home() {  # srv_home <alias>=<url> ...
  local home; home="$(mktemp -d "$SHIM_DIR/srv.XXXXXX")"
  mkdir -p "$home/.config/mdnest/servers"
  local pair
  for pair in "$@"; do
    printf 'url=%s\ntoken=mdnest_tok\n' "${pair#*=}" > "$home/.config/mdnest/servers/${pair%%=*}"
  done
  printf '%s' "$home"
}

run_unreachable_suite() {
  echo "── unreachable servers ──"
  local home out rc

  home="$(srv_home aa-dead=http://127.0.0.1:1 zz-later=http://127.0.0.1:2)"
  echo aa-dead > "$home/.config/mdnest/default"
  rc=0; out="$(HOME="$home" "$REPO_ROOT/mdnest" servers 2>&1)" || rc=$?

  # The headline symptom: a command that only reports status leaked curl's exit
  # code. Anything non-zero here means the script died inside the loop again.
  eq "servers: unreachable server still exits 0" "0" "$rc"

  # One row per registered server. Counting rows is what pins the "alphabetical
  # glob hid the healthy servers" half of the bug — asserting only on aa-dead
  # would still pass with zz-later silently dropped.
  eq "servers: prints a row per registered server" "2" \
     "$(printf '%s\n' "$out" | grep -c '^  @')"
  case "$out" in
    *"@aa-dead"*)  ok "servers: names the dead server" ;;
    *) bad "servers: names the dead server" "got [$out]" ;;
  esac
  case "$out" in
    *"@zz-later"*) ok "servers: a dead server doesn't hide the ones after it" ;;
    *) bad "servers: a dead server doesn't hide the ones after it" "got [$out]" ;;
  esac

  # The label and the hint are the handling that used to be dead code.
  case "$out" in
    *"unreachable ("*) ok "servers: labels why it's unreachable" ;;
    *) bad "servers: labels why it's unreachable" "got [$out]" ;;
  esac
  case "$out" in
    *"unreachable (curl 0)"*)
      bad "servers: label carries the real curl code" "reported curl 0 — a stray 'curl_rc=\$?' is overwriting it" ;;
    *) ok "servers: label carries the real curl code" ;;
  esac
  case "$out" in
    *"working in your browser"*) ok "servers: prints the recovery hint" ;;
    *) bad "servers: prints the recovery hint" "got [$out]" ;;
  esac

  # -v adds a namespace probe with the same shape; it must not reintroduce the
  # abort when the probe itself fails.
  rc=0; out="$(HOME="$home" "$REPO_ROOT/mdnest" servers -v 2>&1)" || rc=$?
  eq "servers -v: unreachable server still exits 0" "0" "$rc"
  eq "servers -v: prints a row per registered server" "2" \
     "$(printf '%s\n' "$out" | grep -c '^  @')"

  # api() had the same unguarded assignment, so every read/write against an
  # unreachable server printed nothing at all and exited with curl's code.
  rc=0; out="$(HOME="$home" "$REPO_ROOT/mdnest" read @aa-dead/ns/x.md 2>&1)" || rc=$?
  eq "read: unreachable exits 1, not curl's code" "1" "$rc"
  case "$out" in
    *"connection refused"*) ok "read: unreachable says why" ;;
    *) bad "read: unreachable says why" "got [$out]" ;;
  esac
}

# ── errexit lint: the class of bug that produced this release ───────────────
# `set -e` plus a PLAIN assignment from a command substitution is a silent
# script-killer: the assignment takes the substitution's exit status, so the
# script dies on that line and everything written below it — including the
# error handling for exactly that case — never runs. It bit the CLI in five
# places at once (v4.3.2), each one leaving handling that had been written,
# reviewed, and never executed.
#
# The behavioural suites above are the real guard; this is the cheap mechanical
# one that catches a NEW site the moment it's added, in any command, without
# anyone having to think of the failing path. It is scoped to `mdnest` on
# purpose: that is the script downloaded onto other people's machines, where a
# silent death is invisible. (`mdnest-server` runs on the operator's own box
# and still has unguarded sites — a separate audit, not a silent gap.)
#
# `local x=$(...)` is deliberately exempt. `local` is a builtin, so the
# assignment's status is the builtin's own and errexit does not fire. That was
# verified against bash, not assumed, which is why the CLI is full of them.
ERREXIT_LINT='
{ line[NR] = $0 }
END {
  for (n = 1; n <= NR; n++) {
    s = line[n]
    if (s ~ /^[[:space:]]*(local|declare|export|readonly|typeset)[[:space:]]/) continue
    if (s !~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=\$\(/) continue
    if (s ~ /\)[[:space:]]*(\|\||&&)/) continue          # x=$(...) || x=""
    if (s ~ /\|\|[[:space:]]*(true|echo|:)[^)]*\)/) continue  # $(cmd || true)

    var = s; sub(/^[[:space:]]*/, "", var); sub(/=\$\(.*/, "", var)

    # A statement that does not close on its own line continues — via a
    # trailing backslash or an open quote. Rather than balance parentheses
    # (the awk-fallback blocks are full of them, inside strings), look ahead
    # for this variable name’s own guard, which is unambiguous.
    if (s ~ /\)[[:space:]]*$/) { bad(n, s); continue }
    guarded = 0
    for (i = n + 1; i <= NR && i <= n + 60; i++) {
      if (line[i] ~ ("\\|\\|[[:space:]]*(" var "=|true|:|return)")) { guarded = 1; break }
      if (line[i] ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=\$\(/) break
    }
    if (!guarded) bad(n, s)
  }
}
function bad(n, s) { printf "  %s:%d: %s\n", FILENAME, n, s }
'

run_errexit_lint() {
  echo "── errexit lint (mdnest) ──"
  local findings
  findings="$(awk "$ERREXIT_LINT" "$REPO_ROOT/mdnest")" || findings=""
  if [ -z "$findings" ]; then
    ok "errexit: every command substitution assignment is guarded"
  else
    bad "errexit: every command substitution assignment is guarded" \
        "unguarded under set -e — add '|| var=\"\"':
$findings"
  fi

  # The lint has to actually fail on the shape it exists to catch, or a green
  # run means nothing. Three shapes it must NOT flag, one it must.
  local probe; probe="$SHIM_DIR/errexit-probe.sh"
  cat > "$probe" <<'PROBE'
a=$(false)
b=$(printf x) || b=""
local c=$(false)
d=$(cmd \
  --flag) || d=""
e=$(cmd || true)
PROBE
  local hits; hits="$(awk "$ERREXIT_LINT" "$probe" | wc -l | tr -d ' ')" || hits=""
  eq "errexit lint: flags exactly the unguarded form" "1" "$hits"
  case "$(awk "$ERREXIT_LINT" "$probe")" in
    *':1: a=$(false)'*) ok "errexit lint: names the offending line" ;;
    *) bad "errexit lint: names the offending line" "got [$(awk "$ERREXIT_LINT" "$probe")]" ;;
  esac
}

# ── version comparison + the "your CLI is stale" notice ─────────────────────
# The CLI is pull-only: nothing pushes an update, and until v4.3.2 the only
# version check was a MAJOR-version mismatch at login. That meant a client
# could sit on a broken point release indefinitely without a word — which is
# exactly what happened with the errexit bug, shipped in every release since
# v1.0 and never surfaced to anyone running it.
#
# version_gt is pure bash on purpose (no python3, no jq, no `sort -V` — busybox
# sort has no -V), so it runs on the fresh-machine tier like everything else.
run_version_suite() {
  echo "── version comparison ──"
  gt() { version_gt "$1" "$2" && echo yes || echo no; }

  eq "version_gt: patch newer"      "yes" "$(gt 4.3.2 4.3.1)"
  eq "version_gt: patch older"      "no"  "$(gt 4.3.1 4.3.2)"
  eq "version_gt: equal"            "no"  "$(gt 4.3.2 4.3.2)"
  eq "version_gt: minor newer"      "yes" "$(gt 4.4.0 4.3.9)"
  eq "version_gt: major newer"      "yes" "$(gt 5.0.0 4.9.9)"
  eq "version_gt: major older"      "no"  "$(gt 4.9.9 5.0.0)"
  eq "version_gt: leading v"        "yes" "$(gt v4.3.2 v4.3.1)"
  eq "version_gt: two-field version" "yes" "$(gt 4.4 4.3.9)"
  # Numeric, not lexical: "10" must beat "9", which a string compare gets wrong.
  eq "version_gt: 4.10.0 > 4.9.0"   "yes" "$(gt 4.10.0 4.9.0)"
  eq "version_gt: 4.9.0 < 4.10.0"   "no"  "$(gt 4.9.0 4.10.0)"
  # Pre-release: a release outranks the -dev that was its candidate, so a
  # develop build never nags about the release it is ahead of.
  eq "version_gt: release beats -dev" "yes" "$(gt 4.3.2 4.3.2-dev)"
  eq "version_gt: -dev loses to release" "no" "$(gt 4.3.2-dev 4.3.2)"
  eq "version_gt: -dev vs older release" "yes" "$(gt 4.3.2-dev 4.3.1)"
  # Garbage must not crash [ -gt ] or report a bogus upgrade.
  eq "version_gt: unparseable input"  "no"  "$(gt '' 4.3.2)"
  eq "version_gt: non-numeric field"  "no"  "$(gt 4.x.y 4.3.2)"
  # A doubled value must not fabricate an upgrade. This is not hypothetical:
  # cmd_login pulled the server version with `grep -o '"version":"[^"]*"'`,
  # and /api/config carries BOTH a top-level version and latestRelease.version
  # — so it returned two lines. Field three then read "1\n4" -> "14", which
  # beats "2", and the CLI told you to update to a version older than itself.
  # Fixed at the source (json_top_string is depth-aware); pinned here too,
  # because the comparator should be unfoolable regardless of its caller.
  eq "version_gt: doubled value isn't an upgrade" "no" \
     "$(gt "$(printf '4.3.1\n4.3.1')" 4.3.2)"

  # The naive extraction must not come back. The parser that gets this right
  # already exists; the login path simply was not using it.
  if grep -q "grep -o '\"version\":" "$REPO_ROOT/mdnest"; then
    bad "version: server version is read with the depth-aware parser" \
        "found a naive grep for \"version\" — /api/config nests one inside latestRelease"
  else
    ok "version: server version is read with the depth-aware parser"
  fi

  # The notice itself: printed only when the server is genuinely ahead, and it
  # must name the command to run. Never a bare "an update is available".
  MDNEST_CLI_VERSION=4.3.1
  eq "notice: silent when up to date" "" "$(cli_update_notice 4.3.1 '@srv')"
  eq "notice: silent when server older" "" "$(cli_update_notice 4.2.0 '@srv')"
  case "$(cli_update_notice 4.3.2 '@srv')" in
    *"mdnest update"*) ok "notice: says how to fix it" ;;
    *) bad "notice: says how to fix it" "got [$(cli_update_notice 4.3.2 '@srv')]" ;;
  esac
  case "$(cli_update_notice 4.3.2 '@srv')" in
    *"v4.3.1"*"@srv"*"v4.3.2"*) ok "notice: names both versions and the server" ;;
    *) bad "notice: names both versions and the server" "got [$(cli_update_notice 4.3.2 '@srv')]" ;;
  esac
  # It is used as a bare statement in cmd_servers/cmd_login, so a "no update"
  # verdict must still return 0 — a non-zero return there would exit the CLI
  # under set -e, which is the same bug in a new coat.
  cli_update_notice 4.2.0 '@srv' >/dev/null
  eq "notice: returns 0 when silent" "0" "$?"
  MDNEST_CLI_VERSION="$(grep '^MDNEST_CLI_VERSION=' "$REPO_ROOT/mdnest" | cut -d'"' -f2)"
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
run_unreachable_suite
run_version_suite
run_errexit_lint

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
