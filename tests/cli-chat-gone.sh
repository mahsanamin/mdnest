#!/usr/bin/env bash
#
# mdnest CLI — `chat wait` when the chat is deleted under it
#
# A chat can be deleted (by its owner or an admin) while agents are waiting in
# it, or an agent's account can be taken off a private chat. The wait used to
# print the server's error and exit 1, which agents read as a blip and retried
# forever, and the keepalive hook kept sending them back to wait on a chat
# that was not there. Now a 404 or 403 mid-wait exits 3 with a plain message
# that includes the leave command, and that printed command is what the
# keepalive hook reads in the transcript as "this agent is out".
#
# Drives the real CLI against a fake backend. Needs python3 for the fake
# backend only and SKIPs without it.
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

echo "=== mdnest CLI chat wait on a deleted chat ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP — python3 not present (needed only for the fake backend)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-chat-gone.XXXXXX")"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/fake_backend.py" <<'PY'
"""/api/chat that answers "nothing new" twice, then GONE_STATUS for good:
the chat was deleted (404) or this account removed from it (403) mid-wait."""
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

GONE = int(os.environ.get("GONE_STATUS", "404"))
seen = {"n": 0}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, code, body, extra=None):
        b = body.encode()
        self.send_response(code)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/config"):
            return self.send(200, '{"version":"9.9.9-test","authMode":"single"}')
        seen["n"] += 1
        if seen["n"] <= 2:
            return self.send(200, "", {"X-Chat-Count": "1", "Content-Type": "text/plain"})
        msg = "not found" if GONE == 404 else "access denied"
        return self.send(GONE, '{"error":"%s"}' % msg, {"Content-Type": "application/json"})

srv = HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PY

start_server() {
  GONE_STATUS="$1" python3 "$WORK/fake_backend.py" > "$WORK/port" 2>"$WORK/srv.err" &
  SRV_PID=$!
  local i=0
  while [ ! -s "$WORK/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  PORT="$(cat "$WORK/port")"
  [ -n "$PORT" ] || { echo "fake backend did not start: $(cat "$WORK/srv.err")"; exit 1; }
  export HOME="$WORK/home-$1"
  mkdir -p "$HOME/.config/mdnest/servers"
  printf 'url=http://127.0.0.1:%s\ntoken=mdnest_faketoken\n' "$PORT" > "$HOME/.config/mdnest/servers/t"
  printf 't' > "$HOME/.config/mdnest/default"
}
stop_server() { kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""; rm -f "$WORK/port"; }

for status in 404 403; do
  echo "── the server starts answering $status mid-wait ──"
  start_server "$status"
  ERR="$(MDNEST_CHAT_POLL=1 "$CLI" chat wait @t/ns/Chats/room.md --as bot --timeout 20 2>&1 >/dev/null)"; RC=$?
  eq "wait exits 3, not 1 (which agents retry)" "3" "$RC"
  contains "it says the chat is gone" "$ERR" "This chat is gone"
  contains "it tells the agent to stop" "$ERR" "Stop waiting"
  contains "it prints the leave command" "$ERR" "mdnest chat leave @t/ns/Chats/room.md --as bot"
  stop_server
done

# The keepalive hook decides from the transcript. A transcript whose last chat
# command is a wait gets the agent sent back; once the wait's "gone" output is
# in it, the hook lets the agent stop.
echo "── the keepalive hook lets the agent stop ──"
T="$WORK/transcript.jsonl"
printf '%s\n' '{"type":"tool_use","input":{"command":"mdnest chat wait @t/ns/Chats/room.md --as bot --timeout 120"}}' > "$T"
HOOK_IN="{\"session_id\":\"s1\",\"transcript_path\":\"$T\"}"
OUT="$(printf '%s' "$HOOK_IN" | TMPDIR="$WORK" "$CLI" chat keepalive)"
contains "while the chat exists, it sends the agent back" "$OUT" '"decision":"block"'
printf '%s\n' "{\"type\":\"tool_result\",\"content\":\"This chat is gone: it was deleted or moved, or you no longer have access to it.\\nStop waiting, there is nothing to rejoin. You are out of the chat:\\n  mdnest chat leave @t/ns/Chats/room.md --as bot\"}" >> "$T"
OUT="$(printf '%s' "$HOOK_IN" | TMPDIR="$WORK" "$CLI" chat keepalive)"
eq "after the chat is gone, it lets the agent stop" "" "$OUT"

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
