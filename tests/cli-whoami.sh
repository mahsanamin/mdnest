#!/usr/bin/env bash
#
# mdnest CLI: `whoami` names the account each saved token acts as.
#
# Before this, whoami printed the CLI version and the server list, nothing
# about the user. An agent asked "which account is this?" could not tell, and
# guessed from what a read happened to allow. This drives the real CLI against
# two fake servers (one multi-user, one single-user) and a closed port, with a
# working python3 and again with python3 and jq broken (the CLI must not need
# them).
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
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "output does not contain [$3]: $2" ;; esac; }
row() { printf '%s\n' "$1" | grep -E "^  @$2 +" | tail -1; }

echo "=== mdnest CLI whoami ==="

REAL_PY="$(command -v python3 || true)"
if [ -z "$REAL_PY" ]; then
  echo "  SKIP: python3 not present (needed only for the fake backend)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-whoami-test.XXXXXX")"
PIDS=""
cleanup() { for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

cat > "$WORK/fake_backend.py" <<'PY'
"""MODE=multi: /api/me answers per token. MODE=single: no /api/me at all."""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = os.environ["MODE"]
USERS = {
    "mdnest_alice": {"id": 3, "username": "alice", "email": "alice@x.test", "role": "collaborator",
                      "grants": [{"namespace": "notes", "path": "/", "permission": "read"}]},
    "mdnest_noname": {"id": 4, "username": "", "email": "bot@x.test", "role": "admin", "grants": []},
}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith("/api/config"):
            # latestRelease first, with nested strings, as the real server sends it.
            return self.reply(200, {"latestRelease": {"version": "1.0.0", "authMode": "nested"},
                                    "version": "9.9.9-test", "authMode": MODE})
        if self.path.startswith("/api/me") and MODE == "multi":
            tok = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if tok in USERS:
                return self.reply(200, USERS[tok])
            return self.reply(401, {"error": "invalid token"})
        self.reply(404, {"error": "not found"})

srv = HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
PY

start() {
  MODE="$1" "$REAL_PY" "$WORK/fake_backend.py" > "$WORK/port.$1" 2>"$WORK/srv.$1.err" &
  PIDS="$PIDS $!"
  local i=0
  while [ ! -s "$WORK/port.$1" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  [ -s "$WORK/port.$1" ] || { echo "fake backend did not start: $(cat "$WORK/srv.$1.err")"; exit 1; }
  cat "$WORK/port.$1"
}
MULTI=$(start multi)
SINGLE=$(start single)
# A port nothing listens on: bind one, then let it go.
DEAD=$("$REAL_PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')

export HOME="$WORK/home"
mkdir -p "$HOME/.config/mdnest/servers"
srv() { printf 'url=http://127.0.0.1:%s\ntoken=%s\n' "$2" "$3" > "$HOME/.config/mdnest/servers/$1"; }
srv team   "$MULTI"  mdnest_alice
srv bot    "$MULTI"  mdnest_noname
srv stale  "$MULTI"  mdnest_revoked
srv solo   "$SINGLE" mdnest_whatever
srv gone   "$DEAD"   mdnest_whatever
printf 'team' > "$HOME/.config/mdnest/default"

check() {
  local label="$1" out rc
  out=$("${@:2}" "$CLI" whoami 2>&1) && rc=0 || rc=$?
  [ "$rc" = "0" ] && ok "$label: exit 0" || bad "$label: exit 0" "exit $rc"
  has "$label: a multi-user token names its account and role" "$(row "$out" team)" "alice (collaborator)"
  has "$label: an account with no username falls back to its email" "$(row "$out" bot)" "bot@x.test (admin)"
  has "$label: a refused token says to log in again" "$(row "$out" stale)" "mdnest login @stale"
  has "$label: a single-user server says so" "$(row "$out" solo)" "single-user server"
  has "$label: an unreachable server says so" "$(row "$out" gone)" "unreachable"
}

echo "── with python3 ──"
check "python3"

echo "── with python3 and jq broken ──"
SHIM="$WORK/shim"; mkdir -p "$SHIM"
printf '#!/bin/sh\nexit 1\n' > "$SHIM/python3"; printf '#!/bin/sh\nexit 1\n' > "$SHIM/jq"
chmod +x "$SHIM/python3" "$SHIM/jq"
check "no parser" env PATH="$SHIM:$PATH"

echo ""
echo "cli-whoami: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
