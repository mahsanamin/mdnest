#!/usr/bin/env bash
#
# setup.sh Marp-theme-catalog durability test — no network, no Docker
# ──────────────────────────────────────────────────────────────────
# The Marp theme catalog lives at NOTES_DIR/.marp-themes. In the Compose
# install NOTES_DIR is NOT itself a volume (each MOUNT_ namespace is bind-
# mounted individually), so if the catalog isn't backed by its own declared
# volume it lands in the container's writable layer and `mdnest-server rebuild`
# (compose up --force-recreate) destroys every custom theme.
#
# This pins that the generated docker-compose.yml backs the catalog with a
# declared named volume when ENABLE_MARP_THEMES=true — and does not when the
# feature is off. Deleting the setup.sh block that emits the volume turns this
# red.
#
# Usage:  tests/setup-marp-themes.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

# Generate a docker-compose.yml from a minimal single-mode conf with the given
# extra config lines, and echo the path to the sandbox directory.
generate_compose() {
  local sandbox
  sandbox="$(mktemp -d)"
  cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sandbox"/
  {
    printf 'MOUNT_test=%s/notes\n' "$sandbox"
    printf '%s\n' "$@"
  } > "$sandbox/mdnest.conf"
  ( cd "$sandbox" && bash setup.sh ) >/dev/null 2>&1
  printf '%s' "$sandbox"
}

echo "── setup.sh: Marp theme catalog volume ──"

# 1) Enabled: the catalog must be backed by a declared named volume.
sb="$(generate_compose 'ENABLE_MARP=true' 'ENABLE_MARP_THEMES=true')"
compose="$sb/docker-compose.yml"
if [ ! -f "$compose" ]; then
  bad "compose generated (themes on)" "setup.sh produced no docker-compose.yml"
else
  if grep -q -- '- mdnest-marp-themes:/data/notes/\.marp-themes' "$compose"; then
    ok "catalog is mounted from a named volume"
  else
    bad "catalog is mounted from a named volume" "backend has no mdnest-marp-themes:/data/notes/.marp-themes mount"
  fi
  # The mount must resolve to a declared top-level volume, or Compose errors.
  if awk '/^volumes:/{v=1} v && /^  mdnest-marp-themes:/{found=1} END{exit !found}' "$compose"; then
    ok "named volume is declared under top-level volumes:"
  else
    bad "named volume is declared under top-level volumes:" "mdnest-marp-themes is mounted but never declared — the catalog would live in the writable layer"
  fi
fi
rm -rf "$sb"

# 2) Disabled: no theme volume at all (the feature stays fully opt-in).
sb="$(generate_compose 'ENABLE_MARP=true')"
compose="$sb/docker-compose.yml"
if [ -f "$compose" ] && ! grep -q 'marp-themes' "$compose"; then
  ok "no theme volume when the catalog is disabled"
else
  bad "no theme volume when the catalog is disabled" "marp-themes leaked into the compose file with ENABLE_MARP_THEMES unset"
fi
rm -rf "$sb"

echo ""
printf 'setup-marp-themes: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
