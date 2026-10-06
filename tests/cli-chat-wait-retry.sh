#!/usr/bin/env bash
#
# mdnest CLI — `chat wait` survives a temporary outage
#
# `chat wait` is how agents listen to a chat. It used to exit 1 the first time
# one poll failed, so a server restart or a single empty reply (curl 52) ended
# the listener and the agent silently stopped hearing anything.
#
# This drives the real CLI against a fake backend that drops the connection,
# then answers 503, then serves a message, and pins:
#   1. wait keeps going through those failures and prints the message (exit 0);
#   2. a real error (401) still exits 1 at once, without retrying;
#   3. a server that stays down past --timeout still exits 1 in the end;
#   4. the opt-in retry status does not leak into other commands (read exits 1).
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

echo "=== mdnest CLI chat wait retries temporary failures ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP — python3 not present (needed only for the fake backend)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-chatwait-test.XXXXXX")"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/fake_backend.py" <<'PY'
"""Stand-in for /api/chat and /api/note.

PLAN is a comma list of what each successive /api/chat request gets:
  drop  close the socket without a reply (curl exit 52)
  503   a gateway error, as a proxy gives while the backend restarts
  401   a real error that must not be retried
  msg   one new message after #1
The last entry repeats once the list runs out.
"""
import os, socket
from http.server import BaseHTTPRequestHandler, HTTPServer

PLAN = os.environ.get("PLAN", "msg").split(",")
STATE = {"n": 0}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def reply(self, code, body, count=None):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        if count is not None:
            self.send_header("X-Chat-Count", str(count))
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/api/note"):
            # Used by the read check: always a gateway error.
            return self.reply(503, '{"error":"unavailable"}')
        step = PLAN[min(STATE["n"], len(PLAN) - 1)]
        STATE["n"] += 1
        if step == "drop":
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        if step == "503":
            return self.reply(503, '{"error":"backend restarting"}')
        if step == "401":
            return self.reply(401, '{"error":"invalid token"}')
        return self.reply(200, "[#2] bob · 2026-10-05T10:00:00Z\nhello after the outage\n", count=2)

srv = HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PY

start_server() {
  PLAN="$1" python3 "$WORK/fake_backend.py" > "$WORK/port" 2>"$WORK/srv.err" &
  SRV_PID=$!
  local i=0
  while [ ! -s "$WORK/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  PORT="$(cat "$WORK/port")"
  [ -n "$PORT" ] || { echo "fake backend did not start: $(cat "$WORK/srv.err")"; exit 1; }
  # A throwaway HOME so the real CLI config on this machine is never touched.
  export HOME="$WORK/home-$RANDOM"
  mkdir -p "$HOME/.config/mdnest/servers"
  printf 'url=http://127.0.0.1:%s\ntoken=mdnest_faketoken\n' "$PORT" \
    > "$HOME/.config/mdnest/servers/t"
  printf 't' > "$HOME/.config/mdnest/default"
}
stop_server() { kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""; rm -f "$WORK/port"; }

export MDNEST_CHAT_POLL=1

echo "── a dropped reply and a 503, then a message ──"
start_server "drop,503,msg"
OUT="$("$CLI" chat wait @t/ns/Chats/c.md --after 1 --timeout 30 2>"$WORK/err")"; RC=$?
ERR="$(cat "$WORK/err")"
eq "wait exits 0 after the server comes back" "0" "$RC"
contains "the message after the outage is printed" "$OUT" "hello after the outage"
contains "it says it is retrying" "$ERR" "retrying until the server answers"
contains "it says the server is back" "$ERR" "reachable again"
stop_server

echo "── a real error is not retried ──"
start_server "401"
START=$SECONDS
"$CLI" chat wait @t/ns/Chats/c.md --after 1 --timeout 30 >/dev/null 2>"$WORK/err"; RC=$?
eq "a 401 exits 1" "1" "$RC"
contains "the 401 is reported" "$(cat "$WORK/err")" "401"
if [ $((SECONDS - START)) -lt 5 ]; then ok "a 401 exits at once"; else
  bad "a 401 exits at once" "took $((SECONDS - START))s"; fi
stop_server

echo "── a server that stays down ──"
start_server "drop"
START=$SECONDS
"$CLI" chat wait @t/ns/Chats/c.md --after 1 --timeout 3 >/dev/null 2>"$WORK/err"; RC=$?
eq "wait exits 1 once --timeout passes with the server still down" "1" "$RC"
if [ $((SECONDS - START)) -lt 20 ]; then ok "it gives up near --timeout"; else
  bad "it gives up near --timeout" "took $((SECONDS - START))s"; fi
stop_server

echo "── other commands keep exit 1 ──"
start_server "503"
"$CLI" read @t/ns/note.md >/dev/null 2>&1; RC=$?
eq "read on a 503 still exits 1" "1" "$RC"
stop_server

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
