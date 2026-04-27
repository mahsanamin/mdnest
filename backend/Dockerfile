# syntax=docker/dockerfile:1.4
# (the syntax line enables BuildKit cache mounts below)

# Stage 1: Build
# Bumped to 1.25 for the Firebase Admin SDK (firebase.google.com/go/v4
# transitively requires 1.25+).
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Cache the Go module download layer in a BuildKit cache mount so it
# persists across `--no-cache` rebuilds. First build pulls everything,
# subsequent ones reuse the cache → ~zero network time on rebuild.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .

# Two cache mounts:
#   /root/.cache/go-build — Go's incremental compile cache. Reusing this
#     across builds is the biggest win for our codebase post-v3.4.0
#     (firestore + grpc + protobuf are slow to compile from scratch).
#     Took us from ~180-235s clean down to ~10-30s when only mdnest
#     source has changed.
#   /go/pkg/mod — module cache, mirrored for the build step too.
# These cache mounts SURVIVE `--no-cache` because they're stored outside
# the image layers; only the layer hashes get invalidated.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux go build -o mdnest .

# Stage 2: Run
FROM alpine:latest

RUN apk add --no-cache ca-certificates git openssh-client

WORKDIR /app

COPY --from=builder /app/mdnest .

EXPOSE 8080

CMD ["./mdnest"]
