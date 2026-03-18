# Security

mdnest is designed to be private by default. This document explains how your notes stay secure at every layer.

## How It Works

```
Your device  -->  Tailscale (encrypted tunnel)  -->  Your server (127.0.0.1)
                                                         |
                                                     Docker container
                                                         |
                                                     Go backend (JWT / API tokens)
                                                         |
                                                     Files on disk (your mount)
```

Three layers protect your notes:

1. **Network** -- nothing is exposed unless you choose to expose it
2. **Authentication** -- every request requires a valid token
3. **Path safety** -- the backend cannot read or write outside your mounted directories

## Layer 1: Network Isolation

By default, mdnest binds to `127.0.0.1`. This means:

- Only processes on the same machine can reach it
- Other devices on your Wi-Fi, LAN, or internet cannot connect
- No ports are open to the outside world

This is the most important security boundary. Even if the auth layer had a bug, attackers on the network can't reach the app.

### Accessing from other devices

When you need to access mdnest from your phone or another computer, use **Tailscale**. Here's why:

**What Tailscale does:**
- Creates a private network (tailnet) between your devices
- Every connection is encrypted end-to-end with WireGuard
- Only devices you've authorized can join your tailnet
- No ports opened on your firewall, no public IP needed

**What `tailscale serve` adds:**
- Gives your server a trusted HTTPS certificate (automatic, free)
- Proxies HTTPS traffic to your localhost-only mdnest
- The certificate is issued by Tailscale's CA, trusted only by your tailnet devices

**The result:**
```
https://your-server.tailnet-name.ts.net:3236
```
- Encrypted in transit (HTTPS + WireGuard)
- Only your devices can resolve and connect to this URL
- Someone who knows the URL but isn't on your tailnet gets nothing -- the hostname doesn't resolve for them

### Setup

```bash
# On the server (one time)
tailscale serve --bg --https 3236 http://127.0.0.1:3236
```

That's it. Access from any device on your tailnet.

### Why not just open the port?

Setting `BIND_ADDRESS=0.0.0.0` would let any device on your local network reach mdnest. This is risky because:

- Anyone on your Wi-Fi (office, cafe, hotel) can access the login page
- The login page is protected by a password, but passwords can be brute-forced
- There's no rate limiting on login attempts
- Your notes are transmitted in plain HTTP (no encryption)

Tailscale solves all of these: encrypted, authenticated at the network level, no brute-force surface.

## Layer 2: Authentication

Every API request (except login) requires a token in the `Authorization` header.

### Two token types

| Type | Format | Expiry | Use case |
|---|---|---|---|
| JWT | `eyJhbG...` | 24 hours | Browser sessions (login with username/password) |
| API token | `mdnest_abc123...` | Never | MCP servers, scripts, API clients |

### Passwords

- Stored as **bcrypt hashes** on disk (`/data/secrets/auth.json`)
- Never stored in plain text after first password change
- Default credentials from `mdnest.conf` are used until you change them via Settings
- The backend logs a warning on startup if default credentials are still in use

### API tokens

- Generated as 32 random bytes (cryptographically secure)
- Stored as **SHA-256 hashes** -- the raw token is shown once on creation and never again
- Revocable from Settings > API Tokens
- No expiry -- revoke manually when no longer needed

### What's protected

| Route | Auth required |
|---|---|
| `POST /api/auth/login` | No (this is how you get a token) |
| Everything else | Yes |

## Layer 3: Path Safety

The backend restricts all file operations to your mounted directories.

**How it works:**
- Every file path is cleaned, resolved, and checked against the namespace base directory
- Absolute paths are rejected
- `..` traversal is rejected
- Symlinks are resolved and verified to stay within bounds
- Namespace names are validated (alphanumeric, hyphens, underscores only)

**What this prevents:**
- Reading `/etc/passwd` via `?path=../../../etc/passwd`
- Escaping a namespace into another namespace
- Following a symlink that points outside the mount

## Request Limits

| Resource | Limit |
|---|---|
| Note content (create/update) | 10 MB |
| File upload | 32 MB |
| Search results | 30 per query (configurable) |
| JWT expiry | 24 hours |

## Recommendations

1. **Change default credentials immediately** after first run (Settings > Credentials)
2. **Use Tailscale** for remote access instead of opening ports
3. **Use API tokens** for MCP and scripts -- don't share your login password
4. **Revoke tokens** you no longer use (Settings > API Tokens)
5. **Keep Docker updated** -- the backend runs in a minimal Alpine container

## What mdnest does NOT do

- No rate limiting on login (rely on network isolation instead)
- No encryption at rest (files are plain markdown on disk -- encrypt the disk if needed)
- No audit logging (single-user app, no need)
- No multi-factor authentication (single-user, protected by network layer)

These are intentional trade-offs for a private, single-user app. The network layer (localhost + Tailscale) is the primary security boundary.
