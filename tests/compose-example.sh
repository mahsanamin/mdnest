#!/usr/bin/env bash
#
# Plain-compose install test (deploy/compose/docker-compose.yml) — no network
# ────────────────────────────────────────────────────────────────────────────
# The plain-compose file is copied by people who never clone the repo and
# never run setup.sh (issue #112), so nothing else exercises it. It breaks
# quietly in ways a user only finds after following the instructions:
#
#   - a commented-out knob the backend no longer reads (it doesn't fail, it
#     lies: uncommenting it does nothing);
#   - the backend service renamed, so nginx's proxy_pass to "backend" hits
#     nothing and every API call 502s;
#   - backend and frontend on different image tags;
#   - the file swallowed by .gitignore (docker-compose.yml is ignored at the
#     repo root, and an unanchored rule matched this one too);
#   - the release publishing amd64 only, so `docker compose up` fails with
#     "no matching manifest" on Apple silicon, a Pi or an ARM VPS;
#   - the one-liner in the docs downloading a path that doesn't exist.
#
# If `docker compose` is available it also checks that a missing secret
# stops the file with a message naming the variable, and that the file
# validates once the secrets are set. Without Docker those two are skipped.
#
# Usage:  tests/compose-example.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REL=deploy/compose/docker-compose.yml
FILE="$REPO_ROOT/$REL"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()   { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }
skip() { printf '  SKIP %s\n' "$1"; }

echo "Plain-compose install file ($REL)"

if [ ! -f "$FILE" ]; then
  bad "file exists" "missing: $REL"
  echo; echo "$PASS passed, $FAIL failed"; exit 1
fi
ok "file exists"

if git -C "$REPO_ROOT" check-ignore -q "$REL"; then
  bad "file is not gitignored" "$(git -C "$REPO_ROOT" check-ignore -v "$REL")"
else
  ok "file is not gitignored"
fi

# Every setting the file offers, live or commented, must be one the backend
# reads. Keys look like "KEY: value" or "# KEY: value" at any indent.
missing=""
for key in $(grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]+:' "$FILE" \
             | sed -E 's/[#[:space:]:]//g' | sort -u); do
  if ! grep -rqF "\"$key\"" "$REPO_ROOT/backend" --include='*.go'; then
    missing="$missing $key"
  fi
done
if [ -z "$missing" ]; then
  ok "every setting in the file is read by the backend"
else
  bad "every setting in the file is read by the backend" "not read anywhere in backend/:$missing"
fi

# nginx proxies /api/ to a fixed host name; that name must be a service here.
proxy_host=$(grep -oE 'proxy_pass http://[a-z0-9_-]+' "$REPO_ROOT/frontend/nginx.conf" \
             | head -1 | sed 's#.*//##')
if [ -n "$proxy_host" ] && grep -qE "^  ${proxy_host}:\$" "$FILE"; then
  ok "nginx's proxy target '$proxy_host' is a service in the file"
else
  bad "nginx's proxy target is a service in the file" "proxy_pass host '$proxy_host' has no matching service"
fi

be_tag=$(grep -oE 'image: ghcr\.io/[^/]+/mdnest-backend:[^[:space:]]+'  "$FILE" | sed 's/.*://')
fe_tag=$(grep -oE 'image: ghcr\.io/[^/]+/mdnest-frontend:[^[:space:]]+' "$FILE" | sed 's/.*://')
if [ -n "$be_tag" ] && [ "$be_tag" = "$fe_tag" ]; then
  ok "backend and frontend use the same published tag ($be_tag)"
else
  bad "backend and frontend use the same published tag" "backend='$be_tag' frontend='$fe_tag'"
fi

if grep -qE '^[[:space:]]+- mdnest-secrets:/data/secrets' "$FILE" \
   && grep -qE '^  mdnest-secrets:' "$FILE"; then
  ok "secrets volume is mounted and declared"
else
  bad "secrets volume is mounted and declared" "tokens/preferences/stickies would be lost on every recreate"
fi

if grep -qE 'platforms:.*linux/arm64' "$REPO_ROOT/.github/workflows/release.yml"; then
  ok "release publishes arm64 images"
else
  bad "release publishes arm64 images" "release.yml builds no linux/arm64; the file fails on ARM hosts"
fi

for doc in README.md docs/setup.md; do
  if grep -qF "mdnest/main/$REL" "$REPO_ROOT/$doc"; then
    ok "$doc downloads $REL"
  else
    bad "$doc downloads $REL" "the documented curl one-liner points somewhere else"
  fi
done

if docker compose version >/dev/null 2>&1; then
  sandbox="$(mktemp -d)"
  cp "$FILE" "$sandbox/docker-compose.yml"
  out=$(cd "$sandbox" && docker compose config -q 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q MDNEST_PASSWORD \
     && printf '%s' "$out" | grep -q MDNEST_JWT_SECRET; then
    ok "refuses to start without secrets, naming both"
  else
    bad "refuses to start without secrets, naming both" "rc=$rc: $out"
  fi
  printf 'MDNEST_PASSWORD=p\nMDNEST_JWT_SECRET=s\n' > "$sandbox/.env"
  out=$(cd "$sandbox" && docker compose config -q 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    ok "validates once the secrets are set"
  else
    bad "validates once the secrets are set" "$out"
  fi
  rm -rf "$sandbox"
else
  skip "docker compose not available: secret-refusal and validation checks"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
