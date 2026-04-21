# Stage 1: Build
# Bumped to 1.25 for the Firebase Admin SDK (firebase.google.com/go/v4
# transitively requires 1.25+).
FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o mdnest .

# Stage 2: Run
FROM alpine:latest

RUN apk add --no-cache ca-certificates git openssh-client

WORKDIR /app

COPY --from=builder /app/mdnest .

EXPOSE 8080

CMD ["./mdnest"]
