#!/bin/bash
set -e

CONF="mdnest.conf"
SAMPLE="mdnest.conf.sample"

if [ ! -f "$CONF" ]; then
  if [ -f "$SAMPLE" ]; then
    cp "$SAMPLE" "$CONF"
    echo "Created $CONF from $SAMPLE"
    echo "Edit $CONF with your settings, then run ./mdnest-server rebuild."
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
    SERVER_ALIAS) SERVER_ALIAS="$value" ;;
    FRONTEND_ORIGIN) FRONTEND_ORIGIN="$value" ;;
    BACKEND_PORT) BACKEND_PORT="$value" ;;
    FRONTEND_PORT) FRONTEND_PORT="$value" ;;
    BIND_ADDRESS) BIND_ADDRESS="$value" ;;
    GIT_AUTHOR_NAME) GIT_AUTHOR_NAME="$value" ;;
    GIT_AUTHOR_EMAIL) GIT_AUTHOR_EMAIL="$value" ;;
    GIT_SYNC_INTERVAL) GIT_SYNC_INTERVAL="$value" ;;
    AUTH_MODE) AUTH_MODE="$value" ;;
    POSTGRES_HOST) POSTGRES_HOST="$value" ;;
    POSTGRES_PORT) POSTGRES_PORT="$value" ;;
    POSTGRES_DB) POSTGRES_DB="$value" ;;
    POSTGRES_USER) POSTGRES_USER="$value" ;;
    POSTGRES_PASSWORD) POSTGRES_PASSWORD="$value" ;;
    ENABLE_LIVE_COLLAB) ENABLE_LIVE_COLLAB="$value" ;;
    SSH_KEY_PATH) SSH_KEY_PATH="$value" ;;
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
AUTH_MODE="${AUTH_MODE:-single}"

# Validate multi mode config
if [ "$AUTH_MODE" = "multi" ]; then
  POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
  POSTGRES_PORT="${POSTGRES_PORT:-5432}"
  POSTGRES_DB="${POSTGRES_DB:-mdnest}"
  POSTGRES_USER="${POSTGRES_USER:-mdnest}"
  if [ -z "$POSTGRES_PASSWORD" ]; then
    echo "Error: AUTH_MODE=multi requires POSTGRES_PASSWORD to be set in $CONF."
    exit 1
  fi
  echo "Auth mode: multi (PostgreSQL-backed users & permissions)"
  echo "  Database: ${POSTGRES_USER}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
else
  echo "Auth mode: single (file-based, default)"
fi

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
AUTH_MODE=${AUTH_MODE}
ENABLE_LIVE_COLLAB=${ENABLE_LIVE_COLLAB:-false}
SERVER_ALIAS=${SERVER_ALIAS:-}
EOF

if [ "$AUTH_MODE" = "multi" ]; then
  cat >> .env <<EOF
POSTGRES_HOST=${POSTGRES_HOST}
POSTGRES_PORT=${POSTGRES_PORT}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
EOF
fi

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

# SSH key for git pull (sync button)
SSH_KEY_VOLUME=""
if [ -n "$SSH_KEY_PATH" ]; then
  if [ -f "$SSH_KEY_PATH" ]; then
    SSH_KEY_VOLUME="      - ${SSH_KEY_PATH}:/root/.ssh/deploy_key:ro
"
    BACKEND_VOLUMES="${BACKEND_VOLUMES}${SSH_KEY_VOLUME}"
    echo "SSH key: $SSH_KEY_PATH (mounted for git pull)"
  else
    echo "Warning: SSH_KEY_PATH=$SSH_KEY_PATH does not exist, skipping"
  fi
fi

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

# Build backend depends_on and extra environment for multi mode
BACKEND_DEPENDS=""
BACKEND_EXTRA_ENV=""
POSTGRES_SERVICE=""
EXTRA_VOLUMES=""

if [ "$AUTH_MODE" = "multi" ]; then
  BACKEND_EXTRA_ENV="      - POSTGRES_HOST=${POSTGRES_HOST}
      - POSTGRES_PORT=${POSTGRES_PORT}
      - POSTGRES_DB=${POSTGRES_DB}
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=\${POSTGRES_PASSWORD}
"

  # Only add postgres container if using default internal hostname
  if [ "$POSTGRES_HOST" = "postgres" ]; then
    BACKEND_DEPENDS="    depends_on:
      postgres:
        condition: service_healthy
"
    POSTGRES_SERVICE="
  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=${POSTGRES_DB}
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=\${POSTGRES_PASSWORD}
    volumes:
      - mdnest-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: [\"CMD-SHELL\", \"pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}\"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
"
    EXTRA_VOLUMES="  mdnest-pgdata:"
  fi
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
${BACKEND_DEPENDS}    volumes:
${BACKEND_VOLUMES}      - mdnest-secrets:/data/secrets
    environment:
      - NOTES_DIR=/data/notes
      - SECRETS_DIR=/data/secrets
${BACKEND_EXTRA_ENV}    restart: unless-stopped

  frontend:
    build: ./frontend
    ports:
      - "${BIND_ADDRESS}:${FRONTEND_PORT}:80"
    depends_on:
      - backend
    restart: unless-stopped
${POSTGRES_SERVICE}
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
${EXTRA_VOLUMES}
EOF

echo "Generated docker-compose.yml"
echo ""
echo "Ready! Run:"
echo "  ./mdnest-server start"
echo ""
echo "Then open http://localhost:${FRONTEND_PORT}"
