#!/usr/bin/env bash
# Render the chart's page storage settings with Helm. Docker provides a pinned
# Helm when it is not on PATH; no host tool installation or cluster is needed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/deploy/helm/mdnest"
HELM=(helm)
if ! command -v helm >/dev/null 2>&1; then
  command -v docker >/dev/null 2>&1 || { printf 'Helm or Docker is required.\n' >&2; exit 2; }
  CHART=/chart
  HELM=(docker run --rm -v "$ROOT/deploy/helm/mdnest:/chart:ro" alpine/helm:3.17.3)
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
"${HELM[@]}" lint "$CHART"
"${HELM[@]}" template pages "$CHART" > "$WORK/off.yaml"
if grep -q 'PAGES_IN_GIT\|PAGES_DIR\|location = /api/pages/import' "$WORK/off.yaml"; then
  printf 'FAIL: pages-off chart includes pages configuration.\n' >&2; exit 1
fi
for in_git in false true; do
  "${HELM[@]}" template pages "$CHART" --set pages.enabled=true --set "pages.inGit=$in_git" > "$WORK/on.yaml"
  grep -q 'PAGES_DIR: "/data/notes/.mdnest-pages"' "$WORK/on.yaml"
  grep -q "PAGES_IN_GIT: \"$in_git\"" "$WORK/on.yaml"
  grep -q 'location = /api/pages/import' "$WORK/on.yaml"
  grep -q 'client_max_body_size 272m;' "$WORK/on.yaml"
  printf 'PASS: pages.inGit=%s keeps the private chart store and import limit.\n' "$in_git"
done
