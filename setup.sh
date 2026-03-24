#!/bin/bash
set -e

CONF="mdnest.conf"
SAMPLE="mdnest.conf.sample"

if [ ! -f "$CONF" ]; then
  if [ -f "$SAMPLE" ]; then
    cp "$SAMPLE" "$CONF"
    echo "Created $CONF from $SAMPLE"
    echo "Edit $CONF with your settings, then run ./mdnest server rebuild."
    exit 0
  else
    echo "Error: $SAMPLE not found."
    exit 1
  fi
fi

echo "Reading $CONF..."

# Parse config
MDNEST_USER=""
MDNEST_PASSWORD=""
MDNEST_JWT_SECRET=""
FRONTEND_ORIGIN=""
BACKEND_PORT=""
FRONTEND_PORT=""
GIT_AUTHOR_NAME=""
GIT_AUTHOR_EMAIL=""
declare -a MOUNT_NAMES=()
declare -a MOUNT_PATHS=()

while IFS= read -r line; do
  # Skip comments and empty lines
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue

  key="${line%%=*}"
  value="${line#*=}"

  case "$key" in
    MDNEST_USER) MDNEST_USER="$value" ;;
    MDNEST_PASSWORD) MDNEST_PASSWORD="$value" ;;
    MDNEST_JWT_SECRET) MDNEST_JWT_SECRET="$value" ;;
    FRONTEND_ORIGIN) FRONTEND_ORIGIN="$value" ;;
    BACKEND_PORT) BACKEND_PORT="$value" ;;
    FRONTEND_PORT) FRONTEND_PORT="$value" ;;
    BIND_ADDRESS) BIND_ADDRESS="$value" ;;
    GIT_AUTHOR_NAME) GIT_AUTHOR_NAME="$value" ;;
    GIT_AUTHOR_EMAIL) GIT_AUTHOR_EMAIL="$value" ;;
    GIT_SYNC_INTERVAL) GIT_SYNC_INTERVAL="$value" ;;
    SEARCH_MAX_RESULTS) SEARCH_MAX_RESULTS="$value" ;;
    SEARCH_MAX_FILE_SIZE) SEARCH_MAX_FILE_SIZE="$value" ;;
    SEARCH_WORKERS) SEARCH_WORKERS="$value" ;;
    SEARCH_CACHE_TTL) SEARCH_CACHE_TTL="$value" ;;
    MOUNT_*)
      name="${key#MOUNT_}"
      MOUNT_NAMES+=("$name")
      MOUNT_PATHS+=("$value")
      ;;
  esac
done < "$CONF"

# Defaults
BACKEND_PORT="${BACKEND_PORT:-8286}"
FRONTEND_PORT="${FRONTEND_PORT:-3236}"
MDNEST_USER="${MDNEST_USER:-admin}"
MDNEST_PASSWORD="${MDNEST_PASSWORD:-changeme}"
MDNEST_JWT_SECRET="${MDNEST_JWT_SECRET:-changeme}"
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"
FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:$FRONTEND_PORT}"

if [ ${#MOUNT_NAMES[@]} -eq 0 ]; then
  echo "Error: No MOUNT_ entries found in $CONF."
  echo "Add at least one line like: MOUNT_myrepo=/path/to/directory"
  exit 1
fi

echo "Found ${#MOUNT_NAMES[@]} namespace(s):"
for i in "${!MOUNT_NAMES[@]}"; do
  echo "  ${MOUNT_NAMES[$i]} -> ${MOUNT_PATHS[$i]}"
done

# Generate .env
cat > .env <<EOF
MDNEST_USER=$MDNEST_USER
MDNEST_PASSWORD=$MDNEST_PASSWORD
MDNEST_JWT_SECRET=$MDNEST_JWT_SECRET
FRONTEND_ORIGIN=$FRONTEND_ORIGIN
GIT_AUTHOR_NAME=$GIT_AUTHOR_NAME
GIT_AUTHOR_EMAIL=$GIT_AUTHOR_EMAIL
SEARCH_MAX_RESULTS=${SEARCH_MAX_RESULTS:-30}
SEARCH_MAX_FILE_SIZE=${SEARCH_MAX_FILE_SIZE:-1048576}
SEARCH_WORKERS=${SEARCH_WORKERS:-8}
SEARCH_CACHE_TTL=${SEARCH_CACHE_TTL:-30}
EOF
echo "Generated .env"

# Build volume mount lines for backend
BACKEND_VOLUMES=""
GITSYNC_VOLUMES=""
for i in "${!MOUNT_NAMES[@]}"; do
  BACKEND_VOLUMES="$BACKEND_VOLUMES      - ${MOUNT_PATHS[$i]}:/data/notes/${MOUNT_NAMES[$i]}
"
  GITSYNC_VOLUMES="$GITSYNC_VOLUMES      - ${MOUNT_PATHS[$i]}:/data/notes/${MOUNT_NAMES[$i]}
"
done

# Check for deploy keys
if [ -d "git-sync/keys" ]; then
  KEY_COUNT=$(find git-sync/keys -maxdepth 1 -type f ! -name "*.pub" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$KEY_COUNT" -gt 0 ]; then
    echo "Found $KEY_COUNT deploy key(s) in git-sync/keys/"
  else
    echo "Warning: git-sync/keys/ exists but has no private keys."
    echo "  Add a shared key:        ssh-keygen -t ed25519 -f git-sync/keys/default -N \"\""
    echo "  Or one per namespace:    ssh-keygen -t ed25519 -f git-sync/keys/<namespace> -N \"\""
  fi
else
  mkdir -p git-sync/keys
  echo "Created git-sync/keys/ — add SSH keys for git-sync to push:"
  echo "  Add a shared key:        ssh-keygen -t ed25519 -f git-sync/keys/default -N \"\""
  echo "  Or one per namespace:    ssh-keygen -t ed25519 -f git-sync/keys/<namespace> -N \"\""
fi

# Generate docker-compose.yml
cat > docker-compose.yml <<EOF
services:
  backend:
    build: ./backend
    ports:
      - "${BIND_ADDRESS}:${BACKEND_PORT}:8080"
    env_file:
      - .env
    volumes:
${BACKEND_VOLUMES}      - mdnest-secrets:/data/secrets
    environment:
      - NOTES_DIR=/data/notes
      - SECRETS_DIR=/data/secrets
    restart: unless-stopped

  frontend:
    build: ./frontend
    ports:
      - "${BIND_ADDRESS}:${FRONTEND_PORT}:80"
    depends_on:
      - backend
    restart: unless-stopped

  git-sync:
    image: alpine/git:latest
    profiles:
      - sync
    volumes:
${GITSYNC_VOLUMES}      - ./git-sync/sync.sh:/sync.sh:ro
      - ./git-sync/keys:/keys:ro
    environment:
      - GIT_AUTHOR_NAME=\${GIT_AUTHOR_NAME}
      - GIT_AUTHOR_EMAIL=\${GIT_AUTHOR_EMAIL}
      - GIT_COMMITTER_NAME=\${GIT_AUTHOR_NAME}
      - GIT_COMMITTER_EMAIL=\${GIT_AUTHOR_EMAIL}
      - GIT_SYNC_INTERVAL=${GIT_SYNC_INTERVAL:-600}
    working_dir: /data/notes
    entrypoint: /bin/sh
    command: ["/sync.sh"]
    restart: unless-stopped

volumes:
  mdnest-secrets:
EOF

echo "Generated docker-compose.yml"
echo ""
echo "Ready! Run:"
echo "  ./mdnest server start"
echo ""
echo "Then open http://localhost:${FRONTEND_PORT}"
