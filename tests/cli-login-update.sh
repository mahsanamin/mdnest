#!/usr/bin/env bash
#
# mdnest CLI: the login prompt against a server, `update --server`, and the
# installer a server hands out (frontend/public/cli/install.sh)
#
# Drives the real CLI, as a subprocess with a throwaway HOME, against a fake
# backend. tests/cli-unit.sh covers the token prompt with no server; this
# covers the parts that need one:
#   - a server with no SERVER_ALIAS: login asks for a name instead of failing
#   - a token the server refuses (401) is not saved
#   - `mdnest update --server` refuses an error page, a non-script body and a
#     404, and leaves the installed CLI byte-for-byte as it was
#   - `update --server` installs the server's CLI when it is a real one
#   - the served installer installs from the server and only prints the login
#
# Needs python3 (the fake backend and the pty driver) and SKIPs without it.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/mdnest"
PTY="$REPO_ROOT/tests/pty-drive.py"
# No AI agent skills question during login (it has its own cases below).
export MDNEST_AGENT_SKILLS=0
# Exact text, also under the pty driver; colour is covered in cli-unit.sh.
export NO_COLOR=1

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '         %s\n' "$2"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi; }
contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "[$2] does not contain [$3]" ;; esac; }

echo "=== mdnest CLI: login prompt, update --server, served installer ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 not present (needed for the fake backend and the pty driver)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mdnest-login-update.XXXXXX")"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# The fake backend reads its behaviour from files in $WORK on every request,
# so one server covers every case:
#   alias       the SERVER_ALIAS to report (empty file: none)
#   cli_mode    what /cli/mdnest serves: real | samever | newer | html | junk | missing
cat > "$WORK/fake_backend.py" <<'PY'
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

WORK = sys.argv[2]
REAL_CLI = sys.argv[3]

def read(name):
    try:
        with open(os.path.join(WORK, name)) as f:
            return f.read().strip()
    except OSError:
        return ""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, code, body, ctype="text/plain"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/config":
            alias = read("alias")
            extra = ',"serverAlias":"%s"' % alias if alias else ""
            if read("pages") == "on":
                extra += ',"chat":true,"taskBoard":true,"pages":{"enabled":true,"scripts":false}'
            return self.send(200, '{"version":"4.8.5-dev"%s}' % extra, "application/json")
        if p == "/api/namespaces":
            if self.headers.get("Authorization") == "Bearer mdnest_good":
                return self.send(200, '[]', "application/json")
            return self.send(401, '{"error":"unauthorized"}', "application/json")
        if p == "/cli/mdnest":
            mode = read("cli_mode")
            if mode == "real":
                with open(REAL_CLI, "rb") as f:
                    return self.send(200, f.read())
            if mode == "samever":
                # A later develop build: same version label, different bytes.
                with open(REAL_CLI, "rb") as f:
                    return self.send(200, f.read() + b"\n# a later build with the same version label\n")
            if mode == "newer":
                return self.send(200, '#!/bin/bash\nMDNEST_CLI_VERSION="99.0.0"\necho "fake newer cli"\n')
            if mode == "html":
                return self.send(200, "<!doctype html><html><body>Please sign in</body></html>", "text/html")
            if mode == "junk":
                # A shebang but no version marker: half a script, or not ours.
                return self.send(200, "#!/bin/sh\necho hi\n")
            return self.send(404, "not found")
        return self.send(404, "not found")

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
URL="http://127.0.0.1:$PORT"
: > "$WORK/alias"
python3 "$WORK/fake_backend.py" "$PORT" "$WORK" "$CLI" &
SRV_PID=$!
for _ in $(seq 1 50); do
  curl -s -o /dev/null "$URL/api/config" && break
  sleep 0.1
done

new_home() { mktemp -d "$WORK/home.XXXXXX"; }
files_in() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }

# ── login: the server has no SERVER_ALIAS ───────────────────────────────────
echo "── login prompt against a server ──"
: > "$WORK/alias"
H="$(new_home)"; rc=0
out="$(HOME="$H" PTY_PROMPTS="$(printf 'Name for this server: \nToken (not shown): ')" \
  PTY_ANSWERS="$(printf 'fakesrv\nmdnest_good')" \
  python3 "$PTY" -- "$CLI" login "$URL" 2>&1)" || rc=$?
eq "no SERVER_ALIAS: login succeeds" "0" "$rc"
contains "no SERVER_ALIAS: asks for a name" "$out" "Name for this server: "
eq "no SERVER_ALIAS: saved under the typed name" "token=mdnest_good" \
   "$(grep '^token=' "$H/.config/mdnest/servers/fakesrv" 2>/dev/null)"
case "$out" in *mdnest_good*|*PTY-ECHO-STILL-ON*) bad "no SERVER_ALIAS: token not echoed" "got [$out]" ;;
  *) ok "no SERVER_ALIAS: token not echoed" ;; esac

H="$(new_home)"; rc=0
out="$(HOME="$H" PTY_PROMPTS="Name for this server: " PTY_ANSWERS="a/b" \
  python3 "$PTY" -- "$CLI" login "$URL" 2>&1)" || rc=$?
eq "a bad name is refused" "1" "$rc"
eq "a bad name saves nothing" "0" "$(files_in "$H")"

# ── login: the server has a SERVER_ALIAS ────────────────────────────────────
echo "srvalias" > "$WORK/alias"
H="$(new_home)"; rc=0
out="$(HOME="$H" PTY_PROMPTS="Token (not shown): " PTY_ANSWERS="mdnest_good" \
  python3 "$PTY" -- "$CLI" login "$URL" 2>&1)" || rc=$?
eq "SERVER_ALIAS: login succeeds" "0" "$rc"
case "$out" in *"Name for this server"*) bad "SERVER_ALIAS: no name prompt" "got [$out]" ;;
  *) ok "SERVER_ALIAS: no name prompt" ;; esac
eq "SERVER_ALIAS: saved under the server's alias" "token=mdnest_good" \
   "$(grep '^token=' "$H/.config/mdnest/servers/srvalias" 2>/dev/null)"

# ── login: a hostile SERVER_ALIAS ───────────────────────────────────────────
echo "../evil" > "$WORK/alias"
H="$(new_home)"; rc=0
out="$(HOME="$H" "$CLI" login "$URL" mdnest_good 2>&1)" || rc=$?
eq "a SERVER_ALIAS with a path in it is refused" "1" "$rc"
eq "a SERVER_ALIAS with a path in it saves nothing" "0" "$(files_in "$H")"
echo "srvalias" > "$WORK/alias"

# ── login: the server refuses the token ─────────────────────────────────────
H="$(new_home)"; rc=0
out="$(HOME="$H" PTY_PROMPTS="Token (not shown): " PTY_ANSWERS="mdnest_wrong" \
  python3 "$PTY" -- "$CLI" login "$URL" 2>&1)" || rc=$?
eq "rejected token: exits 1" "1" "$rc"
eq "rejected token: saves nothing" "0" "$(files_in "$H")"
contains "rejected token: says so" "$out" "did not accept that token"
case "$out" in *mdnest_wrong*) bad "rejected token: not printed" "got [$out]" ;;
  *) ok "rejected token: not printed" ;; esac

# ── update --server ─────────────────────────────────────────────────────────
echo "── update --server ──"
H="$(new_home)"
mkdir -p "$H/.config/mdnest/servers" "$WORK/bin"
printf 'url=%s\ntoken=mdnest_good\n' "$URL" > "$H/.config/mdnest/servers/fake"
cp "$CLI" "$WORK/bin/mdnest"; chmod 755 "$WORK/bin/mdnest"
before="$(cksum < "$WORK/bin/mdnest")"

for mode in html junk missing; do
  echo "$mode" > "$WORK/cli_mode"
  rc=0
  out="$(HOME="$H" "$WORK/bin/mdnest" update --server @fake 2>&1)" || rc=$?
  eq "update --server ($mode): fails" "1" "$rc"
  eq "update --server ($mode): installed CLI untouched" "$before" "$(cksum < "$WORK/bin/mdnest")"
  contains "update --server ($mode): names the server's URL" "$out" "$URL/cli/mdnest"
done
contains "update --server: says the CLI was left alone" "$out" "left as it was"

rc=0
out="$(HOME="$H" "$WORK/bin/mdnest" update --server @nosuch 2>&1)" || rc=$?
eq "update --server: unknown alias fails" "1" "$rc"
eq "update --server: unknown alias leaves the CLI alone" "$before" "$(cksum < "$WORK/bin/mdnest")"

echo "real" > "$WORK/cli_mode"
rc=0
out="$(HOME="$H" "$WORK/bin/mdnest" update --server @fake 2>&1)" || rc=$?
eq "update --server: same version is a no-op" "0" "$rc"
contains "update --server: says up to date" "$out" "up to date"

# Between releases every develop build has the same version label, so only
# the bytes tell an older copy from a newer one.
case "$("$WORK/bin/mdnest" --version)" in
  "mdnest CLI v"*" ("[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]")") ok "--version: shows a content fingerprint" ;;
  *) bad "--version: shows a content fingerprint" "got [$("$WORK/bin/mdnest" --version)]" ;;
esac
echo "samever" > "$WORK/cli_mode"
inode_before="$(ls -i "$WORK/bin/mdnest" | awk '{print $1}')"
rc=0
out="$(HOME="$H" "$WORK/bin/mdnest" update --server @fake 2>&1)" || rc=$?
eq "update: same label, new bytes: exits 0" "0" "$rc"
# A new file, not a rewrite of the old one: bash reads a running script as it
# goes, so a 'chat wait' started from the old file must keep its own copy.
if [ "$inode_before" != "$(ls -i "$WORK/bin/mdnest" | awk '{print $1}')" ]; then
  ok "update: replaces the file (new inode), never rewrites it in place"
else
  bad "update: replaces the file (new inode), never rewrites it in place" "same inode $inode_before"
fi
contains "update: same label, new bytes: says it updates" "$out" "Updating mdnest CLI"
case "$(tail -1 "$WORK/bin/mdnest")" in
  *"same version label"*) ok "update: same label, new bytes: installs the served file" ;;
  *) bad "update: same label, new bytes: installs the served file" "the old file is still installed" ;;
esac
rc=0
out="$(HOME="$H" "$WORK/bin/mdnest" update --server @fake 2>&1)" || rc=$?
eq "update: byte-identical: exits 0" "0" "$rc"
contains "update: byte-identical: says up to date" "$out" "up to date"
rc=0
out="$(HOME="$H" "$WORK/bin/mdnest" update --server @fake --force 2>&1)" || rc=$?
contains "update --force: re-installs a byte-identical copy" "$out" "Updating mdnest CLI"

echo "newer" > "$WORK/cli_mode"
rc=0
out="$(HOME="$H" "$WORK/bin/mdnest" update --server "$URL" 2>&1)" || rc=$?
eq "update --server URL: installs the server's CLI" "0" "$rc"
contains "update --server URL: names the source" "$out" "Source: $URL/cli/mdnest"
eq "update --server URL: installed file is the served one" "fake newer cli" "$("$WORK/bin/mdnest")"

# ── the installer a server serves ───────────────────────────────────────────
echo "── served installer ──"
echo "real" > "$WORK/cli_mode"
echo "srvalias" > "$WORK/alias"
H="$(new_home)"; rc=0
out="$(HOME="$H" MDNEST_BIN_DIR="$WORK/ibin" bash "$REPO_ROOT/frontend/public/cli/install.sh" "$URL" 2>&1 </dev/null)" || rc=$?
eq "installer: exits 0" "0" "$rc"
if cmp -s "$WORK/ibin/mdnest" "$CLI"; then ok "installer: installed the server's CLI"
else bad "installer: installed the server's CLI" "installed file differs"; fi
# It only installs. Connecting is a separate step, printed for this server.
contains "installer: prints the connect command for this server" "$out" "mdnest login $URL"
eq "installer: does not log in by itself" "0" "$(files_in "$H")"

rc=0
out="$(bash "$REPO_ROOT/frontend/public/cli/install.sh" 2>&1 </dev/null)" || rc=$?
eq "installer: no server URL fails" "1" "$rc"
contains "installer: no server URL shows how" "$out" "install.sh | bash -s -- https://"

# ── the agent skills question: served installer and login ──────────────────
# Run with MDNEST_AGENT_SKILLS unset, a HOME with ~/.claude, and a PATH
# without the machine's own claude/codex. A case that must not ask still lists
# the question as a prompt, so a wrong question fails the case instead of
# hanging it.
echo "── agent skills question ──"
Q="use mdnest? [Y/n] "
SKILL=".claude/skills/mdnest/SKILL.md"
PY="$(command -v python3)"
SAFE_PATH=/usr/bin:/bin:/usr/sbin:/sbin
rm -rf "$WORK/ibin"
inst_pty() {  # inst_pty <prompts> <answers> [installer args...]
  local prompts="$1" answers="$2"; shift 2
  env -u MDNEST_AGENT_SKILLS HOME="$H" PATH="$SAFE_PATH" MDNEST_BIN_DIR="$WORK/ibin" \
    PTY_PROMPTS="$prompts" PTY_ANSWERS="$answers" \
    "$PY" "$PTY" -- /bin/bash "$REPO_ROOT/frontend/public/cli/install.sh" "$@" 2>&1
}
login_pty() {  # login_pty <prompts> <answers>
  env -u MDNEST_AGENT_SKILLS HOME="$H" PATH="$SAFE_PATH" \
    PTY_PROMPTS="$1" PTY_ANSWERS="$2" "$PY" "$PTY" -- "$CLI" login "$URL" 2>&1
}

H="$(new_home)"; mkdir -p "$H/.claude"
out="$(inst_pty "$Q" "" "$URL")"; rc=$?
eq "installer + Enter: exits 0" "0" "$rc"
contains "installer: asks the question" "$out" "Let your AI tools (Claude Code, Codex, ...) use mdnest? [Y/n]"
[ -f "$H/$SKILL" ] && ok "installer + Enter: installs the skill" || bad "installer + Enter: installs the skill" "$out"
contains "installer + Enter: says how to undo it" "$out" "mdnest agent remove"

H="$(new_home)"; mkdir -p "$H/.claude"
out="$(inst_pty "$Q" "n" "$URL")"
[ ! -e "$H/$SKILL" ] && ok "installer + no: installs nothing" || bad "installer + no: installs nothing" "$out"
[ -f "$H/.config/mdnest/agent-skills-declined" ] && ok "installer + no: remembers it" || bad "installer + no: remembers it" "$out"
echo "srvalias" > "$WORK/alias"
out="$(login_pty "$(printf 'Token (not shown): \n%s' "$Q")" "$(printf 'mdnest_good\ny')")"; rc=$?
eq "login after no: logs in" "0" "$rc"
case "$out" in *"$Q"*) bad "login after no: does not ask again" "$out" ;; *) ok "login after no: does not ask again" ;; esac
out="$(inst_pty "$Q" "y" "$URL")"
case "$out" in *"$Q"*) bad "installer after no: does not ask again" "$out" ;; *) ok "installer after no: does not ask again" ;; esac

H="$(new_home)"; mkdir -p "$H/.claude"
out="$(env -u MDNEST_AGENT_SKILLS HOME="$H" PATH="$SAFE_PATH" MDNEST_BIN_DIR="$WORK/ibin" MDNEST_TTY="$H/no-such-tty" \
  bash "$REPO_ROOT/frontend/public/cli/install.sh" "$URL" 2>&1 </dev/null)"; rc=$?
eq "installer, no terminal: exits 0" "0" "$rc"
contains "installer, no terminal: prints the hint" "$out" "Run 'mdnest agent install'"
[ ! -e "$H/$SKILL" ] && ok "installer, no terminal: installs nothing" || bad "installer, no terminal: installs nothing" "$out"

out="$(env -u MDNEST_AGENT_SKILLS HOME="$H" PATH="$SAFE_PATH" MDNEST_BIN_DIR="$WORK/ibin" MDNEST_TTY="$H/no-such-tty" \
  bash "$REPO_ROOT/frontend/public/cli/install.sh" --agent-skills "$URL" 2>&1 </dev/null)"; rc=$?
eq "installer --agent-skills (flag first): exits 0" "0" "$rc"
[ -f "$H/$SKILL" ] && ok "installer --agent-skills: installs without asking" || bad "installer --agent-skills: installs without asking" "$out"
case "$out" in *"$Q"*) bad "installer --agent-skills: no question" "$out" ;; *) ok "installer --agent-skills: no question" ;; esac
out="$(inst_pty "$Q" "y" "$URL")"
case "$out" in *"$Q"*) bad "installer, already installed: no question" "$out" ;; *) ok "installer, already installed: no question" ;; esac

H="$(new_home)"; mkdir -p "$H/.claude"
out="$(inst_pty "$Q" "y" "$URL" --no-agent-skills)"; rc=$?
eq "installer --no-agent-skills: exits 0" "0" "$rc"
case "$out" in *"$Q"*) bad "installer --no-agent-skills: never asks" "$out" ;; *) ok "installer --no-agent-skills: never asks" ;; esac
[ ! -e "$H/$SKILL" ] && ok "installer --no-agent-skills: installs nothing" || bad "installer --no-agent-skills: installs nothing" "$out"

# Someone who installed the CLI before the installer asked: login asks once.
out="$(login_pty "$(printf 'Token (not shown): \n%s' "$Q")" "$(printf 'mdnest_good\n')")"; rc=$?
eq "login: logs in" "0" "$rc"
contains "login: asks the question after logging in" "$out" "Let your AI tools"
[ -f "$H/$SKILL" ] && ok "login + Enter: installs the skill" || bad "login + Enter: installs the skill" "$out"
out="$(login_pty "$(printf 'Token (not shown): \n%s' "$Q")" "$(printf 'mdnest_good\ny')")"
case "$out" in *"$Q"*) bad "login, already installed: no question" "$out" ;; *) ok "login, already installed: no question" ;; esac

# A failed login asks nothing.
H="$(new_home)"; mkdir -p "$H/.claude"
out="$(login_pty "$(printf 'Token (not shown): \n%s' "$Q")" "$(printf 'mdnest_wrong\ny')")"
case "$out" in *"$Q"*) bad "login refused: no question" "$out" ;; *) ok "login refused: no question" ;; esac

# update keeps the hint and never asks.
out="$(env -u MDNEST_AGENT_SKILLS HOME="$H" PATH="$SAFE_PATH" PTY_PROMPTS="$Q" PTY_ANSWERS="y" \
  "$PY" "$PTY" -- "$WORK/ibin/mdnest" update --server "$URL" 2>&1)"
case "$out" in *"$Q"*) bad "update: never asks" "$out" ;; *) ok "update: never asks" ;; esac
contains "update: keeps the hint" "$out" "Run 'mdnest agent install'"

echo
# ── features: what an agent checks before it offers an HTML page ────────────
H="$(new_home)"; HOME="$H" "$CLI" login @feat "$URL" mdnest_good >/dev/null 2>&1
echo "off" > "$WORK/pages"
out="$(HOME="$H" "$CLI" features @feat --json 2>&1)"
eq "features --json: pages off when the server does not have them" '{"pages": false, "pages_scripts": false, "chat": false, "task_board": false, "excalidraw": false, "marp": false, "live_collab": false}' "$out"
echo "on" > "$WORK/pages"
out="$(HOME="$H" "$CLI" features @feat --json 2>&1)"
eq "features --json: pages on, scripts off" '{"pages": true, "pages_scripts": false, "chat": true, "task_board": true, "excalidraw": false, "marp": false, "live_collab": false}' "$out"
out="$(HOME="$H" "$CLI" features @feat 2>&1)"
case "$out" in *"pages        on"*"scripts off"*) ok "features: plain list says pages on, scripts off" ;; *) bad "features: plain list says pages on, scripts off" "$out" ;; esac
echo "off" > "$WORK/pages"

echo "=== $((PASS+FAIL)) checks: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
