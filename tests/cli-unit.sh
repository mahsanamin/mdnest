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
    # $((...)) is ARITHMETIC expansion, not command substitution: the
    # assignment carries its own status (0), so `c=$((c + 1))` is safe and
    # must not be reported. Only ((expr)) and `let` as bare COMMANDS return 1
    # on a zero result, and neither is this shape.
    if (s ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=\$\(\(/) continue
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

# ── literal splicing (`mdnest edit`) ────────────────────────────────────────
# `edit` replaces an exact string inside a note. The whole point is that the
# needle and the replacement are BYTE-LITERAL: a note is arbitrary markdown, so
# a regex tool would read `.`/`*`/`[` in the needle and expand `&`/`\1` in the
# replacement, corrupting exactly the code fences and shell snippets people
# keep in notes. These are the checks that would catch that, and they run in
# every parser pass because the implementation is pure bash and must not grow
# a python3/jq/sed tier.
run_splice_suite() {
  echo "── literal splicing (edit) ──"
  local h="# Log
alpha
beta
alpha"

  eq "count: unique"            "1"  "$(count_literal "$h" "beta")"
  eq "count: repeated"          "2"  "$(count_literal "$h" "alpha")"
  eq "count: absent"            "0"  "$(count_literal "$h" "zeta")"
  eq "count: whole haystack"    "1"  "$(count_literal "abc" "abc")"
  eq "count: empty needle is 0" "0"  "$(count_literal "$h" "")"
  # Non-overlapping, the same way JS split() counts — so the number the error
  # message quotes matches the number replace_all actually changes.
  eq "count: non-overlapping"   "2"  "$(count_literal "aaaa" "aa")"
  eq "count: multi-line needle" "1"  "$(count_literal "$h" "alpha
beta")"

  eq "first: replaces once" "# Log
gamma
beta
alpha" "$(replace_first_literal "$h" "alpha" "gamma")"
  eq "first: absent needle is a no-op" "$h" "$(replace_first_literal "$h" "zeta" "x")"
  eq "all: replaces every one" "# Log
gamma
beta
gamma" "$(replace_all_literal "$h" "alpha" "gamma")"

  # The corruption class this exists to prevent. `$&` and `$1` are what
  # String.replace / sed would expand; `.` `*` `[` are what a regex would match
  # on. All six must survive verbatim in BOTH directions.
  eq "literal: \$ in replacement stays literal" \
     "cost: a\$& b\$1" "$(replace_first_literal "cost: X" "X" 'a$& b$1')"
  eq "literal: regex chars in replacement stay literal" \
     "re: .*[a-z]+" "$(replace_first_literal "re: X" "X" '.*[a-z]+')"
  eq "literal: regex chars in NEEDLE match literally" \
     "found" "$(replace_first_literal 'a.*[x]b' 'a.*[x]b' 'found')"
  eq "literal: a needle of dots does not match arbitrary text" \
     "abc" "$(replace_first_literal "abc" "..." "MATCHED")"
  eq "literal: backslashes survive" \
     'C:\\tmp\\n' "$(replace_first_literal "P" "P" 'C:\\tmp\\n')"
  eq "literal: a code fence survives" \
     '```mermaid' "$(replace_first_literal "P" "P" '```mermaid')"

  # Deleting a string is an edit with an empty replacement, not a special case.
  eq "empty replacement deletes" "# Log

beta
alpha" "$(replace_first_literal "$h" "alpha" "")"

  # note_etag parses the header block curl dumps. Case-insensitive name and a
  # trailing CR are both what a real server sends.
  local hf; hf="$(mktemp "${TMPDIR:-/tmp}/mdnest-hdr.XXXXXX")"
  printf 'HTTP/1.1 200 OK\r\nContent-Type: text/markdown\r\nETag: "abc123"\r\n\r\n' > "$hf"
  eq "note_etag: reads the value, strips CR" '"abc123"' "$(note_etag "$hf")"
  printf 'HTTP/1.1 200 OK\r\netag: "low"\r\n\r\n' > "$hf"
  eq "note_etag: case-insensitive header name" '"low"' "$(note_etag "$hf")"
  printf 'HTTP/1.1 200 OK\r\nContent-Type: text/markdown\r\n\r\n' > "$hf"
  eq "note_etag: absent is empty (write unguarded, not refused)" "" "$(note_etag "$hf")"
  rm -f "$hf"
}

# move/copy/download helpers (GH-114). json_str builds the /api/transfer body
# from user paths, so a quote or backslash in a name must not break the JSON;
# disposition_filename decides where a download lands, so a server-chosen name
# must never carry a folder part. Both are pure bash: run once per tier.
run_transfer_suite() {
  echo "-- transfer helpers ($1)"
  eq "json_str: plain"            '"Notes/plan.md"'           "$(json_str 'Notes/plan.md')"
  eq "json_str: quote+backslash"  '"a\"b\\c.md"'              "$(json_str 'a"b\c.md')"
  eq "json_str: newline/tab"      '"a\nb\tc"'                 "$(json_str $'a\nb\tc')"
  eq "json_str: control char"     '"x\u0001y"'                "$(json_str $'x\x01y')"
  eq "json_str: utf-8 untouched"  '"ملاحظات.md"'              "$(json_str 'ملاحظات.md')"
  if have python3; then
    eq "json_str: python parses it back" $'q"\\\nz' \
       "$(python3 -S -E -c 'import json,sys; sys.stdout.write(json.loads(sys.argv[1]))' "$(json_str $'q"\\\nz')" 2>/dev/null)"
  fi
  eq "disposition: plain"         "Proj.zip"     "$(disposition_filename 'Content-Disposition: attachment; filename="Proj.zip"' x)"
  eq "disposition: utf-8 wins"    "ملاحظات.md"   "$(disposition_filename "Content-Disposition: attachment; filename=\"_______.md\"; filename*=UTF-8''%D9%85%D9%84%D8%A7%D8%AD%D8%B8%D8%A7%D8%AA.md" x)"
  eq "disposition: no folder"     "passwd"       "$(disposition_filename 'attachment; filename="../../etc/passwd"' x)"
  eq "disposition: encoded folder" "bashrc"      "$(disposition_filename "attachment; filename*=UTF-8''..%2F.bashrc" x)"
  eq "disposition: no dotfile"    "hidden"       "$(disposition_filename 'attachment; filename=".hidden"' x)"
  eq "disposition: missing"       "fallback.md"  "$(disposition_filename '' fallback.md)"
  eq "disposition: no leading dash" "target-directory=x" "$(disposition_filename "attachment; filename*=UTF-8''--target-directory%3Dx" x)"
  eq "disposition: no control chars" "ab.md"     "$(disposition_filename "attachment; filename*=UTF-8''a%1Bb.md" x)"
}

run_errexit_lint() {
  echo "── errexit lint (mdnest, install-cli.sh) ──"
  # install-cli.sh is linted too: it runs under `set -e` and is no longer a
  # straight-line script — it grew a source-fallback loop when GitHub's raw
  # CDN turned out to be a single point of failure for every install.
  local f findings
  for f in mdnest install-cli.sh; do
    findings="$(awk "$ERREXIT_LINT" "$REPO_ROOT/$f")" || findings=""
    if [ -z "$findings" ]; then
      ok "errexit ($f): every command substitution assignment is guarded"
    else
      bad "errexit ($f): every command substitution assignment is guarded" \
          "unguarded under set -e — add '|| var=\"\"':
$findings"
    fi
  done

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
f=$((f + 1))
PROBE
  local hits; hits="$(awk "$ERREXIT_LINT" "$probe" | wc -l | tr -d ' ')" || hits=""
  # 1, not 2: the probe's `f=$((f + 1))` is arithmetic expansion and must not
  # be reported. This counts, so a relapse shows up here as 2.
  eq "errexit lint: flags exactly the unguarded form" "1" "$hits"
  case "$(awk "$ERREXIT_LINT" "$probe")" in
    *':1: a=$(false)'*) ok "errexit lint: names the offending line" ;;
    *) bad "errexit lint: names the offending line" "got [$(awk "$ERREXIT_LINT" "$probe")]" ;;
  esac
}

# ── CLI download sources ────────────────────────────────────────────────────
# The install one-liner started returning 503 for everyone in a region:
# raw.githubusercontent.com is one Fastly tier, a POP ran out of backend
# connections, and both install-cli.sh and `mdnest update` were hardcoded to
# it with no fallback and no retry — reporting it as "check your network",
# which is the one thing that was fine.
#
# Two things are pinned here. The chain must have a real fallback (a list of
# one is the bug), and the copy in install-cli.sh must match the copy in the
# CLI: the installer is fetched on its own so it cannot source the CLI, and
# duplication that drifts would leave exactly one of the two able to recover.
run_install_source_suite() {
  echo "── CLI download sources ──"

  # Extract each list by running the function out of its own file, so the test
  # reads the shipped code rather than a restatement of it.
  local cli_list inst_list
  cli_list="$(sed -n '/^cli_sources() {/,/^}/p' "$REPO_ROOT/mdnest" | { cat; echo 'cli_sources main mdnest'; } | bash)" || cli_list=""
  inst_list="$(sed -n '/^mdnest_sources() {/,/^}/p' "$REPO_ROOT/install-cli.sh" | { cat; echo 'mdnest_sources main mdnest'; } | bash)" || inst_list=""

  eq "sources: the installer and the CLI agree" "$cli_list" "$inst_list"

  # A single source is the bug this fixed, so require more than one.
  local n; n="$(printf '%s\n' "$cli_list" | grep -c .)" || n=0
  if [ "$n" -ge 2 ]; then
    ok "sources: there is a fallback (found $n)"
  else
    bad "sources: there is a fallback" "only $n source — a list of one cannot survive an outage"
  fi

  # raw.githubusercontent.com must stay FIRST. jsDelivr caches a branch ref for
  # hours, so promoting it would mean a CLI fix reaching nobody for half a day
  # — the pull-only CLI's whole update story depends on main being immediate.
  case "$(printf '%s\n' "$cli_list" | head -1)" in
    https://raw.githubusercontent.com/*) ok "sources: GitHub raw is tried first" ;;
    *) bad "sources: GitHub raw is tried first" "got [$(printf '%s\n' "$cli_list" | head -1)]" ;;
  esac

  # The hosts must actually differ. Three URLs on one host is not a fallback,
  # and that is easy to write by accident when they are built from one prefix.
  local hosts; hosts="$(printf '%s\n' "$cli_list" | sed -E 's#^https?://([^/]+).*#\1#' | sort -u | grep -c .)" || hosts=0
  if [ "$hosts" -ge 2 ]; then
    ok "sources: spread across $hosts independent hosts"
  else
    bad "sources: spread across independent hosts" "all $n URLs share one host — an outage there takes out every source"
  fi

  # mdnest.dev mirrors main only; a branch build has to come from GitHub, and
  # offering a URL that 404s would just add a slow step to every branch install.
  local dev_list; dev_list="$(sed -n '/^cli_sources() {/,/^}/p' "$REPO_ROOT/mdnest" | { cat; echo 'cli_sources develop mdnest'; } | bash)" || dev_list=""
  case "$dev_list" in
    *mdnest.dev*) bad "sources: mdnest.dev is offered for main only" "develop got [$dev_list]" ;;
    *) ok "sources: mdnest.dev is offered for main only" ;;
  esac

  # An HTML error page and a truncated script must both be rejected. A shebang
  # check alone passes a proxy login page and half a download, and installing
  # either over a working CLI is the worst outcome available.
  local vfy; vfy="$SHIM_DIR/looks.sh"
  { sed -n '/^looks_like_cli() {/,/^}/p' "$REPO_ROOT/mdnest"; echo 'looks_like_cli "$1" && echo YES || echo NO'; } > "$vfy"
  printf '#!/bin/bash\nMDNEST_CLI_VERSION="9.9.9"\n' > "$SHIM_DIR/good"
  printf '<html><body>503</body></html>\n' > "$SHIM_DIR/htmlpage"
  printf '#!/bin/bash\n# truncated before the version marker\n' > "$SHIM_DIR/partial"
  eq "verify: a real CLI is accepted"       "YES" "$(bash "$vfy" "$SHIM_DIR/good")"
  eq "verify: an HTML error page is refused" "NO" "$(bash "$vfy" "$SHIM_DIR/htmlpage")"
  eq "verify: a truncated script is refused" "NO" "$(bash "$vfy" "$SHIM_DIR/partial")"
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
run_keepalive_suite() {
  echo "── chat keepalive (Stop hook) ──"
  local d; d=$(mktemp -d)
  ka() { printf '{"session_id":"%s","transcript_path":"%s"}' "$1" "$2" | TMPDIR="$d" "$REPO_ROOT/mdnest" chat keepalive 2>/dev/null; }
  # A Claude Code transcript: the pasted prompt names both commands, then the
  # agent's own wait. The agent is in the chat, so stopping is blocked.
  printf '%s\n' '{"message":"run mdnest chat wait @srv/notes/team.md --as bot; to leave run mdnest chat leave @srv/notes/team.md --as bot"}' \
    '{"tool_use":{"input":{"command":"mdnest chat wait @srv/notes/team.md --as codxu --timeout 120"}}}' > "$d/claude.jsonl"
  local out; out=$(ka s1 "$d/claude.jsonl")
  eq "keepalive: blocks while the agent is in a chat" '{"decision":"block"' "${out:0:19}"
  case "$out" in *'mdnest chat wait @srv/notes/team.md --as codxu --timeout 120'*) ok "keepalive: hands back the agent's own wait command" ;; *) bad "keepalive: hands back the agent's own wait command" "$out" ;; esac
  # The harness writes our reason into the transcript. It must not read as a
  # leave on the next stop.
  printf '%s\n' "$out" >> "$d/claude.jsonl"
  eq "keepalive: its own reason text is not a leave" '{"decision":"block"' "$(ka s1b "$d/claude.jsonl" | cut -c1-19)"
  # A Codex rollout: the command is inside an escaped JS string, with a quoted
  # path that has a space.
  printf '%s\n' '{"payload":{"type":"custom_tool_call","input":"tools.exec_command({\"cmd\":\"mdnest chat wait '"'"'notes/Chats/my team.md'"'"' --as '"'"'gpt-a'"'"' --timeout 120\"})"}}' > "$d/codex.jsonl"
  case "$(ka s2 "$d/codex.jsonl")" in *"mdnest chat wait 'notes/Chats/my team.md' --as gpt-a --timeout 120"*) ok "keepalive: reads a Codex rollout with a quoted path" ;; *) bad "keepalive: reads a Codex rollout with a quoted path" "$(ka s2x "$d/codex.jsonl")" ;; esac
  # After chat leave, the agent may stop.
  printf '%s\n' '{"x":"mdnest chat wait notes/c.md --as a"}' '{"x":"mdnest chat leave notes/c.md --as a"}' > "$d/left.jsonl"
  eq "keepalive: chat leave lets the agent stop" "" "$(ka s3 "$d/left.jsonl")"
  # Never in a chat, no transcript, garbage, or switched off: say nothing.
  printf '%s\n' '{"x":"ls -la"}' > "$d/none.jsonl"
  eq "keepalive: no chat, no block" "" "$(ka s4 "$d/none.jsonl")"
  eq "keepalive: missing transcript, no block" "" "$(ka s5 "$d/nope.jsonl")"
  eq "keepalive: garbage input, no block" "" "$(echo nonsense | TMPDIR="$d" "$REPO_ROOT/mdnest" chat keepalive 2>/dev/null)"
  eq "keepalive: MDNEST_KEEPALIVE=0 turns it off" "" "$(printf '{"transcript_path":"%s"}' "$d/claude.jsonl" | MDNEST_KEEPALIVE=0 "$REPO_ROOT/mdnest" chat keepalive)"
  # Runaway guard: three stops within two minutes, then it lets go. A wait
  # that fails at once still lands in the transcript as a new wait, so the
  # guard must not reset on that.
  local i got=""
  for i in 1 2 3 4; do
    printf '%s\n' '{"x":"mdnest chat wait @srv/notes/team.md --as codxu"}' >> "$d/claude.jsonl"
    got="$got$(ka loop "$d/claude.jsonl" | cut -c1-5 | tr -d '\n')|"
  done
  eq "keepalive: gives up after 3 quick stops, even with new waits" '{"dec|{"dec|{"dec||' "$got"
  # Once the stops are spread out again, it blocks again.
  eq "keepalive: blocks again once the window has passed" '{"dec' \
     "$(printf '{"session_id":"loop","transcript_path":"%s"}' "$d/claude.jsonl" | TMPDIR="$d" MDNEST_KEEPALIVE_WINDOW=0 "$REPO_ROOT/mdnest" chat keepalive | cut -c1-5)"
  rm -rf "$d"
}

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
run_splice_suite
run_transfer_suite "python3"

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
# Pure bash, so it must be identical with and without a parser — a difference
# here means a python3/jq/sed tier crept into the splicing.
run_splice_suite
run_transfer_suite "no python3/jq"

# Argument handling is pure bash and parser-independent, so it runs once. It
# needs SHIM_DIR for its throwaway HOMEs, hence its place at the end.
run_login_suite
run_unreachable_suite
run_install_source_suite
run_version_suite
run_keepalive_suite
run_errexit_lint

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
