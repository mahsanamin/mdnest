# syntax=docker/dockerfile:1

# --- dependencies ---------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime --------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json index.js oauth.js ./

# Default to the streamable-HTTP transport when running as a container/service.
# (The stdio transport remains available by overriding MCP_TRANSPORT=stdio.)
ENV MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000 \
    MCP_HTTP_PATH=/mcp

EXPOSE 3000
USER node
CMD ["node", "index.js"]
