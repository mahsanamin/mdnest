#!/usr/bin/env bash
#
# mdnest CLI — `edit` concurrency guard
#
# `edit` does a read-modify-write. That is the exact shape that silently
# destroys a save landing in between, which is the bug this command exists to
# avoid: before it, the only way to change one line was `read` + rebuild +
# `write`, and a note saved by the web UI, git-sync, or another agent in the
# meantime was overwritten with `{"status":"ok"}` and no warning.
#
# The unit tier (tests/cli-unit.sh) pins the splice helpers and note_etag as
# pure functions. It CANNOT catch the failure that actually matters: helpers
# that work perfectly while nothing consults them. Deleting the If-Match line
# from cmd_edit leaves every unit check green and reinstates the data loss.
#
# So this drives the real CLI, as a subprocess, against a fake backend that
# asserts on the request it receives. Two things are pinned:
#   1. the PUT carries If-Match with the ETag from edit's OWN read;
#   2. when the note changes inside that window, the edit is REFUSED and the
#      other writer's content is still there afterwards.
#
# Needs python3 for the fake backend and SKIPs without it — unlike the CLI
# itself, which must never depend on python3. The CLI's own no-python3 tier is
# covered by tests/cli-unit.sh and tests/e2e-docker.sh.
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

echo "=== mdnest CLI edit concurrency guard ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP — python3 not present (needed only for the fake backend)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-edit-test.XXXXXX")"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/fake_backend.py" <<'PY'
"""Minimal stand-in for /api/note that records what the CLI actually sent.

RACE=1 mutates the note immediately after serving a GET, which reproduces a
concurrent save landing inside the CLI's read-modify-write window with no
timing dependency at all.
"""
import hashlib, json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {"content": "# Log\n\nalpha\nbeta\n", "last_if_match": None, "puts": 0}
RACE = os.environ.get("RACE") == "1"

def etag_of(text):
    # Mirrors the backend: sha256 of the content with trailing newlines
    # trimmed, first 16 bytes, hex, quoted.
    return '"' + hashlib.sha256(text.rstrip("\n").encode()).hexdigest()[:32] + '"'

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        if self.path.startswith("/api/config"):
            body = b'{"version":"9.9.9-test","authMode":"single"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body); return
        body = STATE["content"].encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/markdown")
        self.send_header("ETag", etag_of(STATE["content"]))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
        if RACE:
            # Someone else saves, after edit has read and before it writes.
            STATE["content"] += "\nIMPORTANT: written by someone else\n"

    def do_PUT(self):
        n = int(self.headers.get("Content-Length", 0))
        incoming = self.rfile.read(n).decode()
        im = self.headers.get("If-Match")
        STATE["last_if_match"] = im
        STATE["puts"] += 1
        if im is not None and im != etag_of(STATE["content"]):
            body = json.dumps({"error": "file was modified by another user"}).encode()
            self.send_response(409)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body); return
        STATE["content"] = incoming
        body = json.dumps({"status": "ok", "etag": etag_of(incoming)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        # /__state — what the server saw, so the test asserts on the request
        # the CLI really made rather than on the CLI's own report of it.
        body = json.dumps({
            "content": STATE["content"],
            "last_if_match": STATE["last_if_match"],
            "puts": STATE["puts"],
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

srv = HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PY

start_server() {
  local race="$1"
  RACE="$race" python3 "$WORK/fake_backend.py" > "$WORK/port" 2>"$WORK/srv.err" &
  SRV_PID=$!
  local i=0
  while [ ! -s "$WORK/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  PORT="$(cat "$WORK/port")"
  [ -n "$PORT" ] || { echo "fake backend did not start: $(cat "$WORK/srv.err")"; exit 1; }
  # A throwaway HOME so the real CLI config on this machine is never touched.
  export HOME="$WORK/home-$race"
  mkdir -p "$HOME/.config/mdnest/servers"
  printf 'url=http://127.0.0.1:%s\ntoken=mdnest_faketoken\n' "$PORT" \
    > "$HOME/.config/mdnest/servers/t"
  printf 't' > "$HOME/.config/mdnest/default"
}
stop_server() { kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""; rm -f "$WORK/port"; }
server_state() { curl -s -X POST "http://127.0.0.1:$PORT/__state"; }
field() { printf '%s' "$1" | python3 -c "import json,sys; v=json.load(sys.stdin)[sys.argv[1]]; sys.stdout.write('' if v is None else str(v))" "$2"; }
# Content assertions go through repr, deliberately. A trailing newline is
# exactly what `edit` must not silently eat, and `$( )` strips trailing
# newlines — so comparing captured content directly would assert that the
# newline is gone and call it a pass. repr makes it visible in the diff too.
field_repr() { printf '%s' "$1" | python3 -c "import json,sys; sys.stdout.write(repr(json.load(sys.stdin)[sys.argv[1]]))" "$2"; }

# ── 1. the happy path still sends the guard ─────────────────────────────────
echo "── a clean edit ──"
start_server 0
OUT="$("$CLI" edit @t/ns/note.md "beta" "BETA" 2>&1)"; RC=$?
STATE="$(server_state)"
eq "edit succeeds" "0" "$RC"
eq "the note was edited, trailing newline intact" \
   "'# Log\\n\\nalpha\\nBETA\\n'" "$(field_repr "$STATE" content)"
# THE call-site check. Without it, every helper test above still passes while
# the command silently clobbers.
IM="$(field "$STATE" last_if_match)"
if [ -n "$IM" ]; then ok "the PUT carried an If-Match header"; else
  bad "the PUT carried an If-Match header" "cmd_edit sent none — the concurrency guard is not wired up"; fi
case "$IM" in '"'*'"') ok "If-Match is the quoted ETag the GET served" ;;
  *) bad "If-Match is the quoted ETag the GET served" "got [$IM]" ;; esac
stop_server

# ── 2. a save inside the window is refused, not overwritten ─────────────────
echo "── a concurrent save lands mid-edit ──"
start_server 1
OUT="$("$CLI" edit @t/ns/note.md "beta" "BETA" 2>&1)"; RC=$?
STATE="$(server_state)"
if [ "$RC" != "0" ]; then ok "edit fails instead of reporting success"; else
  bad "edit fails instead of reporting success" "exit 0; output [$OUT]"; fi
contains "it says the note was modified" "$OUT" "modified by another user"
contains "it says nothing was overwritten" "$OUT" "Nothing was overwritten"
# The whole point: the other writer's line is still there.
contains "the concurrent save survived" "$(field "$STATE" content)" "written by someone else"
case "$(field "$STATE" content)" in *BETA*) bad "the edit was not applied" "BETA reached the note anyway" ;;
  *) ok "the edit was not applied" ;; esac
stop_server

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
