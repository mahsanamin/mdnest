#!/bin/bash
# mdnest CLI installer — run with:
#   curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
#
# Install from a different branch (e.g. to try an unreleased build):
#   curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/develop/install-cli.sh | MDNEST_BRANCH=develop bash
set -e

# Which branch to pull the CLI from (default: main = the latest release).
BRANCH="${MDNEST_BRANCH:-main}"
REPO="https://raw.githubusercontent.com/mahsanamin/mdnest/${BRANCH}"
BIN_DIR="/usr/local/bin"
NAME="mdnest"

echo "Installing mdnest CLI (branch: ${BRANCH})..."

# Download to a temp file FIRST, then install atomically. Writing curl's output
# straight to /usr/local/bin/mdnest fails on a fresh machine when that directory
# doesn't exist yet or isn't writable — curl aborts mid-stream with
# "curl: (56) Failure writing output to destination". A temp file + explicit
# mkdir + install avoids that and never leaves a half-written binary behind.
TMP="$(mktemp "${TMPDIR:-/tmp}/mdnest.XXXXXX")" || { echo "Error: couldn't create a temp file." >&2; exit 1; }
trap 'rm -f "$TMP"' EXIT

if ! curl -fsSL "$REPO/$NAME" -o "$TMP"; then
  echo "Error: failed to download the mdnest CLI from $REPO/$NAME" >&2
  echo "Check your network / proxy and try again." >&2
  exit 1
fi

# Sanity-check we got the script, not an HTML error page.
if ! head -1 "$TMP" | grep -q '^#!'; then
  echo "Error: downloaded file doesn't look like the mdnest CLI (no shebang)." >&2
  echo "The URL may be wrong or returned an error page." >&2
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
echo "  mdnest login <server-url> <api-token>"
echo "  mdnest servers"
echo ""
echo "Create an API token from your mdnest web UI: Settings > API Tokens"
