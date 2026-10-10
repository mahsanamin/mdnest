#!/bin/bash
# mdnest CLI installer, served by an mdnest server at /cli/install.sh.
#
#   curl -fsSL https://notes.example.com/cli/install.sh | bash -s -- https://notes.example.com
#
# It installs the CLI this server was built with (served next to it at
# /cli/mdnest), so the CLI matches the server even when the server runs a
# develop build, an older release or a fork. Only if that download fails does
# it fall back to the latest release from GitHub. It only installs: it prints
# the login command for this server but does not run it, because most people
# running it already have the CLI connected, or are updating.
#
# The repo-root install-cli.sh is the GitHub/mdnest.dev installer and is a
# separate file on purpose: this one is fetched on its own and cannot source
# anything. The download and install steps below mirror it; keep them alike.
set -e

SERVER="${1:-${MDNEST_SERVER:-}}"
SERVER="${SERVER%/}"
case "$SERVER" in
  http://?*|https://?*) ;;
  *)
    echo "Error: pass the server's address, for example:" >&2
    echo "  curl -fsSL https://notes.example.com/cli/install.sh | bash -s -- https://notes.example.com" >&2
    exit 1 ;;
esac

BIN_DIR="/usr/local/bin"
NAME="mdnest"

# This server first; GitHub's latest release only as a fallback.
mdnest_sources() {
  echo "${SERVER}/cli/${NAME}"
  echo "https://raw.githubusercontent.com/mahsanamin/mdnest/main/${NAME}"
  echo "https://cdn.jsdelivr.net/gh/mahsanamin/mdnest@main/${NAME}"
  echo "https://mdnest.dev/cli/${NAME}"
  return 0
}

# Rejects an HTML error page, a proxy login page and a truncated download.
looks_like_cli() {
  head -1 "$1" | grep -q '^#!' && grep -q '^MDNEST_CLI_VERSION=' "$1"
}

echo "Installing the mdnest CLI from ${SERVER}..."
# Plain http is a supported setup (a LAN install), but code fetched over it
# can be changed on the way. Say so rather than refuse.
case "$SERVER" in
  http://localhost*|http://127.*|http://\[::1\]*|https://*) ;;
  *) echo "Warning: ${SERVER} is plain http, so the CLI it sends could be altered on the way. Prefer https." ;;
esac

TMP="$(mktemp "${TMPDIR:-/tmp}/mdnest.XXXXXX")" || { echo "Error: couldn't create a temp file." >&2; exit 1; }
trap 'rm -f "$TMP"' EXIT

WHY=""
GOT=""
while IFS= read -r url; do
  [ -n "$url" ] || continue
  for attempt in 1 2; do
    code="$(curl -sSL --max-time 30 -o "$TMP" -w '%{http_code}' "$url" 2>/dev/null)" || code="000"
    if [ "$code" = "200" ] && looks_like_cli "$TMP"; then
      GOT="$url"
      break
    fi
    if [ "$code" = "200" ]; then
      WHY="$WHY
  $url: 200 but the file is not the mdnest CLI (an error page?)"
      break
    fi
    if [ "$attempt" = "2" ]; then
      WHY="$WHY
  $url: HTTP $code"
    else
      sleep 1
    fi
  done
  if [ -n "$GOT" ]; then break; fi
done <<SOURCES
$(mdnest_sources)
SOURCES

if [ -z "$GOT" ]; then
  echo "Error: couldn't download the mdnest CLI from any source." >&2
  echo "Tried:$WHY" >&2
  exit 1
fi
if [ "$GOT" != "${SERVER}/cli/${NAME}" ]; then
  echo "Note: ${SERVER} did not serve the CLI, so this is the latest release from GitHub."
fi

SUDO=""
if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  BIN_DIR="$HOME/.local/bin"
fi
# MDNEST_BIN_DIR picks the folder outright (no sudo); the tests use it.
if [ -n "${MDNEST_BIN_DIR:-}" ]; then
  BIN_DIR="$MDNEST_BIN_DIR"
  SUDO=""
fi
DEST="$BIN_DIR/$NAME"

if [ ! -d "$BIN_DIR" ]; then
  $SUDO mkdir -p "$BIN_DIR" || { echo "Error: couldn't create $BIN_DIR" >&2; exit 1; }
fi
$SUDO install -m 0755 "$TMP" "$DEST"

echo "Installed: $DEST ($("$DEST" version))"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""
     echo "Note: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo ""
echo "To connect it to ${SERVER}, run this and paste a token when it asks"
echo "(create one in Settings, CLI or API Tokens):"
echo "  mdnest login ${SERVER}"
