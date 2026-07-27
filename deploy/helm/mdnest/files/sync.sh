#!/bin/sh

SYNC_INTERVAL="${GIT_SYNC_INTERVAL:-600}"
KEYS_DIR="/keys"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts -o LogLevel=QUIET"

# Trust all mounted directories
git config --global safe.directory '*'

echo "git-sync: starting sync loop (every ${SYNC_INTERVAL}s)"

# Squash into HEAD if HEAD is an unpushed sync commit. Only collapses the
# topmost commit — earlier commits in the unpushed range are unchanged.
commit_changes() {
  name="$1"
  TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')

  git add -A

  if git diff --cached --quiet; then
    echo "git-sync [$name]: nothing to commit at ${TIMESTAMP}"
    return
  fi

  REMOTE_BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)
  if [ -n "$REMOTE_BRANCH" ]; then
    LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
    AHEAD=$(git rev-list --count "$REMOTE_BRANCH"..HEAD 2>/dev/null || echo "0")

    if [ "$AHEAD" -gt 0 ] && echo "$LAST_MSG" | grep -q "^sync: "; then
      git commit --amend -m "sync: ${TIMESTAMP}"
      echo "git-sync [$name]: squashed into existing sync commit at ${TIMESTAMP}"
      return
    fi
  fi

  git commit -m "sync: ${TIMESTAMP}"
  echo "git-sync [$name]: committed at ${TIMESTAMP}"
}

resolve_conflicts() {
  name="$1"
  TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
  CONFLICT_TAG=$(date -u '+%Y%m%d-%H%M%S')

  echo "git-sync [$name]: conflict detected, saving both versions..."

  git diff --name-only --diff-filter=U | while IFS= read -r file; do
    if [ -f "$file" ]; then
      CONFLICT_COPY="${file}.sync-conflict-${CONFLICT_TAG}"
      if ! git show :2:"$file" > "$CONFLICT_COPY" 2>/dev/null; then
        echo "git-sync [$name]: WARNING — could not extract local version of $file, saving working tree copy (may contain conflict markers)"
        cp "$file" "$CONFLICT_COPY"
      fi
      echo "git-sync [$name]: saved local version as $CONFLICT_COPY"
      git checkout --theirs "$file"
    fi
  done

  git add -A
  git commit -m "sync: resolved conflict at ${TIMESTAMP} (local copies saved as .sync-conflict)"
  echo "git-sync [$name]: conflict resolved — local versions saved as .sync-conflict files"
}

pull_remote() {
  name="$1"

  # Skip if no remote configured
  if ! git remote | grep -q .; then
    echo "git-sync [$name]: no remote configured, skipping pull/push"
    return 1
  fi

  # Fresh repo — no upstream branch yet, skip pull (first push will create it)
  UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)
  if [ -z "$UPSTREAM" ]; then
    echo "git-sync [$name]: no upstream branch yet, will push to create it"
    return 0
  fi

  # Refresh remote refs so HEAD..@{u} is accurate.
  if ! git fetch --quiet origin 2>/dev/null; then
    echo "git-sync [$name]: fetch failed, will retry next cycle"
    return 1
  fi

  BEHIND=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0)
  if [ "$BEHIND" = "0" ]; then
    return 0   # nothing remote to integrate (may still be ahead → push)
  fi

  # A live-collab autosave can re-dirty the working tree right after
  # commit_changes ran, which makes `git merge` refuse to start ("would be
  # overwritten"). Stash those changes (tracked + untracked) so the merge
  # always proceeds, then re-apply them on top of the merged result.
  STASHED=0
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    if git stash push -u -m "git-sync-autostash" >/dev/null 2>&1; then
      STASHED=1
    fi
  fi

  # Merge-only (no rebase): integrate the remote. Capture stderr so a failure
  # to *start* the merge is distinguishable from a real content conflict.
  MERGE_ERR=$(git merge --no-edit "@{u}" 2>&1)
  MERGE_RC=$?
  if [ "$MERGE_RC" != "0" ]; then
    if [ -f .git/MERGE_HEAD ] || [ -n "$(git ls-files -u 2>/dev/null)" ]; then
      # A genuine merge with content conflicts — keep remote, save local copies.
      resolve_conflicts "$name"
    else
      # The merge never started (e.g. still-dirty tree). Don't fabricate a
      # "resolved" commit — log the real reason, restore a clean state, bail.
      echo "git-sync [$name]: merge could not start: $(echo "$MERGE_ERR" | head -1)"
      git merge --abort 2>/dev/null
      [ "$STASHED" = "1" ] && git stash pop >/dev/null 2>&1
      return 1
    fi
  fi

  # Re-apply the stashed live-collab edits.
  if [ "$STASHED" = "1" ]; then
    if ! git stash pop >/dev/null 2>&1; then
      # The local edit collides with the freshly-merged remote. Keep the merged
      # (remote) version, save the local edit as a recoverable patch, drop stash.
      TAG=$(date -u '+%Y%m%d-%H%M%S')
      git stash show -p stash@{0} > ".mdnest-sync-autostash-${TAG}.patch" 2>/dev/null
      git checkout -- . 2>/dev/null
      git reset --hard HEAD >/dev/null 2>&1
      git stash drop >/dev/null 2>&1
      echo "git-sync [$name]: live edit conflicted with remote — kept remote, saved local as .mdnest-sync-autostash-${TAG}.patch"
    fi
  fi
  return 0
}

# Fix SSH host aliases in remote URLs. Users often configure git on the host
# with aliases like "gh-myrepo" in ~/.ssh/config, but the container doesn't
# have that config. Detect and rewrite to git@github.com:user/repo.git.
fix_remote_url() {
  name="$1"
  REMOTE_URL=$(git remote get-url origin 2>/dev/null)
  [ -z "$REMOTE_URL" ] && return

  # Skip HTTPS URLs — no SSH alias issue
  case "$REMOTE_URL" in http://*|https://*) return ;; esac

  # Extract host from either "git@host:path" or "host:path" format
  REMOTE_HOST=$(echo "$REMOTE_URL" | sed 's/^.*@//' | sed 's/:.*//')
  [ -z "$REMOTE_HOST" ] && return

  # Known git hosts — no fix needed
  case "$REMOTE_HOST" in
    github.com|gitlab.com|bitbucket.org) return ;;
  esac

  # Unknown host (likely an SSH alias) — rewrite to git@github.com:user/repo.git
  REPO_PATH=$(echo "$REMOTE_URL" | sed 's/^[^:]*://')
  NEW_URL="git@github.com:${REPO_PATH}"
  git remote set-url origin "$NEW_URL"
  echo "git-sync [$name]: rewrote remote URL from '$REMOTE_URL' to '$NEW_URL'"
  echo "git-sync [$name]: (SSH host alias '$REMOTE_HOST' doesn't work inside Docker)"
}

# Per-namespace daemon health, written to a git-excluded file the backend can
# read (so the UI can surface "sync broken"). state = ok | error.
write_status() {
  name="$1"; state="$2"; msg="$3"
  ahead=$(git rev-list --count "@{u}"..HEAD 2>/dev/null || echo 0)
  behind=$(git rev-list --count HEAD.."@{u}" 2>/dev/null || echo 0)
  esc=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  # Field names match backend/handlers/sync.go daemonSyncStatus (state, ahead,
  # behind, message, updated) so /api/admin/sync-status can overlay it.
  printf '{"namespace":"%s","state":"%s","ahead":%s,"behind":%s,"message":"%s","updated":"%s"}\n' \
    "$name" "$state" "$ahead" "$behind" "$esc" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    > .mdnest-sync-status.json 2>/dev/null
}

# Keep sync bookkeeping files out of git so `git add -A` never commits/pushes
# them. Local-only (.git/info/exclude), idempotent.
ensure_excludes() {
  EX=.git/info/exclude
  [ -d .git ] || return
  for pat in ".mdnest-sync-status.json" ".mdnest-sync-autostash-*.patch" "*.sync-conflict-*"; do
    grep -qxF "$pat" "$EX" 2>/dev/null || echo "$pat" >> "$EX"
  done
}

sync_repo() {
  dir="$1"
  name="$(basename "$dir")"

  cd "$dir" || { echo "git-sync [$name]: cannot cd to $dir, skipping"; return; }

  # Clear SSH command from previous iteration
  unset GIT_SSH_COMMAND

  ensure_excludes

  # Configure git identity per-repo
  git config user.name  "${GIT_AUTHOR_NAME:-mdnest}"
  git config user.email "${GIT_AUTHOR_EMAIL:-mdnest@localhost}"

  # Commit local changes (squash if previous sync commit is unpushed)
  commit_changes "$name"

  # Resolve SSH key: per-namespace key > default key > SSH_KEY_PATH mount > skip
  if [ -f "$KEYS_DIR/$name" ]; then
    export GIT_SSH_COMMAND="ssh -i '$KEYS_DIR/$name' $SSH_OPTS"
  elif [ -f "$KEYS_DIR/default" ]; then
    export GIT_SSH_COMMAND="ssh -i '$KEYS_DIR/default' $SSH_OPTS"
  elif [ -f "/ssh-key" ]; then
    export GIT_SSH_COMMAND="ssh -i '/ssh-key' $SSH_OPTS"
  else
    echo "git-sync [$name]: no SSH key found — committed locally, skipping push/pull"
    echo "git-sync [$name]: set SSH_KEY_PATH in mdnest.conf or add keys to git-sync/keys/"
    return
  fi

  # Fix SSH host aliases before pull/push
  fix_remote_url "$name"

  if pull_remote "$name"; then
    # Only push when HEAD actually contains the remote (fast-forward), so we
    # never spin on non-fast-forward rejections. After a successful merge this
    # holds; if it doesn't, the pull didn't converge — report and skip.
    if [ -z "$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)" ] \
       || git merge-base --is-ancestor "@{u}" HEAD 2>/dev/null; then
      if git push 2>/dev/null || git push --set-upstream origin "$(git branch --show-current)" 2>/dev/null; then
        write_status "$name" ok ""
      else
        write_status "$name" error "push rejected"
        echo "git-sync [$name]: push failed, will retry next cycle"
      fi
    else
      write_status "$name" error "diverged from upstream (not fast-forward) — sync did not converge"
      echo "git-sync [$name]: HEAD is not a descendant of upstream after pull; skipping push to avoid a non-fast-forward loop"
    fi
  else
    write_status "$name" error "pull/merge failed"
  fi
}

while true; do
  for dir in /data/notes/*/; do
    [ -d "$dir/.git" ] && sync_repo "$dir"
  done

  sleep "${SYNC_INTERVAL}"
done
