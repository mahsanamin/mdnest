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

  # Try rebase first (clean linear history)
  if git pull --rebase 2>/dev/null; then
    return 0
  fi

  # Rebase failed — abort and try merge
  git rebase --abort 2>/dev/null

  echo "git-sync [$name]: rebase failed, trying merge..."

  if git pull --no-rebase 2>/dev/null; then
    return 0
  fi

  # Merge has conflicts — resolve them
  resolve_conflicts "$name"
  return 0
}

sync_repo() {
  dir="$1"
  name="$(basename "$dir")"

  cd "$dir" || { echo "git-sync [$name]: cannot cd to $dir, skipping"; return; }

  # Clear SSH command from previous iteration
  unset GIT_SSH_COMMAND

  # Configure git identity per-repo
  git config user.name  "${GIT_AUTHOR_NAME:-mdnest}"
  git config user.email "${GIT_AUTHOR_EMAIL:-mdnest@localhost}"

  # Commit local changes (squash if previous sync commit is unpushed)
  commit_changes "$name"

  # Resolve SSH key: per-namespace key > default key > skip remote sync
  if [ -f "$KEYS_DIR/$name" ]; then
    export GIT_SSH_COMMAND="ssh -i '$KEYS_DIR/$name' $SSH_OPTS"
  elif [ -f "$KEYS_DIR/default" ]; then
    export GIT_SSH_COMMAND="ssh -i '$KEYS_DIR/default' $SSH_OPTS"
  else
    echo "git-sync [$name]: no SSH key found (tried keys/$name, keys/default) — committed locally, skipping push/pull"
    return
  fi

  if pull_remote "$name"; then
    git push || echo "git-sync [$name]: push failed, will retry next cycle"
  fi
}

while true; do
  for dir in /data/notes/*/; do
    [ -d "$dir/.git" ] && sync_repo "$dir"
  done

  sleep "${SYNC_INTERVAL}"
done
