# Stage 1: Build
FROM node:20-alpine AS builder

# Build-time feature flag. Default off. To enable the Crepe spike for
# v3.10.0 dogfooding: `docker compose build --build-arg VITE_USE_CREPE=true frontend`
# OR add `VITE_USE_CREPE=true` to a frontend.args block in
# docker-compose.yml. When unset, the existing LiveEditor is used.
ARG VITE_USE_CREPE=false
ENV VITE_USE_CREPE=${VITE_USE_CREPE}

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
