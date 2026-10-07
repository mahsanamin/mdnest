#!/usr/bin/env bash
#
# Private chats against a real Postgres (issue #127)
# ───────────────────────────────────────────────────
# routes_chat_members_test.go pins every route against an in-memory member
# store. This runs the real one: the chat_members migration, the folder-prefix
# SQL a move and a copy use, the row lock that keeps a chat from losing its
# last member, and what happens to a chat when its only member's account is
# deleted. Postgres, the backend built from the working tree, real users.
#
# Usage:  tests/e2e-private-chats-multi.sh
# Needs:  docker, curl, python3. Exit 0 if every check passes.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

IMAGE="mdnest-e2e-backend:test"
SFX="$$"
NET="mdnest-e2e-chat-net-$SFX"
PG="mdnest-e2e-chat-pg-$SFX"
BE="mdnest-e2e-chat-be-$SFX"
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
docker build -t "$IMAGE" backend/ >/tmp/mdnest-e2e-chat-build.log 2>&1 || { fail "build failed"; tail -30 /tmp/mdnest-e2e-chat-build.log; exit 1; }

# Seed: one namespace with a chat folder, one empty one to copy into.
mkdir -p "$NOTES_DIR"/alpha/Chats/Deep "$NOTES_DIR"/beta
printf -- '---\nmdnest-chat: true\ntitle: Room\n---\n' > "$NOTES_DIR/alpha/Chats/room.md"
printf -- '---\nmdnest-chat: true\ntitle: Deep\n---\n' > "$NOTES_DIR/alpha/Chats/Deep/inner.md"
printf -- '---\nmdnest-chat: true\ntitle: Other\n---\n' > "$NOTES_DIR/alpha/Chats_x.md"
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
import json, os, sys, threading, urllib.request, urllib.error

BASE, NOTES = os.environ["BASE"], os.environ["NOTES"]
passed = failed = 0

def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print(f"  \033[32mPASS\033[0m {name}")
    else:
        failed += 1; print(f"  \033[31mFAIL\033[0m {name}  {extra}")

def call(method, path, token=None, body=None, text=None):
    data, ctype = None, None
    if body is not None:
        data, ctype = json.dumps(body).encode(), "application/json"
    elif text is not None:
        data, ctype = text.encode(), "text/plain"
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            b = r.read(); code = r.status
    except urllib.error.HTTPError as e:
        b = e.read(); code = e.code
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

admin = login("admin", "adminpass123")
for name in ("owen", "mia", "nate"):
    code, r = call("POST", "/api/admin/invite", admin, {"email": f"{name}@e2e.local", "username": name, "password": name + "pass123", "role": "collaborator"})
    assert code in (200, 201), f"invite {name}: {code} {r}"
code, all_users = call("GET", "/api/admin/users", admin)
ids = {u["username"]: u["id"] for u in (all_users if isinstance(all_users, list) else all_users.get("users", []))}
for name in ("owen", "mia", "nate"):
    for ns in ("alpha", "beta"):
        code, r = call("POST", "/api/admin/grants", admin, {"user_id": ids[name], "namespace": ns, "path": "/", "permission": "write"})
        assert code in (200, 201), f"grant: {code} {r}"
owen, mia, nate = login("owen", "owenpass123"), login("mia", "miapass123"), login("nate", "natepass123")

def members(tok, ns, path):
    return call("GET", f"/api/chat/members?ns={ns}&path={path}", tok)

def can_read(tok, ns, path):
    return call("GET", f"/api/note?ns={ns}&path={path}", tok)[0] == 200

print("── making chats private, inviting, removing")
code, r = call("POST", "/api/chat/members?ns=alpha&path=Chats/room.md", owen, {"userId": ids["mia"]})
check("owen makes room.md private with mia", code == 200 and {m["username"] for m in r["members"]} == {"owen", "mia"}, f"{code} {r}")
check("nate (write on the whole namespace) is refused", not can_read(nate, "alpha", "Chats/room.md"))
code, r = call("GET", "/api/chats", nate)
check("nate's chat list leaves it out", code == 200 and all(c["path"] != "Chats/room.md" for c in r["chats"]), str(r))
call("POST", "/api/chat/members?ns=alpha&path=Chats/Deep/inner.md", owen)
check("a chat in a subfolder is private too", not can_read(nate, "alpha", "Chats/Deep/inner.md"))
check("a sibling whose name shares the prefix stays open", can_read(nate, "alpha", "Chats_x.md"))

code, r = call("POST", "/api/chat/members?ns=alpha&path=Chats/room.md", mia, {"userId": ids["nate"]})
check("mia invites nate and he reads the history at once", code == 200 and can_read(nate, "alpha", "Chats/room.md"), f"{code} {r}")
code, r = call("DELETE", f"/api/chat/members?ns=alpha&path=Chats/room.md&userId={ids['nate']}", owen)
check("owen removes nate and he is refused at once", code == 200 and not can_read(nate, "alpha", "Chats/room.md"), f"{code} {r}")

print("── the last member cannot be removed, even by two racing requests")
# owen and mia remove each other at the same moment: without the row lock
# both deletes see two members and both succeed, leaving nobody.
results = {}
def rm(who, tok, target):
    results[who] = call("DELETE", f"/api/chat/members?ns=alpha&path=Chats/room.md&userId={ids[target]}", tok)[0]
if True:
    t1 = threading.Thread(target=rm, args=("owen", owen, "mia"))
    t2 = threading.Thread(target=rm, args=("mia", mia, "owen"))
    t1.start(); t2.start(); t1.join(); t2.join()
code, r = members(owen, "alpha", "Chats/room.md")
if code != 200:
    code, r = members(mia, "alpha", "Chats/room.md")
left = [m["username"] for m in r.get("members", [])] if isinstance(r, dict) else []
check("exactly one member is left", len(left) == 1, f"results={results} left={left}")
check("one removal won, the other got 409 or 403", sorted(results.values()) in ([200, 403], [200, 409]), str(results))
survivor = owen if left == ["owen"] else mia
if left != ["owen"]:
    call("POST", "/api/chat/members?ns=alpha&path=Chats/room.md", mia, {"userId": ids["owen"]})
call("POST", "/api/chat/members?ns=alpha&path=Chats/room.md", owen, {"userId": ids["mia"]})

print("── membership follows moves and copies (the prefix SQL)")
code, r = call("POST", "/api/move?ns=alpha&from=Chats&to=Rooms", owen)
check("owen moves the folder", code == 200, f"{code} {r}")
check("room.md is still private after the folder move", not can_read(nate, "alpha", "Rooms/room.md") and can_read(mia, "alpha", "Rooms/room.md"))
check("Deep/inner.md is still private after the folder move", not can_read(nate, "alpha", "Rooms/Deep/inner.md"))
check("Chats_x.md was not caught by the prefix", can_read(nate, "alpha", "Chats_x.md"))
code, r = call("POST", "/api/transfer", owen, {"mode": "copy", "from": {"ns": "alpha", "path": "Rooms"}, "to": {"ns": "beta", "path": "Copied"}})
check("owen copies the folder to beta", code == 200, f"{code} {r}")
check("the copy is private to the same people", not can_read(nate, "beta", "Copied/room.md") and can_read(mia, "beta", "Copied/room.md"))
code, r = members(owen, "beta", "Copied/room.md")
check("the copy lists the same members", code == 200 and {m["username"] for m in r["members"]} == {"owen", "mia"}, str(r))
code, r = call("POST", "/api/transfer", nate, {"mode": "copy", "from": {"ns": "alpha", "path": "Rooms"}, "to": {"ns": "beta", "path": "Stolen"}})
check("nate cannot copy a folder holding a chat he is not in", code == 403 and not os.path.exists(os.path.join(NOTES, "beta/Stolen")), f"{code} {r}")
code, r = call("DELETE", "/api/note?ns=alpha&path=Rooms", nate)
check("nate cannot delete that folder", code == 403 and os.path.exists(os.path.join(NOTES, "alpha/Rooms/room.md")), f"{code} {r}")

print("── a deleted account does not open the chat")
code, r = call("POST", "/api/chat/convert?ns=alpha&path=Solo.md&private=1", mia)
check("mia creates a private chat", code == 201, f"{code} {r}")
code, r = call("DELETE", f"/api/admin/users?id={ids['mia']}", admin)
check("admin deletes mia's account", code in (200, 204), f"{code} {r}")
check("her chat is still closed to nate", not can_read(nate, "alpha", "Solo.md"))
check("and to owen", not can_read(owen, "alpha", "Solo.md"))
code, r = call("GET", "/api/chats", owen)
check("owen's list still shows room.md as private", any(c["path"] == "Rooms/room.md" and c.get("private") for c in r["chats"]), str(r))

print(f"\n{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
PY
rc=$?
[ $rc -eq 0 ] && pass "multi-mode private chats: all checks passed" || { fail "multi-mode private chat checks failed"; docker logs "$BE" 2>&1 | tail -20; }
exit $rc
