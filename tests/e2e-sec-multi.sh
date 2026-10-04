#!/usr/bin/env bash
#
# Multi-mode access e2e for the v4.6.2 security fixes
# ───────────────────────────────────────────────────
# routes_test.go pins every guard against fake grant stores. This runs the
# same promises for real: Postgres, the backend built from the working tree,
# real users, a path-scoped grant, a group grant, an API token, TOTP, a
# git-backed namespace with a credentialed remote, symlinks placed on the host,
# and live collaboration on. Every denied case is checked against the disk and
# the response body, not just the status code, and every normal case is
# checked to still work.
#
# Usage:  tests/e2e-sec-multi.sh
# Needs:  docker, curl, python3, git. Exit 0 if every check passes.

set -uo pipefail
# Run from a git hook (the pre-push gate), git exports GIT_DIR and friends, and
# every `git -C <fixture>` below would act on THIS repository instead: commit
# the fixture onto the branch being pushed, rewrite its config. Clear them.
while IFS= read -r v; do unset "$v"; done < <(env | sed -n 's/^\(GIT_[A-Z_]*\)=.*/\1/p')
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

IMAGE="mdnest-e2e-backend:sec"
SFX="$$"
NET="mdnest-e2e-sec-net-$SFX"
PG="mdnest-e2e-sec-pg-$SFX"
BE="mdnest-e2e-sec-be-$SFX"
# Under the repo, not /tmp: the Docker VM may not see the host's temp dir.
NOTES_DIR="$(mktemp -d "$REPO_ROOT/.e2e-notes.XXXXXX")"

fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$1"; }

cleanup() {
  docker rm -f "$BE" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$NOTES_DIR"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { fail "docker is required"; exit 2; }
command -v python3 >/dev/null 2>&1 || { fail "python3 is required"; exit 2; }
command -v git >/dev/null 2>&1 || { fail "git is required"; exit 2; }

echo "▶ building the backend from the working tree"
docker build -t "$IMAGE" backend/ >/tmp/mdnest-e2e-sec-build.log 2>&1 || { fail "build failed"; tail -30 /tmp/mdnest-e2e-sec-build.log; exit 1; }

PRIVATE_ID="dddddddd-4444-4444-8444-444444444444"
A="$NOTES_DIR/alpha"
mkdir -p "$A"/{Shared,Private,Team,ChatGifs} "$A/.mdnest/comments" "$NOTES_DIR/beta"
printf 'shared words\n- [ ] SHARED-TASK\n' > "$A/Shared/a.md"
printf 'TOP-SECRET\n- [ ] SECRET-TASK\n\n<!-- mdnest:%s -->\n' "$PRIVATE_ID" > "$A/Private/p.md"
printf -- '---\nmdnest-chat: true\ntitle: SECRET-ROOM\n---\n' > "$A/Private/room.md"
printf 'team\n' > "$A/Team/t.md"
printf 'GIF89a' > "$A/ChatGifs/secret-gif.gif"
printf '{"id":"c1","author":"boss","body":"PRIVATE-COMMENT","createdAt":"2026-01-01T00:00:00Z"}\n' > "$A/.mdnest/comments/$PRIVATE_ID.jsonl"
git -C "$A" init -q
git -C "$A" remote add origin "https://bob:s3cr3t-pat@git.example.com/team/alpha.git"
git -C "$A" -c user.name=t -c user.email=t@t -c commit.gpgsign=false add -A
git -C "$A" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m seed
# Relative links, so they resolve the same inside the container.
ln -s ../Private/p.md "$A/Shared/link.md"
ln -s ../Private "$A/Shared/ldir"
ln -s a.md "$A/Shared/ok-link.md"
ln -s ../.git/config "$A/Shared/cfg.md"
printf 'BETA-SECRET\n' > "$NOTES_DIR/beta/secret.md"
ln -s ../../beta/secret.md "$A/Shared/out.md"
chmod -R a+rwX "$NOTES_DIR"

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=mdnest -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mdnest postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U mdnest >/dev/null 2>&1 && break; sleep 1; done

docker run -d --name "$BE" --network "$NET" \
  -e AUTH_MODE=multi -e POSTGRES_HOST="$PG" -e POSTGRES_PASSWORD=pw \
  -e MDNEST_USER=admin -e MDNEST_PASSWORD=adminpass123 -e MDNEST_JWT_SECRET=e2e-sec-secret \
  -e NOTES_DIR=/notes -e FRONTEND_ORIGIN=http://localhost \
  -e ENABLE_LIVE_COLLAB=true -e ENABLE_TASK_BOARD=true -e DISABLE_UPDATE_CHECK=true \
  -v "$NOTES_DIR:/notes" -p 127.0.0.1:0:8080 "$IMAGE" >/dev/null
PORT="$(docker port "$BE" 8080/tcp | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 40); do curl -fsS "$BASE/api/config" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$BASE/api/config" >/dev/null 2>&1 || { fail "backend never became healthy"; docker logs "$BE" | tail -30; exit 1; }
pass "multi-mode backend up at $BASE"

BASE="$BASE" PORT="$PORT" NOTES="$NOTES_DIR" PG="$PG" PRIVATE_ID="$PRIVATE_ID" python3 - <<'PY'
import base64, hashlib, hmac, http.client, json, os, struct, subprocess, sys, time, urllib.parse, urllib.request, urllib.error

BASE, PORT, NOTES, PG, PID = os.environ["BASE"], int(os.environ["PORT"]), os.environ["NOTES"], os.environ["PG"], os.environ["PRIVATE_ID"]
passed = failed = 0

def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print(f"  \033[32mPASS\033[0m {name}")
    else:
        failed += 1; print(f"  \033[31mFAIL\033[0m {name}  {str(extra)[:300]}")

def call(method, path, token=None, body=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read(); code = r.status
    except urllib.error.HTTPError as e:
        b = e.read(); code = e.code
    text = b.decode(errors="replace")
    try:
        return code, json.loads(text or "null")
    except ValueError:
        return code, text

def q(p): return urllib.parse.quote(p, safe="")

def totp_code(secret, at=None):
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    c = struct.pack(">Q", int((at or time.time()) // 30))
    d = hmac.new(key, c, hashlib.sha1).digest()
    o = d[-1] & 15
    return "%06d" % ((struct.unpack(">I", d[o:o + 4])[0] & 0x7fffffff) % 1000000)

def login(user, pw):
    code, r = call("POST", "/api/auth/login", body={"username": user, "password": pw})
    if isinstance(r, dict) and r.get("status") == "change_password_required":
        code, r = call("POST", "/api/auth/change-password-forced", body={"tempToken": r["tempToken"], "newPassword": pw + "X"})
    assert isinstance(r, dict) and r.get("token"), f"login {user}: {code} {r}"
    return r["token"]

def disk(rel):
    try:
        with open(os.path.join(NOTES, rel), errors="replace") as f:
            return f.read()
    except OSError as e:  # e.g. a refused request turned the file into a folder
        return f"<{e.__class__.__name__}>"

def ws_status(token, path):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
    c.request("GET", f"/api/ws?ns=alpha&path={q(path)}&token={token}", headers={
        "Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": base64.b64encode(os.urandom(16)).decode()})
    s = c.getresponse().status
    c.close()
    return s

admin = login("admin", "adminpass123")
for name in ("pat", "gus", "owen", "erin"):
    code, r = call("POST", "/api/admin/invite", admin, {"email": f"{name}@e2e.local", "username": name, "password": name + "pass123", "role": "collaborator"})
    assert code in (200, 201), f"invite {name}: {code} {r}"
code, all_users = call("GET", "/api/admin/users", admin)
ids = {u["username"]: u["id"] for u in (all_users if isinstance(all_users, list) else all_users.get("users", []))}
for user, path, perm in (("pat", "/Shared", "write"), ("owen", "/", "write"), ("erin", "/", "read")):
    code, r = call("POST", "/api/admin/grants", admin, {"user_id": ids[user], "namespace": "alpha", "path": path, "permission": perm})
    assert code in (200, 201), f"grant: {code} {r}"
code, g = call("POST", "/api/admin/groups", admin, {"name": "readers", "description": "e2e"})
assert code in (200, 201), f"group: {code} {g}"
call("POST", "/api/admin/groups/members", admin, {"group_id": g["id"], "user_id": ids["gus"]})
code, r = call("POST", "/api/admin/groups/grants", admin, {"group_id": g["id"], "namespace": "alpha", "path": "/Shared", "permission": "read"})
assert code in (200, 201), f"group grant: {code} {r}"

pat, gus, owen = login("pat", "patpass123"), login("gus", "guspass123"), login("owen", "owenpass123")
code, tok = call("POST", "/api/auth/tokens", pat, {"name": "e2e"})
pat_api = tok["token"]
code, hist = call("GET", "/api/note/history?ns=alpha&path=Private/p.md", owen)
sha = hist[0]["commit"] if isinstance(hist, list) and hist else "0000000"

print("── folder grants: pat (direct write /Shared), gus (group read /Shared), pat's API token")
for who, t in (("pat", pat), ("gus", gus), ("pat's API token", pat_api)):
    code, r = call("GET", "/api/search?ns=alpha&q=TOP-SECRET", t)
    check(f"{who}: search finds nothing in /Private", code == 200 and "TOP-SECRET" not in json.dumps(r), r)
    code, r = call("GET", "/api/search?ns=alpha&q=shared%20words", t)
    check(f"{who}: search still finds /Shared", code == 200 and "Shared/a.md" in json.dumps(r), r)
    code, r = call("GET", "/api/tasks/all", t)
    check(f"{who}: tasks/all lists only /Shared tasks", code == 200 and "SECRET-TASK" not in json.dumps(r) and "SHARED-TASK" in json.dumps(r), r)
    code, r = call("GET", f"/api/note/at?ns=alpha&path=Private/p.md&ref={sha}", t)
    check(f"{who}: note/at of /Private is 403", code == 403 and "TOP-SECRET" not in json.dumps(r), (code, r))
    code, r = call("GET", "/api/note/history?ns=alpha&path=Private/p.md", t)
    check(f"{who}: history of /Private is 403", code == 403, (code, r))
    code, r = call("GET", "/api/comments?ns=alpha&path=Private/p.md", t)
    check(f"{who}: comments of /Private are 403", code == 403 and "PRIVATE-COMMENT" not in json.dumps(r), (code, r))
    code, r = call("GET", "/api/note/attribution?ns=alpha&path=Private/p.md", t)
    check(f"{who}: attribution of /Private is 403", code == 403, (code, r))
    code, r = call("GET", "/api/chats", t)
    check(f"{who}: chats omit the /Private room", code == 200 and "SECRET-ROOM" not in json.dumps(r), r)
    code, r = call("GET", "/api/chat/gifs?ns=alpha", t)
    check(f"{who}: gif library omits an unreadable folder", code == 200 and "secret-gif" not in json.dumps(r), r)
    for p in ("Shared/link.md", "Shared/ldir/p.md"):
        code, r = call("GET", f"/api/note?ns=alpha&path={p}", t)
        check(f"{who}: GET {p} (link out of the grant) is 403", code == 403 and "TOP-SECRET" not in json.dumps(r), (code, r))
        code, r = call("GET", f"/api/files/alpha/{p}", t)
        check(f"{who}: /api/files {p} is 403", code == 403 and "TOP-SECRET" not in json.dumps(r), (code, r))
    code, r = call("GET", "/api/note?ns=alpha&path=Shared/ok-link.md", t)
    check(f"{who}: a link inside the grant still works", code == 200 and "shared words" in json.dumps(r), (code, r))
    code, r = call("GET", "/api/note?ns=alpha&path=Shared/a.md", t)
    check(f"{who}: the granted note still reads", code == 200, code)
code, r = call("PUT", "/api/note?ns=alpha&path=Shared/link.md", pat, raw=b"OVERWRITTEN")
check("pat: PUT through a link out of the grant is 403, target untouched", code == 403 and "OVERWRITTEN" not in disk("alpha/Private/p.md"), (code, r))
code, r = call("PATCH", "/api/note?ns=alpha&path=Shared/a.md", pat, raw=b"pat was here\n")
check("pat: append inside the grant still works", code == 200 and "pat was here" in disk("alpha/Shared/a.md"), (code, r))

print("── whole-namespace reader owen: everything still visible")
code, r = call("GET", "/api/search?ns=alpha&q=TOP-SECRET", owen)
check("owen: search finds /Private", "Private/p.md" in json.dumps(r), r)
code, r = call("GET", "/api/tasks/all", owen)
check("owen: tasks/all includes /Private", "SECRET-TASK" in json.dumps(r), r)
code, r = call("GET", f"/api/note/at?ns=alpha&path=Private/p.md&ref={sha}", owen)
check("owen: note/at works", code == 200 and "TOP-SECRET" in json.dumps(r), (code, r))
code, r = call("GET", "/api/comments?ns=alpha&path=Private/p.md", owen)
check("owen: comments work", code == 200 and "PRIVATE-COMMENT" in json.dumps(r), (code, r))
code, r = call("GET", "/api/note?ns=alpha&path=Shared/link.md", owen)
check("owen: follows a link anywhere in the namespace", code == 200 and "TOP-SECRET" in json.dumps(r), (code, r))

print("── .git and .mdnest are never request paths (owen has full write)")
payload = b'[core]\n\tfsmonitor = "touch /notes/PWNED; false"\n'
for p in (".git/config", ".GIT/config", "Shared/../.git/config", ".mdnest/comments/" + PID + ".jsonl"):
    for m in ("GET", "PUT", "PATCH", "POST", "DELETE"):
        code, r = call(m, f"/api/note?ns=alpha&path={q(p)}", owen, raw=payload)
        check(f"{m} /api/note {p} is 400", code == 400, (code, r))
    for m, url in (("GET", f"/api/files/alpha/{p}"), ("GET", f"/api/note/history?ns=alpha&path={q(p)}"),
                   ("POST", f"/api/folder?ns=alpha&path={q(p)}"), ("POST", f"/api/move?ns=alpha&from=Shared/a.md&to={q(p)}"),
                   ("GET", f"/api/comments?ns=alpha&path={q(p)}"), ("GET", f"/api/chat?ns=alpha&path={q(p)}")):
        code, r = call(m, url, owen, raw=payload)
        check(f"{m} {url.split('?')[0]} {p} is refused", 400 <= code < 500 and "[core]" not in json.dumps(r), (code, r))
for p in ("Shared/cfg.md", "Shared/out.md"):
    code, r = call("GET", f"/api/note?ns=alpha&path={p}", owen)
    check(f"owen: GET {p} (link into .git / out of the namespace) is refused", code >= 400 and "[core]" not in json.dumps(r) and "BETA-SECRET" not in json.dumps(r), (code, r))
    code, r = call("PUT", f"/api/note?ns=alpha&path={p}", owen, raw=payload)
    check(f"owen: PUT {p} is refused", code >= 400, (code, r))
code, r = call("PUT", "/api/board?ns=alpha&path=Shared/a.md", pat, {"version": 1, "columns": [{"id": "x", "title": "Hijacked"}]})
check("pat: replacing the namespace board needs namespace write (403)", code == 403, (code, r))
cfg = disk("alpha/.git/config")
check(".git/config was not written", "fsmonitor" not in cfg, cfg)
check("the remote is still configured", "git.example.com" in cfg, cfg)
open(os.path.join(NOTES, "alpha", "n.md"), "w").write("x")
subprocess.run(["git", "-C", os.path.join(NOTES, "alpha"), "add", "-A"], capture_output=True)
check("git add -A runs nothing", not os.path.exists(os.path.join(NOTES, "PWNED")))
code, r = call("GET", "/api/tree?ns=alpha", owen)
check("the tree lists neither .git nor .mdnest", ".git" not in json.dumps(r) and ".mdnest" not in json.dumps(r), r)

print("── git sync status")
code, r = call("GET", "/api/admin/sync-status?ns=beta", pat)
check("sync-status of a namespace without access is 403", code == 403, (code, r))
code, r = call("GET", "/api/admin/sync-status?ns=alpha", pat)
check("sync-status hides remote credentials", code == 200 and "s3cr3t" not in json.dumps(r) and "git.example.com" in json.dumps(r), r)

print("── login step tokens are not sessions")
code, r = call("POST", "/api/admin/invite", admin, {"email": "tess@e2e.local", "username": "tess", "password": "tesspass123", "role": "collaborator"})
code, r = call("POST", "/api/auth/login", body={"username": "tess", "password": "tesspass123"})
step = r.get("tempToken")
check("a new user gets a change-password step token", r.get("status") == "change_password_required" and step, r)
code, _ = call("GET", "/api/namespaces", step)
check("the change-password step token is not a session (401)", code == 401, code)
code, _ = call("GET", f"/api/files/alpha/Shared/a.md?token={step}")
check("…nor through the ?token= fallback (401)", code == 401, code)
check("…nor on the live-collab socket (401)", ws_status(step, "Shared/a.md") == 401)
# Erin enrols TOTP, then signs in with the password only.
erin = login("erin", "erinpass123")
code, s = call("POST", "/api/auth/totp/setup", erin)
secret = s.get("secret") if isinstance(s, dict) else None
code, r = call("POST", "/api/auth/totp/verify-setup", erin, {"code": totp_code(secret)})
check("erin enrolled TOTP", code == 200, (code, r))
code, r = call("POST", "/api/auth/login", body={"username": "erin", "password": "erinpass123X"})
step = r.get("tempToken") if isinstance(r, dict) else None
check("password-only login asks for the code", isinstance(r, dict) and r.get("status") == "totp_required" and step, r)
code, _ = call("GET", "/api/note?ns=alpha&path=Private/p.md", step)
check("the TOTP step token cannot read notes (401)", code == 401, code)
code, r = call("POST", "/api/auth/totp/setup-with-temp", body={"tempToken": step})
check("the TOTP step token cannot enrol a new authenticator", code in (401, 409) and "secret" not in json.dumps(r), (code, r))
code, r = call("POST", "/api/auth/change-password-forced", body={"tempToken": step, "newPassword": "hijacked123!"})
check("the TOTP step token cannot change the password", code == 401, (code, r))
code, r = call("POST", "/api/auth/verify-totp", body={"tempToken": step, "code": totp_code(secret)})
check("the real code still completes the login", code == 200 and isinstance(r, dict) and r.get("token"), (code, r))
if isinstance(r, dict) and r.get("token"):
    code, _ = call("GET", "/api/note?ns=alpha&path=Private/p.md", r["token"])
    check("…and that session works", code == 200, code)

print("── API tokens")
raw = "mdnest_e2e_ownerless_" + os.urandom(8).hex()
h = hashlib.sha256(raw.encode()).hexdigest()
subprocess.run(["docker", "exec", PG, "psql", "-U", "mdnest", "-d", "mdnest", "-qc",
    f"INSERT INTO api_tokens (id, name, token_hash, token_suffix, user_id) VALUES ('legacy1','legacy','{h}','{raw[-4:]}',NULL)"], check=True, capture_output=True)
code, r = call("GET", "/api/note?ns=alpha&path=Private/p.md", raw)
check("an ownerless (legacy) API token is refused (401)", code == 401 and "TOP-SECRET" not in json.dumps(r), (code, r))
code, r = call("GET", "/api/note?ns=alpha&path=Private/p.md", pat_api)
check("an owned API token keeps its owner's limits (403)", code == 403, code)

print("── live collaboration")
check("pat cannot join a /Private room (403)", ws_status(pat, "Private/p.md") == 403)
check("pat cannot join through a link (403)", ws_status(pat, "Shared/link.md") == 403)
check("pat joins a /Shared room (101)", ws_status(pat, "Shared/a.md") == 101)
check("gus (group reader) joins a /Shared room (101)", ws_status(gus, "Shared/a.md") == 101)

print(f"\n{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
PY
rc=$?
[ $rc -eq 0 ] && pass "multi-mode security e2e: all checks passed" || { fail "multi-mode security checks failed"; docker logs "$BE" 2>&1 | tail -20; }
exit $rc
