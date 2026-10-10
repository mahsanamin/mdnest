# Stage 1: Build
# The output is static files, identical for every architecture, so the build
# runs on the build machine's own platform even for a multi-arch release.
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
# The CLI this image was built with, served at /cli/mdnest so a server hands
# out a CLI that matches it. It lives at the repo root, outside this build
# context, so it comes from a named context: `--build-context cli=.` (docker
# build), `additional_contexts` (the compose file setup.sh writes), and
# `build-contexts` (release.yml, ci.yml). Without it this line fails the
# build, which is better than an image that quietly serves no CLI.
COPY --from=cli mdnest /usr/share/nginx/html/cli/mdnest
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
