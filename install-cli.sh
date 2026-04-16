#!/bin/bash
# mdnest CLI installer — run with:
#   curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash
set -e

REPO="https://raw.githubusercontent.com/mahsanamin/mdnest/main"
DEST="/usr/local/bin/mdnest"

echo "Installing mdnest CLI..."

if [ -w "$(dirname "$DEST")" ]; then
  curl -fsSL "$REPO/mdnest" -o "$DEST"
  chmod +x "$DEST"
else
  sudo curl -fsSL "$REPO/mdnest" -o "$DEST"
  sudo chmod +x "$DEST"
fi

echo "Installed: $DEST"
echo ""
echo "Get started:"
echo "  mdnest login <server-url> <api-token>"
echo "  mdnest note list"
echo ""
echo "Create an API token from your mdnest web UI: Settings > API Tokens"
