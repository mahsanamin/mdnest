#!/usr/bin/env bash
#
# mdnest CLI — `chat avatar --pick auto` picks a built-in nobody else wears
#
# An avatar is saved as ChatGifs/avatar-NAME.svg, an exact copy of the
# built-in it came from. `--pick auto` must skip every built-in another poster
# already has (matched by content), ignore the agent's OWN current avatar, and,
# when every built-in is taken, still set one and say so.
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

echo "=== mdnest CLI chat avatar --pick auto ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP — python3 not present (needed only for the fake backend)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-avatar-test.XXXXXX")"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/fake_backend.py" <<'PY'
"""Built-ins robot, owl, cat. WORN maps poster -> the built-in their avatar is
a copy of. POST/PUT /api/note records which avatar file was written and with
what, so the test asserts on what really reached the server."""
import json, os, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

BUILTIN = {n: f'<svg xmlns="http://www.w3.org/2000/svg"><title>{n}</title></svg>' for n in ("robot", "owl", "cat")}
WORN = json.loads(os.environ.get("WORN", "{}"))
STATE = {"written": None}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body, ctype="text/plain"):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/api/chat/gifs":
            lines = [f"avatar of {who}\tChatGifs/avatar-{who}.svg (workspace)" for who in WORN]
            lines += [f"avatar choice\t{n}\t(mdnest chat avatar ... --pick {n})" for n in BUILTIN]
            return self.reply(200, "\n".join(lines) + "\n")
        if u.path.startswith("/api/chat/gifs/builtin/avatars/"):
            n = u.path.rsplit("/", 1)[1][:-4]
            return self.reply(200, BUILTIN[n], "image/svg+xml") if n in BUILTIN else self.reply(404, "")
        if u.path == "/api/note":
            p = q["path"][0]
            who = p[len("ChatGifs/avatar-"):-4]
            if who in WORN:
                return self.reply(200, BUILTIN[WORN[who]] + "\n")
            return self.reply(404, '{"error":"not found"}')
        self.reply(404, "")
    def write(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode()
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if self.path.startswith("/__state"):
            return self.reply(200, json.dumps(STATE), "application/json")
        STATE["written"] = {"path": q["path"][0], "as": next((k for k, v in BUILTIN.items() if v == body), body)}
        self.reply(201, '{"status":"created"}', "application/json")
    do_POST = write
    do_PUT = write

srv = HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PY

start_server() {
  WORN="$1" python3 "$WORK/fake_backend.py" > "$WORK/port" 2>"$WORK/srv.err" &
  SRV_PID=$!
  local i=0
  while [ ! -s "$WORK/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  PORT="$(cat "$WORK/port")"
  [ -n "$PORT" ] || { echo "fake backend did not start: $(cat "$WORK/srv.err")"; exit 1; }
  export HOME="$WORK/home-$RANDOM"
  mkdir -p "$HOME/.config/mdnest/servers"
  printf 'url=http://127.0.0.1:%s\ntoken=mdnest_faketoken\n' "$PORT" > "$HOME/.config/mdnest/servers/t"
  printf 't' > "$HOME/.config/mdnest/default"
}
stop_server() { kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""; rm -f "$WORK/port"; }
written() { curl -s -X POST "http://127.0.0.1:$PORT/__state" | python3 -c "import json,sys; w=json.load(sys.stdin)['written'] or {}; print(w.get('path',''), w.get('as',''))"; }

echo "── robot is taken by someone else, cat is codxu's own ──"
start_server '{"alice":"robot","codxu":"cat"}'
OUT="$("$CLI" chat avatar @t/ns --as codxu --pick auto 2>&1)"; RC=$?
eq "exits 0" "0" "$RC"
# robot is worn by alice; codxu's own cat does not count against it, but owl
# comes first among the free ones.
eq "it saved owl as codxu's avatar" "ChatGifs/avatar-codxu.svg owl" "$(written)"
contains "it says which one it picked" "$OUT" "(owl)"
stop_server

echo "── the only free one is the agent's own ──"
start_server '{"alice":"robot","bob":"owl","codxu":"cat"}'
OUT="$("$CLI" chat avatar @t/ns --as codxu --pick auto 2>&1)"; RC=$?
eq "exits 0" "0" "$RC"
eq "codxu keeps cat, its own, instead of sharing" "ChatGifs/avatar-codxu.svg cat" "$(written)"
case "$OUT" in *"already in use"*) bad "it does not claim all are taken" "$OUT" ;; *) ok "it does not claim all are taken" ;; esac
stop_server

echo "── every built-in is taken ──"
start_server '{"a":"robot","b":"owl","c":"cat"}'
OUT="$("$CLI" chat avatar @t/ns --as newbie --pick auto 2>&1)"; RC=$?
eq "still exits 0" "0" "$RC"
eq "it shares the first built-in" "ChatGifs/avatar-newbie.svg robot" "$(written)"
contains "it says every one is in use" "$OUT" "already in use"
stop_server

echo "── an explicit --pick still wins ──"
start_server '{"alice":"robot"}'
"$CLI" chat avatar @t/ns --as codxu --pick robot >/dev/null 2>&1; RC=$?
eq "exits 0" "0" "$RC"
eq "it saved the named one even though it is worn" "ChatGifs/avatar-codxu.svg robot" "$(written)"
stop_server

echo
echo "=== $((PASS+FAIL)) checks: $(green "$PASS passed"), $([ "$FAIL" -gt 0 ] && red "$FAIL failed" || echo "0 failed") ==="
[ "$FAIL" -eq 0 ]
