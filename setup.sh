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
    REQUIRE_2FA) REQUIRE_2FA="$value" ;;
    TOTP_ISSUER) TOTP_ISSUER="$value" ;;
    CADDY_DOMAIN) CADDY_DOMAIN="$value" ;;
    SSH_KEY_PATH) SSH_KEY_PATH="$value" ;;
    SEARCH_MAX_RESULTS) SEARCH_MAX_RESULTS="$value" ;;
    SEARCH_MAX_FILE_SIZE) SEARCH_MAX_FILE_SIZE="$value" ;;
    SEARCH_WORKERS) SEARCH_WORKERS="$value" ;;
    SEARCH_CACHE_TTL) SEARCH_CACHE_TTL="$value" ;;
    USER_PROVIDER) USER_PROVIDER="$value" ;;
    FIREBASE_PROJECT_ID) FIREBASE_PROJECT_ID="$value" ;;
    FIREBASE_SERVICE_ACCOUNT) FIREBASE_SERVICE_ACCOUNT="$value" ;;
    FIREBASE_WEB_CONFIG) FIREBASE_WEB_CONFIG="$value" ;;
    ADMIN_EMAILS) ADMIN_EMAILS="$value" ;;
    SSO_ISSUER_URL) SSO_ISSUER_URL="$value" ;;
    SSO_CLIENT_ID) SSO_CLIENT_ID="$value" ;;
    SSO_CLIENT_SECRET) SSO_CLIENT_SECRET="$value" ;;
    SSO_REDIRECT_URL) SSO_REDIRECT_URL="$value" ;;
    SSO_ALLOWED_DOMAINS) SSO_ALLOWED_DOMAINS="$value" ;;
    SSO_PROVIDER_LABEL) SSO_PROVIDER_LABEL="$value" ;;
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

# Validate Firebase mode config — see docs/firebase-setup.md for how to
# create the project and download these two files.
USER_PROVIDER="${USER_PROVIDER:-local}"
if [ "$USER_PROVIDER" = "firebase" ]; then
  if [ "$AUTH_MODE" != "multi" ]; then
    echo "Error: USER_PROVIDER=firebase requires AUTH_MODE=multi."
    exit 1
  fi
  if [ -z "$FIREBASE_PROJECT_ID" ]; then
    echo "Error: USER_PROVIDER=firebase requires FIREBASE_PROJECT_ID in $CONF."
    exit 1
  fi
  if [ -z "$FIREBASE_SERVICE_ACCOUNT" ] || [ ! -f "$FIREBASE_SERVICE_ACCOUNT" ]; then
    echo "Error: FIREBASE_SERVICE_ACCOUNT must point to an existing service-account JSON file."
    echo "       See docs/firebase-setup.md step 4 for how to download it."
    exit 1
  fi
  if [ -z "$FIREBASE_WEB_CONFIG" ] || [ ! -f "$FIREBASE_WEB_CONFIG" ]; then
    echo "Error: FIREBASE_WEB_CONFIG must point to an existing firebase-web-config JSON file."
    echo "       See docs/firebase-setup.md step 5 for how to save it."
    exit 1
  fi
  echo "User provider: firebase (federated identity across mdnest servers)"
  echo "  Project: $FIREBASE_PROJECT_ID"
fi

# Validate SSO mode config — see docs/sso-setup.md for how to create the
# OAuth client, configure redirect URIs, etc.
if [ "$USER_PROVIDER" = "sso" ]; then
  if [ "$AUTH_MODE" != "multi" ]; then
    echo "Error: USER_PROVIDER=sso requires AUTH_MODE=multi."
    exit 1
  fi
  if [ -z "$SSO_ISSUER_URL" ]; then
    echo "Error: USER_PROVIDER=sso requires SSO_ISSUER_URL in $CONF."
    echo "       Google: https://accounts.google.com"
    echo "       Okta:   https://<your-org>.okta.com"
    exit 1
  fi
  if [ -z "$SSO_CLIENT_ID" ] || [ -z "$SSO_CLIENT_SECRET" ]; then
    echo "Error: USER_PROVIDER=sso requires SSO_CLIENT_ID and SSO_CLIENT_SECRET in $CONF."
    echo "       Ask your devops for the OAuth client credentials, or see docs/sso-setup.md."
    exit 1
  fi
  echo "User provider: sso (generic OIDC — 2FA is delegated to the IdP)"
  echo "  Issuer: $SSO_ISSUER_URL"
  if [ -n "$SSO_ALLOWED_DOMAINS" ]; then
    echo "  Allowed email domains: $SSO_ALLOWED_DOMAINS"
  fi
fi

if [ ${#MOUNT_NAMES[@]} -eq 0 ]; then
  echo "Error: No MOUNT_ entries found in $CONF."
  echo "Add at least one line like: MOUNT_myrepo=/path/to/directory"
  exit 1
fi

echo "Found ${#MOUNT_NAMES[@]} namespace(s):"
for i in "${!MOUNT_NAMES[@]}"; do
  if [ ! -d "${MOUNT_PATHS[$i]}" ]; then
    echo "  ${MOUNT_NAMES[$i]} -> ${MOUNT_PATHS[$i]} (creating directory)"
    mkdir -p "${MOUNT_PATHS[$i]}"
  else
    echo "  ${MOUNT_NAMES[$i]} -> ${MOUNT_PATHS[$i]}"
  fi
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
REQUIRE_2FA=${REQUIRE_2FA:-false}
TOTP_ISSUER=${TOTP_ISSUER:-mdnest}
SERVER_ALIAS=${SERVER_ALIAS:-}
USER_PROVIDER=${USER_PROVIDER:-local}
EOF

if [ "$USER_PROVIDER" = "firebase" ]; then
  cat >> .env <<EOF
FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}
FIREBASE_SERVICE_ACCOUNT=/etc/mdnest/firebase-service-account.json
FIREBASE_WEB_CONFIG=/etc/mdnest/firebase-web-config.json
ADMIN_EMAILS=${ADMIN_EMAILS:-}
EOF
fi

if [ "$USER_PROVIDER" = "sso" ]; then
  cat >> .env <<EOF
SSO_ISSUER_URL=${SSO_ISSUER_URL}
SSO_CLIENT_ID=${SSO_CLIENT_ID}
SSO_CLIENT_SECRET=${SSO_CLIENT_SECRET}
SSO_REDIRECT_URL=${SSO_REDIRECT_URL:-}
SSO_ALLOWED_DOMAINS=${SSO_ALLOWED_DOMAINS:-}
SSO_PROVIDER_LABEL=${SSO_PROVIDER_LABEL:-}
ADMIN_EMAILS=${ADMIN_EMAILS:-}
EOF
fi

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

# Firebase mode: mount the service-account JSON (backend-only, reads for
# Admin SDK) and the web-config JSON (backend reads it, serves it inline
# via /api/config so the frontend can init the Firebase SDK).
if [ "$USER_PROVIDER" = "firebase" ]; then
  BACKEND_VOLUMES="${BACKEND_VOLUMES}      - ${FIREBASE_SERVICE_ACCOUNT}:/etc/mdnest/firebase-service-account.json:ro
      - ${FIREBASE_WEB_CONFIG}:/etc/mdnest/firebase-web-config.json:ro
"
fi

# SSH key for git pull/push (backend sync button + git-sync sidecar)
SSH_KEY_VOLUME=""
SSH_KEY_GITSYNC=""
if [ -n "$SSH_KEY_PATH" ]; then
  if [ -f "$SSH_KEY_PATH" ]; then
    SSH_KEY_VOLUME="      - ${SSH_KEY_PATH}:/root/.ssh/deploy_key:ro
"
    SSH_KEY_GITSYNC="      - ${SSH_KEY_PATH}:/ssh-key:ro
"
    BACKEND_VOLUMES="${BACKEND_VOLUMES}${SSH_KEY_VOLUME}"
    GITSYNC_VOLUMES="${GITSYNC_VOLUMES}${SSH_KEY_GITSYNC}"
    echo "SSH key: $SSH_KEY_PATH (mounted for git pull/push)"
  else
    echo "Warning: SSH_KEY_PATH=$SSH_KEY_PATH does not exist, skipping"
  fi
fi

# Check for deploy keys
if [ -d "git-sync/keys" ]; then
  KEY_COUNT=$(find git-sync/keys -maxdepth 1 -type f ! -name "*.pub" ! -name ".gitkeep" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$KEY_COUNT" -gt 0 ]; then
    echo "Found $KEY_COUNT deploy key(s) in git-sync/keys/"
    # Mount keys into backend too (so sync button can use per-namespace keys)
    BACKEND_VOLUMES="${BACKEND_VOLUMES}      - ./git-sync/keys:/keys:ro
"
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

# Caddy HTTPS proxy
CADDY_SERVICE=""
CADDY_VOLUMES=""
if [ -n "$CADDY_DOMAIN" ]; then
  echo "Caddy HTTPS: enabled for $CADDY_DOMAIN"

  # Generate Caddyfile
  cat > Caddyfile <<CADDYEOF
${CADDY_DOMAIN} {
    reverse_proxy frontend:80
}
CADDYEOF
  echo "Generated Caddyfile"

  # Backend/frontend use expose (internal only) when Caddy is in front
  BACKEND_PORT_LINE="    expose:
      - \"8080\""
  FRONTEND_PORT_LINE="    expose:
      - \"80\""

  CADDY_SERVICE="
  caddy:
    image: caddy:2-alpine
    ports:
      - \"80:80\"
      - \"443:443\"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - frontend
    restart: unless-stopped
"
  CADDY_VOLUMES="  caddy-data:
  caddy-config:"
else
  BACKEND_PORT_LINE="    ports:
      - \"${BIND_ADDRESS}:${BACKEND_PORT}:8080\""
  FRONTEND_PORT_LINE="    ports:
      - \"${BIND_ADDRESS}:${FRONTEND_PORT}:80\""
fi

# Generate docker-compose.yml
cat > docker-compose.yml <<EOF
services:
  backend:
    build: ./backend
${BACKEND_PORT_LINE}
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
${FRONTEND_PORT_LINE}
    depends_on:
      - backend
    restart: unless-stopped
${POSTGRES_SERVICE}${CADDY_SERVICE}
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
${CADDY_VOLUMES}
EOF

echo "Generated docker-compose.yml"
echo ""
echo "Ready! Run:"
echo "  ./mdnest-server start"
echo ""
if [ -n "$CADDY_DOMAIN" ]; then
  echo "Then open https://${CADDY_DOMAIN}"
else
  echo "Then open http://localhost:${FRONTEND_PORT}"
fi
