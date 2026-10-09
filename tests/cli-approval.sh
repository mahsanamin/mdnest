#!/usr/bin/env bash
#
# mdnest CLI: `approval request` / `approval done` against a fake backend
#
# `mdnest approval request` runs as an agent's PermissionRequest hook. The
# agent shows its own terminal prompt at the same time, so the hook has
# exactly two allowed outcomes: print the server's answer byte for byte, or
# print NOTHING and exit 0 (the terminal prompt then answers, as it does with
# no hook at all). Anything else, a stray error line or a non-zero exit, is
# read by the agent as an answer or an error.
#
# This drives the real CLI as a subprocess, with a throwaway HOME, against a
# fake backend that records what it received. Pinned:
#   - the decision text is printed verbatim (trailing newlines included);
#   - the hook input is posted unchanged, with cli, agent, machine and chat;
#   - nothing is printed, exit 0, on: timeout, 410, 426, 5xx, an unreachable
#     server, no policy file, a tool not in TOOLS, a NEVER_REMOTE match;
#   - in the last three cases nothing is even SENT;
#   - `approval done` calls the server only while a request is open;
#   - all of it with python3 and jq broken (the CLI must not need them).
#
# Needs python3 for the fake backend only, and SKIPs without it.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${MDNEST_BIN:-$REPO_ROOT/mdnest}"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '         %s\n' "$2"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi; }
contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "[$2] does not contain [$3]" ;; esac; }

echo "=== mdnest CLI approval hook ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 not present (needed only for the fake backend)"
  exit 0
fi
REAL_PY="$(command -v python3)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-approval-test.XXXXXX")"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/fake_backend.py" <<'PY'
"""Stand-in for /api/approvals. MODE picks the answer:
allow   POST 201, wait 200 with ANSWER (exact bytes)
pending POST 201, wait 204 every time
gone    POST 201, wait 410
old     POST 426
error   POST 500
werror  POST 201, wait 502
"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit, parse_qs

MODE = os.environ.get("MODE", "allow")
ANSWER = b'{"hookSpecificOutput":{"decision":{"behavior":"allow"},"hookEventName":"PermissionRequest"}}\n\n'
ID = "0123456789abcdef0123456789abcdef"
LOG = {"posts": [], "waits": 0, "closes": []}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body=b"", ct="application/json"):
        self.send_response(code)
        if body:
            self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
    def body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(n) if n else b""
    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/__log":
            return self.reply(200, json.dumps(LOG).encode())
        if u.path == "/api/approvals/" + ID + "/wait":
            LOG["waits"] += 1
            if self.headers.get("Authorization") != "Bearer mdnest_faketoken":
                return self.reply(401, b'{"error":"no"}')
            if MODE == "allow":
                return self.reply(200, ANSWER)
            if MODE == "gone":
                return self.reply(410, b'{"error":"gone"}')
            if MODE == "werror":
                return self.reply(502, b"bad gateway", "text/plain")
            return self.reply(204)
        self.reply(404, b'{"error":"not found"}')
    def do_POST(self):
        u = urlsplit(self.path)
        data = self.body()
        if u.path == "/api/approvals":
            LOG["posts"].append({"query": parse_qs(u.query), "body": data.decode("utf-8", "replace"),
                                 "ct": self.headers.get("Content-Type")})
            if MODE == "old":
                return self.reply(426, b'{"error":"update the CLI"}')
            if MODE == "error":
                return self.reply(500, b'{"error":"boom"}')
            return self.reply(201, json.dumps({"id": ID}).encode())
        if u.path == "/api/approvals/close":
            LOG["closes"].append({"query": parse_qs(u.query), "body": data.decode()})
            return self.reply(200, b'{"closed":1}')
        self.reply(404, b'{"error":"not found"}')

srv = HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PY

printf '{"hookSpecificOutput":{"decision":{"behavior":"allow"},"hookEventName":"PermissionRequest"}}\n\n' > "$WORK/expected_allow"

start_server() {
  MODE="$1" "$REAL_PY" "$WORK/fake_backend.py" > "$WORK/port" 2>"$WORK/srv.err" &
  SRV_PID=$!
  local i=0
  while [ ! -s "$WORK/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  PORT="$(cat "$WORK/port")"
  [ -n "$PORT" ] || { echo "fake backend did not start: $(cat "$WORK/srv.err")"; exit 1; }
}
stop_server() { kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""; rm -f "$WORK/port"; }
srv_log() { curl -s "http://127.0.0.1:$PORT/__log"; }
# logq <log json> <expr>: evaluates a Python expression over the log, as `d`.
# The expressions are literals written in this file, never data from the CLI.
logq() { printf '%s' "$1" | "$REAL_PY" -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$2"; }

# A throwaway HOME with server @t pointing at the fake backend, and a policy.
new_home() {
  export HOME="$WORK/home-$1"
  rm -rf "$HOME"; mkdir -p "$HOME/.config/mdnest/servers" "$HOME/.mdnest"
  printf 'url=http://127.0.0.1:%s\ntoken=mdnest_faketoken\n' "${2:-$PORT}" > "$HOME/.config/mdnest/servers/t"
  printf 't' > "$HOME/.config/mdnest/default"
  cat > "$HOME/.mdnest/approvals.conf" <<CONF
# test policy
SERVER=@t
MACHINE_LABEL="build box"
TOOLS=Bash, Write
NEVER_REMOTE=sudo, RM -RF, .ssh
MAX_WAIT=540
CONF
  export TMPDIR="$WORK/tmp-$1"; mkdir -p "$TMPDIR"
}

TRANSCRIPT="$WORK/transcript.jsonl"
printf '%s\n' '{"type":"tool_use","input":{"command":"mdnest chat wait @t/ns/Chats/room.md --as builder --timeout 120"}}' > "$TRANSCRIPT"
INPUT="{\"session_id\":\"s-1\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"/w\",\"hook_event_name\":\"PermissionRequest\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin x\",\"description\":\"Push it\"}}"

# run_request <name> [args...]: the hook, with INPUT on stdin; stdout to a
# file (never through $( ), which would eat the trailing newlines we check).
run_request() {
  local name="$1"; shift
  printf '%s' "${HOOK_INPUT:-$INPUT}" | "$CLI" approval request "$@" > "$WORK/out.$name" 2> "$WORK/err.$name"
  RC=$?
}

# ── 1. a decision is printed byte for byte ──────────────────────────────────
echo "── allowed from the browser ──"
start_server allow; new_home allow
run_request allow --agent codex
eq "exit 0" "0" "$RC"
if cmp -s "$WORK/expected_allow" "$WORK/out.allow"; then ok "prints the server's answer verbatim, trailing newlines included"; else
  bad "prints the server's answer verbatim, trailing newlines included" "got: $(od -c "$WORK/out.allow" | head -3)"; fi
eq "nothing on stderr" "" "$(cat "$WORK/err.allow")"
LOGJ="$(srv_log)"
eq "the hook input was posted unchanged" "$INPUT" "$(logq "$LOGJ" 'd["posts"][0]["body"]')"
eq "it sends the CLI version" "$(grep '^MDNEST_CLI_VERSION=' "$CLI" | cut -d'"' -f2)" "$(logq "$LOGJ" 'd["posts"][0]["query"]["cli"][0]')"
eq "it sends the agent" "codex" "$(logq "$LOGJ" 'd["posts"][0]["query"]["agent"][0]')"
eq "it sends the machine label" "build box" "$(logq "$LOGJ" 'd["posts"][0]["query"]["machine"][0]')"
eq "it finds the chat from the transcript" "ns/Chats/room.md" "$(logq "$LOGJ" 'd["posts"][0]["query"]["chat"][0]')"
eq "the wait marker is gone after the answer" "" "$(ls "$TMPDIR/mdnest-approvals" 2>/dev/null)"
stop_server

echo "── --chat on another server is not sent ──"
start_server allow; new_home chat
run_request chat --chat @elsewhere/ns/Chats/x.md
LOGJ="$(srv_log)"
eq "no chat param for a chat on another server" "False" "$(logq "$LOGJ" '"chat" in d["posts"][0]["query"]')"
run_request chat2 --chat @t/ns/Chats/other.md
LOGJ="$(srv_log)"
eq "--chat on the approval server wins over the transcript" "ns/Chats/other.md" "$(logq "$LOGJ" 'd["posts"][1]["query"]["chat"][0]')"
stop_server

# ── 2. every failure prints nothing and exits 0 ─────────────────────────────
quiet_case() {
  local mode="$1" label="$2"; shift 2
  start_server "$mode"; new_home "$mode"
  run_request "$mode" "$@"
  eq "$label: exit 0" "0" "$RC"
  eq "$label: prints nothing" "" "$(cat "$WORK/out.$mode")"
  eq "$label: nothing on stderr" "" "$(cat "$WORK/err.$mode")"
  stop_server
}
echo "── failures fall back to the terminal prompt ──"
quiet_case pending "timeout (still pending)" --timeout 2
quiet_case gone    "410 (expired or answered in the terminal)"
quiet_case old     "426 (CLI too old)"
quiet_case error   "500 on create"
quiet_case werror  "502 while waiting"

echo "── unreachable server ──"
start_server allow; DEAD="$PORT"; stop_server
new_home dead "$DEAD"
run_request dead
eq "unreachable: exit 0" "0" "$RC"
eq "unreachable: prints nothing" "" "$(cat "$WORK/out.dead")$(cat "$WORK/err.dead")"

# ── 3. the machine's policy keeps things local, and nothing is sent ─────────
policy_case() {
  local name="$1" label="$2"
  run_request "$name"
  eq "$label: exit 0, prints nothing" "0:" "$RC:$(cat "$WORK/out.$name")$(cat "$WORK/err.$name")"
  eq "$label: nothing was sent" "0" "$(logq "$(srv_log)" 'len(d["posts"])')"
}
echo "── machine policy ──"
start_server allow
new_home nofile; rm -f "$HOME/.mdnest/approvals.conf"
policy_case nofile "no policy file"
stop_server; start_server allow
new_home tool
HOOK_INPUT='{"session_id":"s-1","tool_name":"WebFetch","tool_input":{"url":"https://example.com"}}' policy_case tool "a tool not in TOOLS"
stop_server; start_server allow
new_home never
HOOK_INPUT='{"session_id":"s-1","tool_name":"Bash","tool_input":{"command":"rm -rf build"}}' policy_case never "a NEVER_REMOTE match (case-insensitive)"
stop_server; start_server allow
new_home ssh
HOOK_INPUT='{"session_id":"s-1","tool_name":"Bash","tool_input":{"command":"cat ~\/.ssh\/id_ed25519"}}' policy_case ssh "a NEVER_REMOTE match behind escaped slashes"
stop_server; start_server allow
new_home noserver; sed -i.bak '/^SERVER=/d' "$HOME/.mdnest/approvals.conf"
policy_case noserver "a policy without SERVER"
stop_server

# ── 4. approval done ────────────────────────────────────────────────────────
echo "── approval done ──"
start_server allow; new_home done
POST='{"session_id":"s-1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"git push origin x"}}'
OUT="$(printf '%s' "$POST" | "$CLI" approval done 2>&1)"; RC=$?
eq "done with nothing open: exit 0, quiet" "0:" "$RC:$OUT"
eq "done with nothing open calls nobody" "0" "$(logq "$(srv_log)" 'len(d["closes"])')"
mkdir -p "$TMPDIR/mdnest-approvals"; : > "$TMPDIR/mdnest-approvals/s-1.0123456789abcdef0123456789abcdef"
OUT="$(printf '%s' "$POST" | "$CLI" approval done 2>&1)"; RC=$?
eq "done with a request open: exit 0, quiet" "0:" "$RC:$OUT"
LOGJ="$(srv_log)"
eq "it closes that session" "s-1" "$(logq "$LOGJ" 'd["closes"][0]["query"]["session"][0]')"
eq "it sends the hook input, so only the matching command closes" "$POST" "$(logq "$LOGJ" 'd["closes"][0]["body"]')"
stop_server

# ── 5. hook-config ──────────────────────────────────────────────────────────
echo "── hook-config ──"
for a in claude-code codex; do
  CFG="$("$CLI" approval hook-config "$a" 2>/dev/null)"
  if printf '%s' "$CFG" | "$REAL_PY" -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then ok "hook-config $a prints valid JSON on stdout"; else
    bad "hook-config $a prints valid JSON on stdout" "$CFG"; fi
  contains "hook-config $a names the agent" "$CFG" "mdnest approval request --agent $a"
  contains "hook-config $a sets the 600 s hook timeout" "$CFG" '"timeout": 600'
done
"$CLI" approval hook-config other >/dev/null 2>&1; RC=$?
if [ "$RC" != "0" ]; then ok "hook-config refuses an unknown agent"; else bad "hook-config refuses an unknown agent" "exit 0"; fi

# ── 6. the same, with python3 and jq broken ─────────────────────────────────
echo "── no working python3 or jq ──"
SHIM="$WORK/shim"; mkdir -p "$SHIM"
printf '#!/bin/sh\nexit 1\n' > "$SHIM/python3"; printf '#!/bin/sh\nexit 1\n' > "$SHIM/jq"; chmod +x "$SHIM/python3" "$SHIM/jq"
start_server allow; new_home nopy
printf '%s' "$INPUT" | PATH="$SHIM:$PATH" "$CLI" approval request > "$WORK/out.nopy" 2> "$WORK/err.nopy"; RC=$?
eq "no parser: exit 0" "0" "$RC"
if cmp -s "$WORK/expected_allow" "$WORK/out.nopy"; then ok "no parser: answer printed verbatim"; else
  bad "no parser: answer printed verbatim" "got: $(od -c "$WORK/out.nopy" | head -3)"; fi
eq "no parser: chat still found" "ns/Chats/room.md" "$(logq "$(srv_log)" 'd["posts"][0]["query"]["chat"][0]')"
stop_server
start_server gone; new_home nopy-gone
printf '%s' "$INPUT" | PATH="$SHIM:$PATH" "$CLI" approval request > "$WORK/out.nopyg" 2>&1; RC=$?
eq "no parser, 410: exit 0, prints nothing" "0:" "$RC:$(cat "$WORK/out.nopyg")"
stop_server

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
