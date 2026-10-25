# shellcheck shell=bash
# Shared by the tests/e2e-*.sh harnesses and tests/release-gate.sh. Source it,
# then call the functions; it sets no options of its own.
#
# Images are tagged by a hash of what goes into them, and built only when that
# tag does not exist yet. So:
#   - the release gate and every suite it runs share one backend build and one
#     frontend build, instead of rebuilding the same tree five times;
#   - two runs on different trees get different tags and never overwrite each
#     other's images (the old fixed ":test" tag let a second run swap the
#     image under a run already in progress);
#   - a change to the tree, committed or not, gives a new hash and a new build.
#
# The hash covers every file git would see in backend/ (or frontend/ plus the
# repo-root mdnest CLI, which the frontend image serves at /cli/mdnest),
# including uncommitted and untracked files. Files git ignores are left out;
# the .dockerignore files already keep the ones that matter (node_modules,
# dist) out of the image. MDNEST_E2E_REBUILD=1 builds anyway.

E2E_IMAGE_SCHEME=1   # bump to invalidate every cached tag

# e2e_tree_hash ROOT PATH...: a hash of PATH... under ROOT as the working tree
# has them now. Uses a throwaway index, so the real one is never touched. The
# throwaway index starts EMPTY, so git reads every file: a copy of the real
# index carries its cached file sizes and times, and git then skipped a file
# edited in the same second with the same size, which gave the old hash for
# new code (seen 1 time in 15 under load). Prints nothing when ROOT is not a
# git checkout.
e2e_tree_hash() {
  local root="$1"; shift
  ( cd "$root" 2>/dev/null || exit 1
    git rev-parse --git-dir >/dev/null 2>&1 || exit 1
    local idx; idx="$(mktemp -u "${TMPDIR:-/tmp}/mdnest-e2e-index.XXXXXX")"
    GIT_INDEX_FILE="$idx" git add -A -- "$@" >/dev/null 2>&1
    { echo "scheme $E2E_IMAGE_SCHEME"; GIT_INDEX_FILE="$idx" git ls-files -s -- "$@"; } \
      | git hash-object --stdin | cut -c1-16
    rm -f "$idx"
  )
}

# _e2e_build TAG LOG docker-build-args...: build TAG unless it exists. Two runs
# asking for the same tag at once take turns (flock where it exists), so the
# second finds the first one's image instead of building it again.
_e2e_build() {
  local tag="$1" log="$2"; shift 2
  if [ "${MDNEST_E2E_REBUILD:-0}" != 1 ] && docker image inspect "$tag" >/dev/null 2>&1; then
    echo "cached $tag" >"$log"; return 0
  fi
  local lock="${TMPDIR:-/tmp}/mdnest-e2e-build-${tag//[:\/]/_}.lock"
  (
    if command -v flock >/dev/null 2>&1; then exec 9>"$lock"; flock 9; fi
    if [ "${MDNEST_E2E_REBUILD:-0}" != 1 ] && docker image inspect "$tag" >/dev/null 2>&1; then
      echo "cached $tag (built by a parallel run)" >"$log"; exit 0
    fi
    docker build --label mdnest.e2e=1 -t "$tag" "$@" >"$log" 2>&1
  )
}

# e2e_backend_image ROOT LOGDIR: build (or reuse) the backend image for ROOT
# and print its tag. Returns non-zero, with the build log tail on stderr, if
# the build fails.
e2e_backend_image() {
  local root="$1" logdir="$2" h tag
  h="$(e2e_tree_hash "$root" backend)"
  tag="mdnest-e2e-backend:${h:-run-$$-$RANDOM}"
  if ! _e2e_build "$tag" "$logdir/backend-build.log" "$root/backend/"; then
    tail -30 "$logdir/backend-build.log" >&2; return 1
  fi
  echo "$tag"
}

# e2e_frontend_image ROOT LOGDIR: the same for the nginx frontend image.
e2e_frontend_image() {
  local root="$1" logdir="$2" h tag
  h="$(e2e_tree_hash "$root" frontend mdnest)"
  tag="mdnest-e2e-frontend:${h:-run-$$-$RANDOM}"
  if ! _e2e_build "$tag" "$logdir/frontend-build.log" --build-context cli="$root" "$root/frontend/"; then
    tail -30 "$logdir/frontend-build.log" >&2; return 1
  fi
  echo "$tag"
}

# e2e_prune_images: keep the newest few hash-tagged images per repository and
# remove the rest. An image a running container still uses is refused by
# docker and stays, so this cannot pull an image out from under another run.
e2e_prune_images() {
  local keep="${MDNEST_E2E_KEEP_IMAGES:-4}" repo
  for repo in mdnest-e2e-backend mdnest-e2e-frontend; do
    docker image ls "$repo" --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' 2>/dev/null \
      | sort -r | tail -n +"$((keep + 1))" | cut -f2 \
      | while read -r img; do docker image rm "$img" >/dev/null 2>&1 || true; done
  done
}

# e2e_playwright_ready LOGDIR: install the browser suite's npm packages and
# Chromium once. Serialised with flock, because two harnesses started side by
# side would otherwise both run npm install into the same node_modules.
e2e_playwright_ready() {
  local logdir="$1" dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../browser" && pwd)"
  (
    if command -v flock >/dev/null 2>&1; then exec 9>"${TMPDIR:-/tmp}/mdnest-e2e-playwright.lock"; flock 9; fi
    e2e_npm_ready "$dir" "$logdir/playwright-npm.log" || exit 1
    cd "$dir" || exit 1
    npx playwright install chromium >"$logdir/playwright-browser.log" 2>&1
  )
}

# e2e_shards: how many stacks a browser harness boots. MDNEST_E2E_SHARDS wins;
# otherwise one per 3 CPUs, at most 3, at least 1. Each shard is a whole stack
# with one Playwright worker, so no two specs ever share a server.
e2e_shards() {
  local n="${MDNEST_E2E_SHARDS:-}"
  if [ -z "$n" ]; then
    n=$(( $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 3) / 3 ))
    [ "$n" -gt 3 ] && n=3
  fi
  case "$n" in ''|*[!0-9]*) n=1 ;; esac
  [ "$n" -lt 1 ] && n=1
  echo "$n"
}

# e2e_run_shards N LOGDIR FUNC: run FUNC 0 .. FUNC N-1 at the same time, each
# with its output in LOGDIR/shard-I.log, then print every log in order. FUNC I
# runs shard I's part of the suite (see e2e_shard_args). Returns 0 only when
# every shard passed.
e2e_run_shards() {
  local n="$1" logdir="$2" fn="$3" i rc=0 t0=$SECONDS
  local -a pids=()
  for ((i = 0; i < n; i++)); do
    "$fn" "$i" >"$logdir/shard-$i.log" 2>&1 &
    pids[i]=$!
  done
  for ((i = 0; i < n; i++)); do
    if wait "${pids[$i]}"; then
      printf '  shard %d of %d passed (%ds)\n' "$((i + 1))" "$n" "$((SECONDS - t0))"
    else
      printf '  shard %d of %d FAILED (%ds)\n' "$((i + 1))" "$n" "$((SECONDS - t0))"; rc=1
    fi
  done
  for ((i = 0; i < n; i++)); do
    [ "$n" -gt 1 ] && printf '\n──── shard %d of %d ────\n' "$((i + 1))" "$n"
    cat "$logdir/shard-$i.log"
  done
  return "$rc"
}

# e2e_shard_args I N: the extra playwright arguments for shard I of N. One
# shard gets none, so MDNEST_E2E_SHARDS=1 runs exactly the old command. Each
# shard writes traces to its own folder under tests/browser-results, outside
# the spec folder Playwright walks (see playwright.config.js outputDir).
e2e_shard_args() {
  [ "$2" -gt 1 ] && printf -- '--shard=%d/%d --output=../browser-results/shard-%d\n' "$(($1 + 1))" "$2" "$(($1 + 1))"
  return 0
}

# e2e_cap_shards N SPECS...: no more shards than spec files, so no shard is
# left with nothing to run. With no SPECS (the whole suite) N is unchanged.
e2e_cap_shards() {
  local n="$1"; shift
  [ "$#" -gt 0 ] && [ "$#" -lt "$n" ] && n="$#"
  echo "$n"
}

# Timing-budget tests (tagged @budget in their title) measure how fast the app
# reacts, against a fixed number of milliseconds. They are only meaningful
# when nothing else from the run is using the CPU, so by default the shards
# skip them and one stack runs them alone once the shards are done.
# MDNEST_E2E_BUDGET:
#   after   (default) shards skip @budget, then one stack runs only @budget
#   skip    shards skip @budget, nothing runs them (the release gate does,
#           after all of its parallel work)
#   only    run only the @budget tests, on one stack
#   inline  no split at all: every test in its shard, the old behaviour
e2e_budget_mode() {
  case "${MDNEST_E2E_BUDGET:-after}" in
    after|skip|only|inline) echo "${MDNEST_E2E_BUDGET:-after}" ;;
    *) echo after ;;
  esac
}

# e2e_main_args MODE: the playwright filter for the sharded part.
e2e_main_args() {
  # No --pass-with-no-tests here: a mistyped MDNEST_E2E_SPECS must fail, not pass.
  case "$1" in after|skip) echo "--grep-invert @budget" ;; esac
  return 0
}

# e2e_quiet_args: the playwright arguments for the @budget-only part.
e2e_quiet_args() { echo "--grep @budget --pass-with-no-tests --output=../browser-results/quiet"; }

# e2e_has_budget SPECS...: true when the selected specs hold any @budget test.
# Lets MDNEST_E2E_BUDGET=only finish at once, without booting a stack, when
# there is nothing to run. It fails safe: if the listing errors, or prints no
# "Total:" line it can read, it answers true and the tests run, so a broken
# listing can never skip them silently. The listing's summary goes to stderr.
e2e_has_budget() {
  local dir out rc n
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../browser" && pwd)"
  out="$(cd "$dir" && npx playwright test --list --grep @budget --pass-with-no-tests "$@" 2>&1)"; rc=$?
  n="$(printf '%s\n' "$out" | sed -n 's/^Total: \([0-9][0-9]*\) test.*/\1/p' | tail -1)"
  if [ "$rc" -ne 0 ] || [ -z "$n" ]; then
    printf 'e2e_has_budget: listing failed (exit %s), running the @budget tests anyway:\n%s\n' "$rc" "$(printf '%s\n' "$out" | tail -5)" >&2
    return 0
  fi
  echo "e2e_has_budget: $n @budget test(s) selected" >&2
  [ "$n" -gt 0 ]
}

# e2e_npm_ready DIR LOG: make DIR's node_modules match its package-lock.json,
# running npm ci when it does not. An install can be missing (a fresh
# worktree) or stale (an existing node_modules from before a lock change, as
# after the zod 4 bump): stale means the lock file is newer than the record
# npm keeps of the last install (node_modules/.package-lock.json), or npm ls
# finds the installed tree does not satisfy package.json. npm ci then installs
# exactly what the lock says, and refuses a lock out of step with
# package.json, so a real mismatch still fails here with npm's own message.
# Returns 0 when DIR is ready.
e2e_npm_ready() {
  local dir="$1" log="$2" why=""
  if [ ! -d "$dir/node_modules" ]; then why="no node_modules"
  elif [ ! -f "$dir/node_modules/.package-lock.json" ]; then why="no record of the last install"
  elif [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then why="package-lock.json changed since the last install"
  elif ! (cd "$dir" && npm ls >/dev/null 2>&1); then why="the installed tree does not match package.json"
  fi
  [ -z "$why" ] && return 0
  echo "npm ci in $dir: $why" >&2
  (cd "$dir" && npm ci --no-audit --no-fund) >"$log" 2>&1
}

# Notes folders. Each harness bind-mounts a throwaway notes folder under the
# repo, and the backend container writes into it as root, so a plain rm -rf
# by the harness's user can fail and leave the folder behind (and a killed
# run never gets to its cleanup at all).
#
# e2e_rm_dirs DIR...: remove each DIR, through a container when rm -rf alone
# cannot (files owned by the container's root).
e2e_rm_dirs() {
  local d
  for d in "$@"; do
    [ -n "$d" ] && [ -e "$d" ] || continue
    rm -rf "$d" 2>/dev/null
    [ -e "$d" ] || continue
    docker run --rm -v "$(dirname "$d"):/p" alpine rm -rf "/p/$(basename "$d")" >/dev/null 2>&1
  done
  return 0
}

# e2e_sweep_notes ROOT: remove notes folders left by earlier runs that were
# killed. A folder carries its run's pid (.e2e-notes.<pid>.<random>), and is
# swept only when that process is gone, so a harness running side by side is
# never touched. Folders named before the pid was added (.e2e-notes.<random>)
# are swept once they are more than 12 hours old.
e2e_sweep_notes() {
  local root="$1" d name pid
  for d in "$root"/.e2e-notes.*; do
    [ -e "$d" ] || continue
    name="${d##*/.e2e-notes.}"
    pid="${name%%.*}"
    if [ "$pid" != "$name" ] && [ -n "$pid" ] && [ -z "${pid//[0-9]/}" ]; then
      kill -0 "$pid" 2>/dev/null || e2e_rm_dirs "$d"
    elif [ -n "$(find "$d" -maxdepth 0 -mmin +720 2>/dev/null)" ]; then
      e2e_rm_dirs "$d"
    fi
  done
  return 0
}

# e2e_notes_dir ROOT: sweep old leftovers, then make and print this run's
# notes folder under ROOT (inside the repo: the Docker VM may not share the
# system temp dir).
e2e_notes_dir() {
  e2e_sweep_notes "$1"
  mktemp -d "$1/.e2e-notes.$$.XXXXXX"
}
