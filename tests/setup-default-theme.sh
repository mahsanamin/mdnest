#!/usr/bin/env bash
#
# setup.sh DEFAULT_THEME plumbing test — no network, no Docker
# ────────────────────────────────────────────────────────────
# DEFAULT_THEME is the theme a user sees before they have chosen one. It has to
# travel mdnest.conf -> setup.sh -> .env -> the backend container, and the
# backend reads it with a fallback to "auto". That fallback is the hazard: a
# knob the backend silently ignores does not fail, it lies. If setup.sh ever
# stops writing DEFAULT_THEME into .env, every install quietly reverts to auto
# and nothing anywhere reports it.
#
# So this pins both directions: the configured value reaches .env, and a value
# that is not auto/dark/light is rejected at setup time rather than persisted
# and ignored.
#
# Usage:  tests/setup-default-theme.sh
# Exit:   0 if every check passes, 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0; FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  %s %s\n' "$(green PASS)" "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  %s %s\n' "$(red FAIL)" "$1"; printf '    %s\n' "$2"; }

# Run setup.sh in a sandbox with the given extra conf lines. Echoes the sandbox
# path; the caller inspects .env / docker-compose.yml and removes it.
generate() {
  local sandbox
  sandbox="$(mktemp -d)"
  cp "$REPO_ROOT/setup.sh" "$REPO_ROOT/mdnest.conf.sample" "$sandbox"/
  {
    printf 'MOUNT_test=%s/notes\n' "$sandbox"
    printf '%s\n' "$@"
  } > "$sandbox/mdnest.conf"
  ( cd "$sandbox" && bash setup.sh ) >"$sandbox/setup.out" 2>&1
  printf '%s' "$sandbox"
}

echo "── setup.sh: DEFAULT_THEME ──"

# 1) Each valid value reaches .env verbatim.
for theme in light dark auto; do
  sb="$(generate "DEFAULT_THEME=$theme")"
  if grep -qx "DEFAULT_THEME=$theme" "$sb/.env" 2>/dev/null; then
    ok "DEFAULT_THEME=$theme reaches .env"
  else
    bad "DEFAULT_THEME=$theme reaches .env" \
        "got: $(grep '^DEFAULT_THEME=' "$sb/.env" 2>/dev/null || echo '<no DEFAULT_THEME line>')"
  fi
  rm -rf "$sb"
done

# 2) Unset means auto — written explicitly, not left empty. An empty value
#    would still work (the backend falls back) but reading .env would not tell
#    an operator what their install is actually doing.
sb="$(generate 'ENABLE_TASK_BOARD=false')"
if grep -qx 'DEFAULT_THEME=auto' "$sb/.env" 2>/dev/null; then
  ok "unset DEFAULT_THEME is written as auto"
else
  bad "unset DEFAULT_THEME is written as auto" \
      "got: $(grep '^DEFAULT_THEME=' "$sb/.env" 2>/dev/null || echo '<no DEFAULT_THEME line>')"
fi
rm -rf "$sb"

# 3) A bad value fails setup instead of being persisted. The backend would
#    fall back to auto, so a typo that reaches .env is invisible forever.
sb="$(generate 'DEFAULT_THEME=drak')"
if [ ! -f "$sb/.env" ] || ! grep -q '^DEFAULT_THEME=drak' "$sb/.env"; then
  ok "an invalid DEFAULT_THEME is not persisted"
else
  bad "an invalid DEFAULT_THEME is not persisted" "setup.sh wrote DEFAULT_THEME=drak to .env"
fi
if grep -q 'DEFAULT_THEME must be' "$sb/setup.out" 2>/dev/null; then
  ok "an invalid DEFAULT_THEME is reported by name"
else
  bad "an invalid DEFAULT_THEME is reported by name" \
      "setup.sh output did not explain the rejection: $(head -3 "$sb/setup.out" 2>/dev/null)"
fi
rm -rf "$sb"

# 4) The knob is documented. An undocumented env var is one nobody sets.
if grep -q 'DEFAULT_THEME' "$REPO_ROOT/mdnest.conf.sample"; then
  ok "DEFAULT_THEME is documented in mdnest.conf.sample"
else
  bad "DEFAULT_THEME is documented in mdnest.conf.sample" "no mention in the sample conf"
fi

echo ""
printf 'setup-default-theme: %s passed, %s failed\n' "$(green "$PASS")" "$([ "$FAIL" -eq 0 ] && green 0 || red "$FAIL")"
[ "$FAIL" -eq 0 ]
