#!/bin/sh
set -e

SYNC_INTERVAL="${GIT_SYNC_INTERVAL:-600}"

# Configure git identity
git config user.name  "${GIT_AUTHOR_NAME:-mdnest}"
git config user.email "${GIT_AUTHOR_EMAIL:-mdnest@localhost}"

# Trust the mounted notes directory
git config --global safe.directory /data/notes

echo "git-sync: starting sync loop (every ${SYNC_INTERVAL}s)"

while true; do
  git add -A

  TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')

  if git diff --cached --quiet; then
    echo "git-sync: nothing to commit at ${TIMESTAMP}"
  else
    git commit -m "sync: ${TIMESTAMP}"
    echo "git-sync: committed at ${TIMESTAMP}"
  fi

  git pull --rebase || echo "git-sync: pull failed, will retry next cycle"
  git push || echo "git-sync: push failed, will retry next cycle"

  sleep "${SYNC_INTERVAL}"
done
