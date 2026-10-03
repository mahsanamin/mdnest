#!/usr/bin/env bash
#
# Multi-mode permissions for folder download and cross-namespace transfer
# ────────────────────────────────────────────────────────────────────────
# /api/transfer names two namespaces in its body, so the query-param
# permission middleware cannot guard it; the handler checks both sides. The
# unit tests pin that against fakes. This runs it for real: Postgres, the
# backend built from the working tree, real users, path-scoped grants, an
# access group and an API token — and checks every allowed and denied case
# against the disk, not just the status code.
#
# Usage:  tests/e2e-transfer-multi.sh
# Needs:  docker, curl, python3. Exit 0 if every check passes.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

IMAGE="mdnest-e2e-backend:test"
SFX="$$"
NET="mdnest-e2e-multi-net-$SFX"
PG="mdnest-e2e-multi-pg-$SFX"
BE="mdnest-e2e-multi-be-$SFX"
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

echo "▶ building the backend from the working tree"
docker build -t "$IMAGE" backend/ >/tmp/mdnest-e2e-multi-build.log 2>&1 || { fail "build failed"; tail -30 /tmp/mdnest-e2e-multi-build.log; exit 1; }

# Seed the two namespaces on disk.
mkdir -p "$NOTES_DIR"/alpha/{Shared,Private,Team} "$NOTES_DIR"/beta/Inbox "$NOTES_DIR"/alpha/.mdnest/comments
printf 'shared\n' > "$NOTES_DIR/alpha/Shared/a.md"
printf 'private\n' > "$NOTES_DIR/alpha/Private/p.md"
printf 'team\n\n<!-- mdnest:aaaaaaaa-1111-4111-8111-111111111111 -->\n' > "$NOTES_DIR/alpha/Team/t.md"
printf '{"id":"c1","text":"hi"}\n' > "$NOTES_DIR/alpha/.mdnest/comments/aaaaaaaa-1111-4111-8111-111111111111.jsonl"
printf 'x\n' > "$NOTES_DIR/beta/Inbox/keep.md"
chmod -R a+rwX "$NOTES_DIR"

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=mdnest -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mdnest postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U mdnest >/dev/null 2>&1 && break; sleep 1; done

docker run -d --name "$BE" --network "$NET" \
  -e AUTH_MODE=multi -e POSTGRES_HOST="$PG" -e POSTGRES_PASSWORD=pw \
  -e MDNEST_USER=admin -e MDNEST_PASSWORD=adminpass123 -e MDNEST_JWT_SECRET=e2e-multi-secret \
  -e NOTES_DIR=/notes -e FRONTEND_ORIGIN=http://localhost \
  -v "$NOTES_DIR:/notes" -p 127.0.0.1:0:8080 "$IMAGE" >/dev/null
PORT="$(docker port "$BE" 8080/tcp | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 40); do curl -fsS "$BASE/api/config" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$BASE/api/config" >/dev/null 2>&1 || { fail "backend never became healthy"; docker logs "$BE" | tail -30; exit 1; }
pass "multi-mode backend up at $BASE"

BASE="$BASE" NOTES="$NOTES_DIR" python3 - <<'PY'
import json, os, sys, io, zipfile, urllib.request, urllib.error

BASE, NOTES = os.environ["BASE"], os.environ["NOTES"]
passed = failed = 0

def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print(f"  \033[32mPASS\033[0m {name}")
    else:
        failed += 1; print(f"  \033[31mFAIL\033[0m {name}  {extra}")

def call(method, path, token=None, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read(); code = r.status
    except urllib.error.HTTPError as e:
        b = e.read(); code = e.code
    if raw:
        return code, b
    try:
        return code, json.loads(b or b"null")
    except ValueError:
        return code, b.decode(errors="replace")

def login(user, pw):
    code, r = call("POST", "/api/auth/login", body={"username": user, "password": pw})
    if isinstance(r, dict) and r.get("status") == "change_password_required":
        code, r = call("POST", "/api/auth/change-password-forced", body={"tempToken": r["tempToken"], "newPassword": pw + "X"})
    assert isinstance(r, dict) and r.get("token"), f"login {user}: {code} {r}"
    return r["token"]

def disk(rel):
    return os.path.exists(os.path.join(NOTES, rel))

def xfer(token, mode, fns, fp, tns, tp, dry=False):
    return call("POST", "/api/transfer" + ("?dryRun=1" if dry else ""), token,
                {"mode": mode, "from": {"ns": fns, "path": fp}, "to": {"ns": tns, "path": tp}})

admin = login("admin", "adminpass123")
users = {}
for name in ("carol", "dave"):
    code, r = call("POST", "/api/admin/invite", admin, {"email": f"{name}@e2e.local", "username": name, "password": name + "pass123", "role": "collaborator"})
    assert code in (200, 201), f"invite {name}: {code} {r}"
    users[name] = r.get("id") or r.get("user", {}).get("id")
code, all_users = call("GET", "/api/admin/users", admin)
ids = {u["username"]: u["id"] for u in (all_users if isinstance(all_users, list) else all_users.get("users", []))}

for ns, path, perm in (("alpha", "/Shared", "read"), ("beta", "/Inbox", "write")):
    code, r = call("POST", "/api/admin/grants", admin, {"user_id": ids["carol"], "namespace": ns, "path": path, "permission": perm})
    assert code in (200, 201), f"grant: {code} {r}"
code, g = call("POST", "/api/admin/groups", admin, {"name": "eng", "description": "e2e"})
assert code in (200, 201), f"group: {code} {g}"
call("POST", "/api/admin/groups/members", admin, {"group_id": g["id"], "user_id": ids["dave"]})
for ns, path, perm in (("alpha", "/Team", "write"), ("beta", "/", "read")):
    code, r = call("POST", "/api/admin/groups/grants", admin, {"group_id": g["id"], "namespace": ns, "path": path, "permission": perm})
    assert code in (200, 201), f"group grant: {code} {r}"

carol = login("carol", "carolpass123")
dave = login("dave", "davepass123")
code, tok = call("POST", "/api/auth/tokens", carol, {"name": "e2e"})
carol_token = tok["token"] if isinstance(tok, dict) else None

print("── carol: read alpha:/Shared, write beta:/Inbox (direct grants)")
code, r = xfer(carol, "copy", "alpha", "Private/p.md", "beta", "Inbox/p.md", dry=True)
check("dry run: copy from an unreadable path is 403", code == 403, f"{code} {r}")
code, r = xfer(carol, "copy", "alpha", "Private/p.md", "beta", "Inbox/p.md")
check("copy from an unreadable path is 403, nothing written", code == 403 and not disk("beta/Inbox/p.md"), f"{code} {r}")
code, r = xfer(carol, "copy", "alpha", "Shared/../Private/p.md", "beta", "Inbox/p.md")
check("a traversal out of the readable path is 403", code == 403 and not disk("beta/Inbox/p.md"), f"{code} {r}")
code, r = xfer(carol, "copy", "alpha", "Shared/a.md", "beta", "Elsewhere/a.md")
check("copy to an unwritable path is 403", code == 403 and not disk("beta/Elsewhere"), f"{code} {r}")
code, r = xfer(carol, "move", "alpha", "Shared/a.md", "beta", "Inbox/a.md")
check("move needs write on the source: 403, source kept", code == 403 and disk("alpha/Shared/a.md") and not disk("beta/Inbox/a.md"), f"{code} {r}")
code, r = xfer(carol, "copy", "alpha", "Shared/a.md", "beta", "Inbox/a.md", dry=True)
check("dry run of a permitted copy is 200 and writes nothing", code == 200 and not disk("beta/Inbox/a.md"), f"{code} {r}")
code, r = xfer(carol, "copy", "alpha", "Shared/a.md", "beta", "Inbox/a.md")
check("permitted copy is 200 and lands", code == 200 and disk("beta/Inbox/a.md") and disk("alpha/Shared/a.md"), f"{code} {r}")
code, r = xfer(carol, "copy", "alpha", "Shared/a.md", "beta", "Inbox/keep.md")
check("collision is 409 naming the path", code == 409 and r.get("path") == "Inbox/keep.md", f"{code} {r}")
if carol_token:
    code, r = xfer(carol_token, "copy", "alpha", "Private/p.md", "beta", "Inbox/p2.md")
    check("an API token gets carol's access, no more (403)", code == 403, f"{code} {r}")
    code, r = xfer(carol_token, "copy", "alpha", "Shared/a.md", "beta", "Inbox/a-token.md")
    check("an API token gets carol's access (200)", code == 200 and disk("beta/Inbox/a-token.md"), f"{code} {r}")

code, body = call("GET", "/api/download?ns=alpha&path=Shared", carol, raw=True)
names = sorted(zipfile.ZipFile(io.BytesIO(body)).namelist()) if code == 200 else []
check("download of the readable folder is a zip", code == 200 and names == ["Shared/", "Shared/a.md"], f"{code} {names}")
for p in ("path=Private", "path=Shared/../Private", "path=Private/p.md"):
    code, _ = call("GET", f"/api/download?ns=alpha&{p}", carol, raw=True)
    check(f"download {p} is 403", code == 403, str(code))
code, _ = call("GET", "/api/download?ns=alpha", carol, raw=True)
check("download of the namespace root is 403 for a path-scoped grant", code == 403, str(code))

code, plain = call("GET", "/api/namespaces", carol)
code2, detail = call("GET", "/api/namespaces?detail=1", carol)
check("plain /api/namespaces is unchanged (a list of names)", plain == ["alpha", "beta"], str(plain))
check("?detail=1 reports no root write for path-scoped grants",
      detail == [{"name": "alpha", "canRead": False, "canWrite": False}, {"name": "beta", "canRead": False, "canWrite": False}], str(detail))

print("── dave: group 'eng' writes alpha:/Team, reads beta:/")
code, r = xfer(dave, "move", "alpha", "Team/t.md", "beta", "t.md")
check("move into a read-only namespace is 403, source kept", code == 403 and disk("alpha/Team/t.md"), f"{code} {r}")
code, r = xfer(dave, "copy", "beta", "Inbox/a.md", "alpha", "Team/a.md")
check("group grant: copy beta -> alpha:/Team is 200", code == 200 and disk("alpha/Team/a.md"), f"{code} {r}")
code, r = xfer(dave, "move", "alpha", "Team/t.md", "alpha", "Team/Done/t.md")
check("group grant: move inside /Team is 200", code == 200 and disk("alpha/Team/Done/t.md") and not disk("alpha/Team/t.md"), f"{code} {r}")
code, detail = call("GET", "/api/namespaces?detail=1", dave)
check("?detail=1 for a group member: beta readable at root, not writable",
      {"name": "beta", "canRead": True, "canWrite": False} in (detail or []), str(detail))

print("── admin (superadmin): no implicit data access")
code, r = xfer(admin, "copy", "alpha", "Shared/a.md", "beta", "Inbox/admin.md")
check("a superadmin without grants gets 403", code == 403 and not disk("beta/Inbox/admin.md"), f"{code} {r}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
PY
rc=$?
[ $rc -eq 0 ] && pass "multi-mode transfer/download: all checks passed" || { fail "multi-mode checks failed"; docker logs "$BE" 2>&1 | tail -20; }
exit $rc
