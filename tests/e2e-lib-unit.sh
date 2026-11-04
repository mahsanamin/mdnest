#!/usr/bin/env bash
# Pure checks of tests/lib/e2e-images.sh, no Docker. The image cache is only
# safe if the tree hash changes whenever the image content would: a hash that
# missed an untracked or uncommitted file would hand a suite an image built
# from different code, and every e2e run after it would test the wrong thing
# while passing. The shard runner must fail when any one shard fails.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tests/lib/e2e-images.sh
. "$REPO_ROOT/tests/lib/e2e-images.sh"

pass=0; failed=0
ok()  { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; failed=$((failed + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
differ() { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1 (both '$2')"; fi; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

echo "tree hash"
( cd "$T" && git init -q . && mkdir backend other && echo a >backend/a.go && echo x >other/x \
  && git add . && git -c user.name=t -c user.email=t@t commit -qm init ) || { echo "git setup failed"; exit 1; }
h1="$(e2e_tree_hash "$T" backend)"
h2="$(e2e_tree_hash "$T" backend)"
check "the same tree hashes the same" "$h1" "$h2"
[ -n "$h1" ] && ok "a git checkout gives a hash" || bad "a git checkout gives a hash"
echo b >"$T/backend/a.go"
h3="$(e2e_tree_hash "$T" backend)"
differ "an uncommitted edit changes the hash" "$h1" "$h3"
git -C "$T" checkout -q backend/a.go
echo n >"$T/backend/new.go"
h4="$(e2e_tree_hash "$T" backend)"
differ "an untracked file changes the hash" "$h1" "$h4"
check "the real index is left alone" "$(git -C "$T" status --porcelain)" "?? backend/new.go"
rm "$T/backend/new.go"
echo y >"$T/other/x"
check "a file outside the paths does not change the hash" "$(e2e_tree_hash "$T" backend)" "$h1"
differ "two paths hash differently from one" "$(e2e_tree_hash "$T" backend other)" "$h1"
check "not a git checkout gives no hash" "$(e2e_tree_hash "$T/nowhere" backend)" ""

echo "shards"
check "MDNEST_E2E_SHARDS wins" "$(MDNEST_E2E_SHARDS=2 e2e_shards)" "2"
check "a non-number means one shard" "$(MDNEST_E2E_SHARDS=x e2e_shards)" "1"
check "zero means one shard" "$(MDNEST_E2E_SHARDS=0 e2e_shards)" "1"
n="$(MDNEST_E2E_SHARDS='' e2e_shards)"
[ "$n" -ge 1 ] && [ "$n" -le 3 ] && ok "the default is between 1 and 3 ($n)" || bad "the default is between 1 and 3 ($n)"
check "one shard adds no playwright arguments" "$(e2e_shard_args 0 1)" ""
check "shard 2 of 3" "$(e2e_shard_args 1 3)" "--shard=2/3 --output=../browser-results/shard-2"
check "no more shards than spec files" "$(e2e_cap_shards 3 a.spec.js b.spec.js)" "2"
check "the whole suite keeps the count" "$(e2e_cap_shards 3)" "3"

echo "shard runner"
L="$T/logs"; mkdir -p "$L"
all_pass() { echo "ran $1"; }
one_fails() { echo "ran $1"; [ "$1" != 1 ]; }
e2e_run_shards 3 "$L" all_pass >"$T/out" && ok "every shard passing passes" || bad "every shard passing passes"
grep -q "ran 2" "$T/out" && ok "every shard's log is printed" || bad "every shard's log is printed"
e2e_run_shards 3 "$L" one_fails >"$T/out" && bad "one failing shard fails the run" || ok "one failing shard fails the run"
grep -q "shard 2 of 3 FAILED" "$T/out" && ok "the failing shard is named" || bad "the failing shard is named"

echo "notes sweep"
N="$T/notes"; mkdir -p "$N"
dead=999999; while kill -0 "$dead" 2>/dev/null; do dead=$((dead - 1)); done
mkdir -p "$N/.e2e-notes.$$.live1" "$N/.e2e-notes.$$.live1.cli" "$N/.e2e-notes.$dead.gone1" \
  "$N/.e2e-notes.$dead.gone1.cli" "$N/.e2e-notes.fresh1" "$N/.e2e-notes.old1"
# -t is POSIX (GNU and BSD touch); -d '2 days ago' is GNU only and fails on macOS.
touch -t 202001010000 "$N/.e2e-notes.old1"
e2e_sweep_notes "$N"
[ -d "$N/.e2e-notes.$$.live1" ] && [ -d "$N/.e2e-notes.$$.live1.cli" ] \
  && ok "a running run's folders are kept" || bad "a running run's folders are kept"
[ ! -e "$N/.e2e-notes.$dead.gone1" ] && [ ! -e "$N/.e2e-notes.$dead.gone1.cli" ] \
  && ok "a dead run's folders are swept" || bad "a dead run's folders are swept"
[ -d "$N/.e2e-notes.fresh1" ] && ok "a recent old-style folder is kept" || bad "a recent old-style folder is kept"
[ ! -e "$N/.e2e-notes.old1" ] && ok "an old-style folder over 12 hours old is swept" || bad "an old-style folder over 12 hours old is swept"
d="$(e2e_notes_dir "$N")"
case "${d##*/}" in .e2e-notes.$$.*) ok "a new folder carries this run's pid" ;; *) bad "a new folder carries this run's pid ($d)" ;; esac

echo
echo "e2e-lib-unit: $pass passed, $failed failed"
[ "$failed" -eq 0 ]
