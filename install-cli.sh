#!/bin/bash
# mdnest CLI installer — run with:
#   curl -fsSL https://mdnest.dev/install.sh | bash
#
# Install from a different branch (e.g. to try an unreleased build):
#   curl -fsSL https://mdnest.dev/install.sh | MDNEST_BRANCH=develop bash
#
# The GitHub URL still works and is the same script:
#   curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
set -e

# Which branch to pull the CLI from (default: main = the latest release).
BRANCH="${MDNEST_BRANCH:-main}"
BIN_DIR="/usr/local/bin"
NAME="mdnest"

# Where the CLI can be fetched from, in order.
#
# raw.githubusercontent.com stays FIRST because it publishes the instant a fix
# lands on main — jsDelivr caches a branch ref for hours, so leading with it
# would mean a CLI fix reaching nobody for half a day.
#
# But it is one Fastly tier, and it does fail on its own: a POP that has run
# out of backend connections answers `503 Backend.max_conn reached` to every
# request in that region while GitHub itself is perfectly healthy. That took
# out installs with no fallback and no retry, and reported it as "check your
# network" — which sent people to look at the one thing that was fine.
#
# So: an independent CDN over the same repo, then our own host, which mirrors
# main on every site deploy.
mdnest_sources() {
  local branch="$1" name="$2"
  echo "https://raw.githubusercontent.com/mahsanamin/mdnest/${branch}/${name}"
  echo "https://cdn.jsdelivr.net/gh/mahsanamin/mdnest@${branch}/${name}"
  # mdnest.dev mirrors main only — a branch build has to come from GitHub.
  if [ "$branch" = "main" ]; then
    echo "https://mdnest.dev/cli/${name}"
  fi
  # Explicit: under `set -e` a function whose last statement is a false test
  # makes the function itself fail.
  return 0
}

# looks_like_cli rejects an HTML error page and a truncated download. The
# shebang alone is not enough — a proxy login page can start with anything,
# and half a script still has a valid first line.
looks_like_cli() {
  head -1 "$1" | grep -q '^#!' && grep -q '^MDNEST_CLI_VERSION=' "$1"
}

echo "Installing mdnest CLI (branch: ${BRANCH})..."

# Download to a temp file FIRST, then install atomically. Writing curl's output
# straight to /usr/local/bin/mdnest fails on a fresh machine when that directory
# doesn't exist yet or isn't writable — curl aborts mid-stream with
# "curl: (56) Failure writing output to destination". A temp file + explicit
# mkdir + install avoids that and never leaves a half-written binary behind.
TMP="$(mktemp "${TMPDIR:-/tmp}/mdnest.XXXXXX")" || { echo "Error: couldn't create a temp file." >&2; exit 1; }
trap 'rm -f "$TMP"' EXIT

# Try every source, twice each. Two attempts because the failure this exists
# for is a transient edge condition, and one retry a second later often just
# works; more than two only makes a real outage slower to report.
WHY=""
GOT=""
while IFS= read -r url; do
  [ -n "$url" ] || continue
  for attempt in 1 2; do
    # No -f: curl would exit non-zero and we want to keep the status code so
    # the failure can name itself. Same reasoning as curl_reason in the CLI —
    # the reason is the part the reader has to act on.
    code="$(curl -sSL --max-time 30 -o "$TMP" -w '%{http_code}' "$url" 2>/dev/null)" || code="000"
    if [ "$code" = "200" ] && looks_like_cli "$TMP"; then
      GOT="$url"
      break
    fi
    if [ "$code" = "200" ]; then
      WHY="$WHY
  $url — 200 but the file is not the mdnest CLI (an error page?)"
      break   # a 200 serving junk will not fix itself on a retry
    fi
    [ "$attempt" = "2" ] && WHY="$WHY
  $url — HTTP $code"
    [ "$attempt" = "1" ] && sleep 1
  done
  [ -n "$GOT" ] && break
done <<SOURCES
$(mdnest_sources "$BRANCH" "$NAME")
SOURCES

if [ -z "$GOT" ]; then
  echo "Error: couldn't download the mdnest CLI from any source." >&2
  echo "Tried:$WHY" >&2
  echo "" >&2
  echo "A 503 from raw.githubusercontent.com is GitHub's CDN, not your network" >&2
  echo "and not this repo — it usually clears within minutes. Anything else," >&2
  echo "check your proxy, or download the script by hand from:" >&2
  echo "  https://github.com/mahsanamin/mdnest/blob/${BRANCH}/mdnest" >&2
  exit 1
fi

# Choose install location + whether sudo is needed. Prefer /usr/local/bin;
# fall back to ~/.local/bin (no sudo) when we can neither write it nor elevate.
SUDO=""
if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  BIN_DIR="$HOME/.local/bin"
fi

DEST="$BIN_DIR/$NAME"

# Ensure the target directory exists (the missing piece on fresh machines).
if [ ! -d "$BIN_DIR" ]; then
  $SUDO mkdir -p "$BIN_DIR" || { echo "Error: couldn't create $BIN_DIR" >&2; exit 1; }
fi

# Install atomically with the right mode.
$SUDO install -m 0755 "$TMP" "$DEST"

echo "Installed: $DEST"

# If we fell back to ~/.local/bin and it isn't on PATH, tell the user.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""
     echo "Note: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo ""
echo "Get started:"
echo "  mdnest login https://notes.example.com mdnest_yourtoken"
echo "  mdnest servers"
echo ""
echo "Create an API token from your mdnest web UI: Settings > API Tokens"
