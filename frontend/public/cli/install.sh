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

# Colour only for a person at a terminal: never in a pipe, with NO_COLOR
# (https://no-color.org) or TERM=dumb. MDNEST_COLOR=always or never overrides
# it. With colour off these print exactly the text they are given.
C1=0; C2=0
case "${MDNEST_COLOR:-auto}" in
  always) C1=1; C2=1 ;;
  never) ;;
  *)
    if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
      if [ -t 1 ]; then C1=1; fi
      if [ -t 2 ]; then C2=1; fi
    fi ;;
esac
paint() { if [ "$1" = 1 ]; then printf '\033[%sm%s\033[0m' "$2" "$3"; else printf '%s' "$3"; fi; }
say_ok()   { if [ "$C1" = 1 ]; then printf '\033[32m\342\234\223\033[0m %s\n' "$*"; else printf '%s\n' "$*"; fi; }
say_note() { paint "$C1" 33 "$*"; printf '\n'; }
say_err()  { { paint "$C2" 31 "$*"; printf '\n'; } >&2; }
say_cmd()  { paint "$C1" 1 "$*"; printf '\n'; }

# The server address, plus the optional --agent-skills (set up the AI agent
# skill without asking) or --no-agent-skills (never ask), in any order.
# MDNEST_AGENT_SKILLS=1 or 0 does the same as the flags.
SERVER="${MDNEST_SERVER:-}"
AGENT_SKILLS="${MDNEST_AGENT_SKILLS:-}"
for arg in "$@"; do
  case "$arg" in
    --agent-skills) AGENT_SKILLS=1 ;;
    --no-agent-skills) AGENT_SKILLS=0 ;;
    *) SERVER="$arg" ;;
  esac
done
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
  *) say_note "Warning: ${SERVER} is plain http, so the CLI it sends could be altered on the way. Prefer https." ;;
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
  say_err "Error: couldn't download the mdnest CLI from any source."
  echo "Tried:$WHY" >&2
  exit 1
fi
if [ "$GOT" != "${SERVER}/cli/${NAME}" ]; then
  say_note "Note: ${SERVER} did not serve the CLI, so this is the latest release from GitHub."
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

say_ok "Installed: $DEST ($("$DEST" version))"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""
     say_note "Note: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     say_cmd "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo ""
echo "To connect it to ${SERVER}, run this and paste a token when it asks"
echo "(create one in Settings, CLI or API Tokens):"
say_cmd "  mdnest login ${SERVER}"

# Offer the AI agent skill once. The CLI asks on the terminal (Enter or y
# installs, n is remembered), only when an AI tool is on this machine and the
# skill is not there yet; with no terminal it prints a one-line hint instead.
# --agent-skills installs without asking, --no-agent-skills never asks. A CLI
# too old to have `agent offer` is skipped. It never fails the install.
if grep -q '^agent_offer()' "$DEST" 2>/dev/null; then
  MDNEST_AGENT_SKILLS="$AGENT_SKILLS" "$DEST" agent offer </dev/null || true
fi
