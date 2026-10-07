# mdnest API Reference

All endpoints are served under the `/api` prefix. Unless noted otherwise, every endpoint requires an `Authorization: Bearer <token>` header obtained from the login endpoint.

As of **v3.10.0**, the auth middleware also accepts the token via a `?token=<JWT>` query parameter on GET requests. This is intended for browser elements that can't set a custom request header — `<img src=…>` for uploaded images, future `<a href=…>` for downloads — and accepts both JWT and `mdnest_…` API tokens. The Authorization header still takes precedence when both are present.

All error responses return JSON with an `error` field:

```json
{"error": "description of the problem"}
```

Common HTTP status codes across all endpoints:

| Status | Meaning |
|--------|---------|
| 400 | Bad request -- missing or invalid parameters, malformed body |
| 401 | Unauthorized -- missing, invalid, or expired JWT token |
| 404 | Not found -- namespace, file, or folder does not exist |
| 405 | Method not allowed -- wrong HTTP method for the endpoint |
| 409 | Conflict -- resource already exists (e.g., creating a note that already exists) |
| 500 | Internal server error |

---

## Authentication

### POST /api/auth/login

Authenticate with username and password (local mode), or post a Firebase ID token (Firebase mode). In SSO mode the web UI does not use this endpoint — use `/api/auth/sso/start` instead — and with `SSO_DISABLE_PASSWORD_LOGIN=true` it refuses username/password outright. Returns a JWT valid for 30 days.

This is the only endpoint that does **not** require the `Authorization` header.

**Request body** (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | yes | Login username |
| `password` | string | yes | Login password |

**Response** (200 OK):

```json
{"token": "eyJhbGciOiJIUzI1NiIs..."}
```

**Example:**

```bash
curl -X POST http://localhost:8286/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "changeme"}'
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid request body"}` | Malformed or missing JSON body |
| 401 | `{"error":"invalid credentials"}` | Wrong username or password |
| 403 | `{"error":"password login is disabled on this server; sign in with SSO or use an API token"}` | `USER_PROVIDER=sso` with `SSO_DISABLE_PASSWORD_LOGIN=true` (sent for right and wrong passwords alike) |

---

### POST /api/auth/change-password

Change the current user's password. Requires authentication.

**Request body:**

```json
{
  "current_password": "old-password",
  "new_password": "new-password"
}
```

**Response** (200 OK):

```json
{"status": "password changed"}
```

**Example:**

```bash
curl -X POST "http://localhost:8286/api/auth/change-password" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"current_password": "oldpass", "new_password": "newpass"}'
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"new password is required"}` | Empty new password |
| 401 | `{"error":"current password is incorrect"}` | Wrong current password |

---

### Two-Factor Authentication (2FA)

#### POST /api/auth/totp/setup
Generate TOTP secret and QR code. Requires authentication.

**Response:** `{ secret, qrCode, url, recoveryCodes }`

#### POST /api/auth/totp/verify-setup
Verify the first TOTP code and enable 2FA. Requires authentication.

**Body:** `{ "code": "123456" }`

#### POST /api/auth/totp/disable
Disable 2FA. Requires password confirmation.

**Body:** `{ "password": "current_password" }`

#### POST /api/auth/verify-totp
Verify TOTP code during login (uses temp token, no auth required).

**Body:** `{ "tempToken": "...", "code": "123456" }`
**Response:** `{ "token": "jwt..." }`

#### POST /api/auth/totp/setup-with-temp
Forced 2FA setup during login. Without `code`: returns QR + secret. With `code`: verifies and returns JWT.

**Body:** `{ "tempToken": "...", "code": "" }` or `{ "tempToken": "...", "code": "123456" }`

#### POST /api/auth/change-password-forced
Change password during first login (uses temp token, no auth required).

**Body:** `{ "tempToken": "...", "newPassword": "new_pass" }`

#### POST /api/admin/reset-2fa
Admin: reset a user's 2FA. Requires admin role.

**Body:** `{ "userId": 5 }`

---

### Corporate SSO (USER_PROVIDER=sso)

Both endpoints are only mounted when `USER_PROVIDER=sso` is set and the OIDC client initializes successfully at startup. Under any other configuration they return 404. See `docs/sso-setup.md` for the operator checklist.

#### GET /api/auth/sso/start
Kicks off the OIDC authorization-code + PKCE flow. Generates CSRF state, OIDC nonce, and the PKCE verifier; packs them into a short-lived HMAC-signed cookie; returns a 302 to the IdP's authorize URL.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `from` | Optional absolute path on this origin (e.g. `/growth/foo.md`) — where to land after a successful sign-in. Anything with a scheme, host, or query string is rejected and replaced with `/` to prevent open-redirect abuse. |

**Response:** 302 redirect to the IdP, with `Set-Cookie: mdnest_sso_state=...; HttpOnly; SameSite=Lax; Max-Age=600`.

#### GET /api/auth/sso/callback
The IdP redirects the browser here after the user authenticates. The backend verifies the state cookie, exchanges the code with PKCE, verifies the ID token, checks the email against the local `users` table, and mints the same JWT the classic password flow issues.

**Query parameters (sent by the IdP):** `state`, `code`, or `error` on failure.

**Response:** 302 redirect back to the frontend. On success:

```
Location: <FRONTEND_ORIGIN>/<from>#sso_token=<jwt>
```

On failure:

```
Location: <FRONTEND_ORIGIN>/#sso_error=<code>
```

| Error code | Meaning |
|------------|---------|
| `sso_denied:<reason>` | IdP rejected the sign-in (user cancelled, scope not approved). |
| `sso_failed` | State cookie expired, code exchange failed, or ID token verification failed. |
| `sso_not_invited` | IdP authenticated the user, but no mdnest row matches their email. |
| `sso_blocked` | User row exists but `blocked=true`. |
| `sso_internal` | Backend error during user lookup or JWT signing. |

The frontend consumes the fragment on load (`localStorage.setItem('mdnest_token', …)`), strips the hash, and proceeds normally. 2FA is not prompted in SSO mode — the IdP owns MFA.

---

### API Tokens: /api/auth/tokens

Manage long-lived API tokens for CLI and MCP access. Tokens are prefixed with `mdnest_` and stored as SHA-256 hashes.

#### GET /api/auth/tokens

List all API tokens (without the token values).

**Response** (200 OK):

```json
[
  {"id": "a1b2c3d4", "name": "my-laptop", "created_at": "2026-03-20T10:00:00Z"},
  {"id": "e5f6g7h8", "name": "mcp-server", "created_at": "2026-03-21T15:30:00Z"}
]
```

#### POST /api/auth/tokens

Create a new API token. The token value is only returned once — save it immediately.

**Request body:**

```json
{"name": "my-laptop"}
```

**Response** (201 Created):

```json
{
  "id": "a1b2c3d4",
  "name": "my-laptop",
  "token": "mdnest_abc123...",
  "created_at": "2026-03-20T10:00:00Z"
}
```

#### DELETE /api/auth/tokens?id=\<token-id\>

Revoke an API token.

**Response** (200 OK):

```json
{"status": "revoked"}
```

**Examples:**

```bash
# List tokens
curl "http://localhost:8286/api/auth/tokens" -H "Authorization: Bearer $TOKEN"

# Create a token
curl -X POST "http://localhost:8286/api/auth/tokens" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-laptop"}'

# Revoke a token
curl -X DELETE "http://localhost:8286/api/auth/tokens?id=a1b2c3d4" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Server restart *(v4.8.2+)*

### POST /api/admin/restart

Restarts the backend, the same as **Settings > Server > Restart server**.
Superadmin only in multi-user mode (others get 403); in single-user mode the
signed-in user owns the server and may restart it.

The response comes first (`202 {"status":"restarting"}`). The backend then
stops taking requests, finishes the ones in flight (up to 15 seconds), commits
pending edits when `STORAGE_BACKEND=git`, and starts itself again in place. It
needs no restart policy from Docker or Kubernetes. Repeated calls while it is
restarting start one restart.

A restart keeps the container's mounts and environment, which Docker fixes when
the container is created. To apply a change to `docker-compose.yml` or `.env`,
run `docker compose up -d` on the server instead.

To know when the new process is up, read `bootId` from `GET /api/config`
before restarting and poll until it changes:

```bash
curl -X POST http://localhost:8286/api/admin/restart -H "Authorization: Bearer $TOKEN"
```

---

## Admin (multi-user mode only)

These endpoints are only available when `AUTH_MODE=multi`. All require an admin role (`superadmin` or `admin`) — collaborators receive a 403.

**v3.5.0 role hierarchy:** `superadmin` (global), `admin` (namespace-scoped via the `namespace_admins` table), `collaborator` (grants only). Endpoints below indicate which role is required and how the response is filtered for namespace admins.

### POST /api/admin/invite

Create a new user. Available to any admin role; the `namespace` field is **required for namespace admins** (the new user is auto-granted `permission='write'` on `/` of that namespace; if `role='admin'` is also passed, the new user is added to `namespace_admins` for that ns). SuperAdmin can omit `namespace` and grant access separately.

**Request body** (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | yes | User's email (must be unique) |
| `username` | string | yes | Login username (must be unique) |
| `password` | string | yes | Initial password |
| `role` | string | no | `superadmin`, `admin`, or `collaborator` (default: `collaborator`). Only SuperAdmin can invite a SuperAdmin. |
| `namespace` | string | required for namespace admins | The namespace the new user is granted access to. Caller must admin this namespace. |

**Response** (201 Created):

```json
{
  "id": 2,
  "email": "bob@example.com",
  "username": "bob",
  "role": "collaborator",
  "invited_by": 1,
  "created_at": "2026-03-28T12:00:00Z"
}
```

**Example:**

```bash
curl -X POST "http://localhost:8286/api/admin/invite" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "bob@example.com", "username": "bob", "password": "securepass", "role": "collaborator", "namespace": "growth"}'
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"email, username, and password are required"}` | Missing fields |
| 400 | `{"error":"role must be superadmin, admin, or collaborator"}` | Invalid role |
| 400 | `{"error":"namespace is required when inviting as a namespace admin"}` | Non-superadmin caller didn't pass namespace |
| 403 | `{"error":"admin access required"}` | Collaborator caller |
| 403 | `{"error":"only superadmin can invite a superadmin"}` | Non-superadmin tried to mint a superadmin |
| 403 | `{"error":"you don't admin that namespace"}` | Caller is not an admin of the target namespace |
| 409 | `{"error":"email already in use"}` | Duplicate email |
| 409 | `{"error":"username already in use"}` | Duplicate username |

---

### GET /api/admin/users

List users. Available to any admin role; **the result is filtered by caller scope**: SuperAdmin sees all; namespace admin sees only users with grants or `namespace_admins` entries on namespaces they administer (plus self).

**Response** (200 OK):

```json
[
  {"id": 1, "email": "admin@mdnest.local", "username": "admin", "role": "superadmin", "created_at": "2026-03-28T10:00:00Z"},
  {"id": 2, "email": "bob@example.com", "username": "bob", "role": "collaborator", "invited_by": 1, "created_at": "2026-03-28T12:00:00Z"}
]
```

---

### PUT /api/admin/users?id=\<user-id\> *(SuperAdmin only)*

Update a user's global role. The new role must be one of `superadmin`, `admin`, or `collaborator`. Setting `admin` here only flips the global role string — to actually grant administrative power on a namespace, use `POST /api/admin/namespace-admins` instead.

**Request body:**

```json
{"role": "admin"}
```

**Response** (200 OK):

```json
{"status": "ok"}
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"role must be superadmin, admin, or collaborator"}` | Invalid role |
| 400 | `{"error":"cannot remove the last superadmin"}` | Demoting the only superadmin |
| 403 | `{"error":"superadmin access required"}` | Non-superadmin caller |

---

### DELETE /api/admin/users?id=\<user-id\> *(SuperAdmin only)*

Delete a user. Access grants and `namespace_admins` rows are cascade-deleted.

**Response** (200 OK):

```json
{"status": "deleted"}
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"cannot delete yourself"}` | Attempting self-deletion |
| 400 | `{"error":"cannot remove the last superadmin"}` | Deleting the only superadmin |
| 403 | `{"error":"superadmin access required"}` | Non-superadmin caller |
| 404 | `{"error":"user not found"}` | User ID does not exist |

**Examples:**

```bash
# List users (filtered for namespace admins)
curl "http://localhost:8286/api/admin/users" -H "Authorization: Bearer $TOKEN"

# Change role (superadmin only)
curl -X PUT "http://localhost:8286/api/admin/users?id=2" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# Delete user (superadmin only)
curl -X DELETE "http://localhost:8286/api/admin/users?id=2" \
  -H "Authorization: Bearer $TOKEN"
```

---

### POST /api/admin/reset-password *(SuperAdmin only, v3.6.0+)*

Reset another user's password. The new password is written immediately and `must_change_password` is set so the target is forced to pick their own on next login.

**Resetting another superadmin's password is rejected** (403). That's a lateral-escalation primitive — one compromised superadmin could lock out the others. The legitimate recovery path is the host-side `mdnest-server reset-password` CLI, which requires shell access on the server.

Available only when `USER_PROVIDER=local`. Federated providers reject the call (the IdP owns identity).

**Request body:**

```json
{"user_id": 7, "new_password": "temp-Hk7p2Q9x"}
```

**Response** (200 OK):

```json
{"status": "ok"}
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"user_id and new_password are required"}` | Missing field |
| 400 | `{"error":"password reset is not available — identity is owned by your IdP"}` | `USER_PROVIDER` is `firebase` or `sso` |
| 403 | `{"error":"superadmin access required"}` | Caller is not a superadmin |
| 403 | `{"error":"cannot reset another superadmin's password from the UI — use the mdnest-server reset-password CLI on the host"}` | Target's role is `superadmin` |
| 404 | `{"error":"user not found"}` | `user_id` does not exist |

**Example:**

```bash
curl -X POST "http://localhost:8286/api/admin/reset-password" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": 7, "new_password": "temp-Hk7p2Q9x"}'
```

---

### Namespace Admin assignments *(v3.5.0+)*

The new `namespace_admins` table maps users to the namespaces they can administer. Three endpoints manage it.

#### GET /api/admin/namespace-admins?ns=\<namespace\>

List the admins of a namespace. Caller must admin the namespace (or be SuperAdmin).

**Response** (200 OK):

```json
[
  {
    "user_id": 20,
    "username": "farooq",
    "email": "farooq@example.com",
    "namespace": "growth",
    "granted_by": 19,
    "created_at": "2026-04-27T11:38:26Z"
  }
]
```

#### POST /api/admin/namespace-admins

Promote a user to admin of a namespace. Caller must already admin the namespace (or be SuperAdmin). Side effects: the target's `users.role` is bumped to `admin` if currently `collaborator`; an `access_grants` row with `permission='write'` on `path='/'` is created if one doesn't already exist (so the new admin can actually open the notes they administer). Idempotent — re-running on an existing pair returns `{"status":"ok"}` without changes.

**Request body:**

```json
{"user_id": 20, "namespace": "growth"}
```

**Response** (201 Created):

```json
{"status": "ok"}
```

#### DELETE /api/admin/namespace-admins?user_id=\<id\>&ns=\<namespace\>

Demote. Removes the `namespace_admins` row. If the user has no other rows after the delete, their `users.role` is reverted to `collaborator`. The auto-created write grant is **left in place** — operators who want to remove that access too should `DELETE /api/admin/grants?id=…` separately.

**Response** (200 OK):

```json
{"status": "deleted"}
```

---

---

### POST /api/admin/grants

Create an access grant for a user on a namespace or directory.

**Request body** (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | int | yes | User ID to grant access to |
| `namespace` | string | yes | Namespace name |
| `path` | string | no | Path within namespace (`/` = full namespace, default) |
| `permission` | string | no | `read` or `write` (default: `write`) |

**Response** (201 Created):

```json
{
  "id": 1,
  "user_id": 2,
  "namespace": "work",
  "path": "/",
  "permission": "write",
  "granted_by": 1,
  "created_at": "2026-03-28T12:00:00Z"
}
```

**Access rules:**
- Grant on `/` covers the entire namespace
- Grant on `/subdir` covers that directory and everything below it
- `write` permission implies `read`
- Admins have implicit full access (no grants needed)

---

### GET /api/admin/grants

List grants filtered by user or namespace.

**Query parameters** (one required):

| Param | Description |
|-------|-------------|
| `user_id` | List all grants for a user |
| `namespace` | List all grants for a namespace |

**Response** (200 OK):

```json
[
  {"id": 1, "user_id": 2, "namespace": "work", "path": "/", "permission": "write", "granted_by": 1, "created_at": "2026-03-28T12:00:00Z"}
]
```

---

### DELETE /api/admin/grants?id=\<grant-id\>

Revoke an access grant.

**Response** (200 OK):

```json
{"status": "deleted"}
```

**Examples:**

```bash
# Grant user 2 write access to the entire 'work' namespace
curl -X POST "http://localhost:8286/api/admin/grants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": 2, "namespace": "work", "path": "/", "permission": "write"}'

# Grant user 2 read-only access to 'work/docs'
curl -X POST "http://localhost:8286/api/admin/grants" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": 2, "namespace": "work", "path": "/docs", "permission": "read"}'

# List grants for user 2
curl "http://localhost:8286/api/admin/grants?user_id=2" \
  -H "Authorization: Bearer $TOKEN"

# Revoke a grant
curl -X DELETE "http://localhost:8286/api/admin/grants?id=1" \
  -H "Authorization: Bearer $TOKEN"
```

---

### GET /api/me

Returns the current user's profile, role, access grants, and (v3.5.0+) the namespaces they administer. Requires authentication (any role).

**Response** (200 OK):

```json
{
  "id": 2,
  "email": "bob@example.com",
  "username": "bob",
  "avatar_url": "https://lh3.googleusercontent.com/a/...",
  "role": "admin",
  "created_at": "2026-03-28T12:00:00Z",
  "grants": [
    {"id": 1, "namespace": "growth", "path": "/", "permission": "write"}
  ],
  "is_super_admin": false,
  "admin_namespaces": ["growth"]
}
```

- `role` is one of `superadmin`, `admin`, or `collaborator` (v3.5.0+).
- `is_super_admin` is `true` only for the global `superadmin` role.
- `admin_namespaces` is the list of namespaces this user administers (always empty for `superadmin` and `collaborator`; `superadmin`'s authority is global, not stored as namespace_admins rows).
- `avatar_url` is populated from the IdP's `picture` OIDC claim on every SSO login (see `docs/sso-setup.md`). Omitted from the JSON response when empty.

---

## Preferences *(v4.3.0+)*

### GET /api/preferences

Returns the calling user's stored UI preferences. Requires authentication (any role). Available in **both** auth modes — unlike `/api/me`, which needs a user store and so does not exist in single mode.

**Response** (200 OK):

```json
{"theme": "light"}
```

A user who has never set a preference gets `{}`. The frontend then falls back to `defaultTheme` from `/api/config`, and to the OS setting when that is `auto`.

---

### PATCH /api/preferences

Merges the supplied keys into the caller's preferences and returns the merged result. `PATCH`, not `PUT`: the client sends only what changed, so one setting written in another tab is not wiped by a change here.

**Request:**

```json
{"theme": "dark"}
```

**Response** (200 OK) — the full merged state:

```json
{"theme": "dark"}
```

**Errors:**

- `400` — unknown key, a value longer than its key allows (64 bytes for `theme`, 4096 for `chat_pins`), an empty object, or a body that is not a JSON object. The whole request is rejected rather than the valid subset stored, so a `200` never means "some of what you sent was saved".

**Supported keys:**

| Key | Values | Meaning |
|---|---|---|
| `theme` | `auto` \| `dark` \| `light` | Colour theme. Overrides the server's `DEFAULT_THEME`. |
| `chat_pins` | JSON array of `"namespace/path"` strings, as a string | The chats pinned in the chat list, newest first. Saved whole, so the web UI only writes it after a successful read. |

Preferences are stored server-side — Postgres (`user_preferences`) in multi mode, `preferences.json` in the secrets volume in single mode — so a theme follows the person across browsers and devices rather than living in one browser's local storage. The key set is an allowlist: this endpoint is writable by any authenticated user, so an open bag would be a per-user blob store anyone could fill.

---

## Stickies *(v4.5.0+)*

A per-user sticky board — a handful of short personal notes kept beside the workspace. Each card is a title, some free text, and a checklist, all optional: "done" lives on the checklist item rather than the card, because a card-level flag forces "buy milk, call bank, post form" to be either three separate notes or one note you can only tick when all of it is finished. Stickies are **not notes**: they never appear in a namespace, never reach a git remote, and are never shared. Available in **both** auth modes.

The board is addressed only by the authenticated identity. There is no user id, path or namespace parameter, so one user reading another user's board is not a check that can be forgotten — it is not expressible.

### GET /api/stickies

Returns the calling user's board. Requires authentication (any role).

**Response** (200 OK):

```json
{
  "stickies": [
    {
      "id": "s-1736179200000-a4f2",
      "title": "Errands",
      "body": "before Friday",
      "items": [
        {"id": "i1", "text": "buy milk", "done": false},
        {"id": "i2", "text": "call bank", "done": true}
      ],
      "color": "yellow",
      "x": 246,
      "y": 18,
      "created_at": 1736179200,
      "updated_at": 1736179200
    }
  ]
}
```

A user who has never saved a board gets `{"stickies": []}` — an empty array, not a `404`.

---

### PUT /api/stickies

Replaces the whole board and returns what was stored. There is no per-card `POST`/`PATCH`/`DELETE`: the client owns the array and sends it whole, so a delete is a `PUT` without that card. Last write wins — two tabs editing one board belong to the same person, so no `If-Match` dance.

**Request:**

```json
{"stickies": [{"id": "s-1", "title": "Errands", "body": "", "items": [{"id": "i1", "text": "buy milk", "done": false}], "color": "blue"}]}
```

**Response** (200 OK) — the stored board, in the same shape as `GET`.

**Errors:**

- `400` — more than 200 stickies, a card body over 4 KB, a card id over 64 bytes, a missing or duplicate id, a colour outside the enum, a title over 200 bytes, more than 50 checklist items, a checklist item over 500 bytes or with a missing/duplicate id, a position outside `0`–`20000` or a width outside `150`–`600` (or NaN/Infinity in either), a board over 256 KB once marshalled, or a body that is not JSON. The message names the specific limit. Nothing is stored on a rejection: the previous board is left exactly as it was, so a `400` never means "part of what you sent was saved".

**Fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Client-generated, unique within the board, ≤ 64 bytes. Required. |
| `title` | string | ≤ 200 bytes. Optional. |
| `body` | string | ≤ 4096 bytes. Plain text — not rendered as markdown. Optional. |
| `items` | array | The card's checklist: `{id, text, done}`, at most 50, each `text` ≤ 500 bytes. Ids must be present and unique **within the card**. Always serialised as an array, never `null`. Optional (an empty checklist is a plain note). |
| `color` | string | One of `yellow`, `pink`, `blue`, `green`, `grey`. Empty defaults to `yellow`; anything else is a `400`. |
| `w` | number \| absent | Card width in pixels, `150`–`600`. **Omitted until the card has been resized**, same convention as `x`/`y` — a stored `0` would be a card resized to nothing. Height is not stored: it follows the content, so a fixed height would clip a card the moment another to-do was added. |
| `x` / `y` | number \| absent | Position on the full-screen board, in board pixels, `0`–`20000`. **Omitted entirely for a card that has never been dragged** — that is not the same as `0`, which is a card deliberately placed in the top-left corner. The client lays unplaced cards out on a grid; only dragging stores a position. `null` is accepted and means the same as absent. NaN and Infinity are a `400`. |
| `created_at` / `updated_at` | int | Unix seconds, client-supplied. Stored as given. |

**Storage and the privacy guarantee.** Boards live in Postgres (`user_stickies`) in multi mode and in `stickies.json` in the **secrets volume** in single mode — the same volume as `auth.json` and `tokens.json`. That location is the entire feature: git-sync walks `/data/notes/*/` and commits what it finds, so nothing under the secrets volume can reach a git remote, and because it is a *declared* named volume rather than part of the image's writable layer, a board also survives `./mdnest-server rebuild`. There is no encryption, deliberately — it would add key-management UX for no gain over the filesystem permissions already in force. The tradeoff to state plainly: **stickies are not backed up anywhere.** Content worth keeping belongs in a real note.

---

### GET /api/admin/sync-status?ns=\<namespace\>

Report git-sync state for a namespace. Works in single mode (no user context → allowed) and multi mode (superadmin, or an admin of that namespace). Returns the repo/remote facts plus — when the git-sync daemon is running — its self-reported health, read from a git-excluded `.mdnest-sync-status.json` the daemon writes each cycle.

```json
{
  "isGitRepo": true,
  "hasRemote": true,
  "remoteUrl": "git@github.com:you/notes.git",
  "branch": "main",
  "lastCommit": "2026-07-02 16:53:09 +0000",
  "hasSSHKey": true,
  "daemonState": "ok",
  "daemonMessage": "",
  "daemonUpdated": "2026-07-02T16:53:00Z",
  "ahead": 0,
  "behind": 0
}
```

- `daemonState` — `ok`, `error`, or `local-only` (committed locally, no remote/key). Absent if the daemon hasn't written a status yet.
- `daemonMessage` — human-readable reason when `daemonState` is `error` (e.g. "diverged from upstream (not fast-forward)").
- `ahead` / `behind` — commit counts vs the upstream at the daemon's last cycle.

The sidebar polls this every 60s and shows a red ✕ + **Retry** when `daemonState` is `error`, so a wedged background sync is visible instead of silent (v3.11.4+).

### POST /api/admin/sync?ns=\<namespace\>

Trigger an immediate sync for a namespace (commit pending changes, pull `--ff-only`, push). Same auth as `sync-status`. This is what the sidebar **Retry** / **Sync** button calls.

---

## Search

### GET /api/search

Search notes by filename and content within a namespace. Returns filename matches first, then content matches with line numbers and snippets.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `q` | yes | Search query (case-insensitive) |

**Response** (200 OK):

```json
[
  {"path": "ideas/search-feature.md", "line": 0, "snippet": "filename match"},
  {"path": "notes/meeting.md", "line": 15, "snippet": "We discussed the search feature and decided to..."}
]
```

- `line: 0` = filename match; `line: N` = content match at line N
- Snippets are truncated at 200 characters

**Example:**

```bash
curl "http://localhost:8286/api/search?ns=personal&q=meeting" \
  -H "Authorization: Bearer $TOKEN"
```

**Tuning** (via `mdnest.conf`):

| Setting | Default | Description |
|---------|---------|-------------|
| `SEARCH_MAX_RESULTS` | 30 | Max results per query |
| `SEARCH_MAX_FILE_SIZE` | 1048576 | Skip files larger than this (bytes) |
| `SEARCH_WORKERS` | 8 | Parallel file readers |
| `SEARCH_CACHE_TTL` | 30 | File list cache lifetime (seconds) |

---

## Namespaces

### GET /api/namespaces

List all available namespaces. A namespace corresponds to a mounted directory (a top-level subdirectory inside `NOTES_DIR`).

**Query parameters:** none

**Response** (200 OK):

```json
["personal", "work"]
```

Returns a sorted JSON array of namespace name strings. Hidden directories (those starting with `.`) are excluded.

**`?detail=1`** *(v4.7.0+)* returns the same namespaces with the caller's access at each namespace's root, computed with the same checks the routes use. The move/copy picker uses it to decide which namespaces to offer. A grant scoped to a folder below the root shows `false` here; a transfer dry run (below) has the final word for a specific folder. The plain form is unchanged.

```json
[{"name": "personal", "canRead": true, "canWrite": true},
 {"name": "shared", "canRead": true, "canWrite": false}]
```

**Example:**

```bash
TOKEN="eyJhbGciOiJIUzI1NiIs..."

curl http://localhost:8286/api/namespaces \
  -H "Authorization: Bearer $TOKEN"
```

---

## Tree

### GET /api/tree

Retrieve the full directory tree for a namespace.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |

**Response** (200 OK):

```json
{
  "name": "root",
  "type": "folder",
  "path": "",
  "children": [
    {
      "name": "guides",
      "type": "folder",
      "path": "guides",
      "children": [
        {
          "name": "getting-started.md",
          "type": "file",
          "path": "guides/getting-started.md"
        }
      ]
    },
    {
      "name": "todo.md",
      "type": "file",
      "path": "todo.md"
    }
  ]
}
```

Folders are sorted before files. Within each group, items are sorted alphabetically (case-insensitive). Hidden files and directories (names starting with `.`) are excluded.

**Example:**

```bash
curl "http://localhost:8286/api/tree?ns=personal" \
  -H "Authorization: Bearer $TOKEN"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"ns parameter is required"}` | Missing `ns` query parameter |
| 404 | `{"error":"namespace not found"}` | Namespace directory does not exist |

---

## Notes

All note endpoints use the same URL path with different HTTP methods.

### GET /api/note

Read the contents of a note.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the file within the namespace |

**Response** (200 OK):

Returns the raw file content with `Content-Type: text/markdown; charset=utf-8`.

```
# My Note

Some content here.
```

**Example:**

```bash
curl "http://localhost:8286/api/note?ns=personal&path=todo.md" \
  -H "Authorization: Bearer $TOKEN"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |
| 404 | `{"error":"not found"}` | File does not exist |

---

### POST /api/note

Create a new note. Fails if the file already exists.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path for the new file |

**Request body:** Raw text content for the note (can be empty).

Any `<!-- mdnest:<uuid> -->` note-ID marker in the body is removed *(v4.6.2+)*. The marker is a note's identity, and it names the note's comment thread, so a new note never takes one from its content. It gets its own ID the first time one is needed. To keep a note's ID, edit it with `PUT`, which preserves it.

**Response** (201 Created):

```json
{"status": "created"}
```

Parent directories are created automatically if they do not exist.

**Example:**

```bash
curl -X POST "http://localhost:8286/api/note?ns=personal&path=journal/2025-01-15.md" \
  -H "Authorization: Bearer $TOKEN" \
  -d "# January 15

Today I started using mdnest."
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |
| 409 | `{"error":"file already exists"}` | A file already exists at that path |

---

### PUT /api/note

Update an existing note. Fails if the file does not exist.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the file |
| `allow-empty` | no | Set to `1` to permit overwriting a non-empty file with empty content. Without this, the backend returns 409 to defend against destructive autosave (v3.6.1+). |
| `restore-from` | no | A 7-40 char hex commit SHA. When set, the request is treated as a deliberate version restore and the websocket `file-changed` broadcast carries `reason: "restored"` so other connected users see an info banner instead of the conflict banner (v3.7.0+). |

**Request body:** The new file content (replaces the entire file).

**Headers:** Optional `If-Match: <etag>` enforces optimistic concurrency — a stale ETag returns 409 with the current ETag in the response.

**Response** (200 OK):

```json
{"status": "ok", "etag": "\"<sha256>\""}
```

**Example:**

```bash
curl -X PUT "http://localhost:8286/api/note?ns=personal&path=todo.md" \
  -H "Authorization: Bearer $TOKEN" \
  -d "# Todo

- [x] Set up mdnest
- [ ] Write documentation"

# Restore a file to an old version (also re-broadcasts as a restore event):
curl -X PUT "http://localhost:8286/api/note?ns=personal&path=todo.md&restore-from=a1b2c3d" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @old-version.md
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |
| 404 | `{"error":"not found"}` | File does not exist |
| 409 | `{"error":"refusing to overwrite a non-empty note with empty content; pass ?allow-empty=1 to confirm"}` | v3.6.1+ guard against destructive autosave |
| 409 | `{"error":"file was modified by another user", "etag":"..."}` | If-Match ETag is stale |

---

### GET /api/note/history *(v3.7.0+)*

Return up to 50 most recent commits affecting the given file, newest first. Reads from the namespace's git-sync repository (`.git/` in the namespace directory). Works in single mode and multi mode identically; the only requirement is that git-sync is configured for the namespace.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the file |

**Response** (200 OK):

```json
[
  {"commit": "a1b2c3d4...", "unix_ts": 1714567890, "author": "Alice", "message": "sync: 2026-05-03 10:42:13 UTC"},
  {"commit": "e5f6789a...", "unix_ts": 1714560000, "author": "Bob", "message": "Edit"}
]
```

Returns an empty array when the namespace is a git repo but no commits have touched the file yet.

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path traversal or empty path |
| 404 | `{"error":"namespace not found"}` | Namespace doesn't exist |
| 404 | `{"error":"git-sync is not configured for this namespace"}` | Namespace dir has no `.git/` |

---

### GET /api/note/at *(v3.7.0+)*

Return the file's content as it was at a specific commit. Read-only; the response carries no ETag (history is a snapshot, not editable through this endpoint — restoration goes through `PUT /api/note?restore-from=<sha>`).

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the file |
| `ref` | yes | A 7-40 char hex commit SHA. Branch names, `HEAD~N`, tags, and other ref forms are rejected. |

**Response** (200 OK): The file's content at that commit, as `text/markdown; charset=utf-8`. The mdnest invisible note-ID marker is stripped (matching `GET /api/note` behaviour).

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid ref — must be a commit SHA"}` | `ref` doesn't match `^[0-9a-f]{7,40}$` |
| 404 | `{"error":"file not found at that commit"}` | The path didn't exist at that commit, or the SHA is unknown |
| 404 | `{"error":"git-sync is not configured for this namespace"}` | Namespace dir has no `.git/` |

---

### PATCH /api/note

Append or prepend text to a note. Creates the file if it doesn't exist.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the note |
| `position` | no | `top` (prepend) or `bottom` (append, default) |

**Request body:** Plain text to append/prepend. As with `POST`, any note-ID marker in the text is removed *(v4.6.2+)*; the note's own marker is untouched.

**Response** (200 OK):

```json
{"status": "ok"}
```

**Examples:**

```bash
# Append text to a note
curl -X PATCH "http://localhost:8286/api/note?ns=personal&path=log.md&position=bottom" \
  -H "Authorization: Bearer $TOKEN" \
  -d "## $(date) - New entry"

# Prepend text to the top of a note
curl -X PATCH "http://localhost:8286/api/note?ns=personal&path=log.md&position=top" \
  -H "Authorization: Bearer $TOKEN" \
  -d "# Important update"

# Append to a file that doesn't exist yet (creates it)
curl -X PATCH "http://localhost:8286/api/note?ns=personal&path=new-log.md" \
  -H "Authorization: Bearer $TOKEN" \
  -d "First entry"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |
| 400 | `{"error":"position must be top or bottom"}` | Invalid position value |

---

### DELETE /api/note

Delete a note or folder. If the path points to a directory, it and all its contents are removed recursively.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the file or folder |

**Response** (200 OK):

```json
{"status": "deleted"}
```

**Example:**

```bash
# Delete a single note
curl -X DELETE "http://localhost:8286/api/note?ns=personal&path=old-note.md" \
  -H "Authorization: Bearer $TOKEN"

# Delete an entire folder
curl -X DELETE "http://localhost:8286/api/note?ns=personal&path=archive/2023" \
  -H "Authorization: Bearer $TOKEN"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |
| 404 | `{"error":"not found"}` | File or folder does not exist |

---

## Folders

### POST /api/folder

Create a new folder. Parent directories are created automatically.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path for the new folder |

**Request body:** None.

**Response** (201 Created):

```json
{"status": "created"}
```

**Example:**

```bash
curl -X POST "http://localhost:8286/api/folder?ns=personal&path=projects/mdnest" \
  -H "Authorization: Bearer $TOKEN"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |

---

## Upload

### POST /api/upload

Upload a file (typically an image) as a multipart form. The file is saved in the same directory as the note referenced by `path`.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the note the upload is associated with |

**Request body:** `multipart/form-data` with a `file` field. Maximum upload size is 32 MB.

**Response** (200 OK):

```json
{"url": "journal/screenshot.png"}
```

The `url` field contains the relative path of the uploaded file within the namespace. Use this path with the file serving endpoint to reference the image in your notes.

**Example:**

```bash
curl -X POST "http://localhost:8286/api/upload?ns=personal&path=journal/2025-01-15.md" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@screenshot.png"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"missing file field"}` | No `file` field in the multipart form |
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |
| 400 | `{"error":"invalid upload destination"}` | Destination path resolves outside namespace |

---

## Move

### POST /api/move

Move a file or folder from one location to another within the same namespace.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `from` | yes | Current relative path of the file or folder |
| `to` | yes | Destination relative path |

**Response** (200 OK):

```json
{"status": "moved"}
```

The destination's parent directories are created automatically if they do not exist.

**Example:**

```bash
# Move a note
curl -X POST "http://localhost:8286/api/move?ns=personal&from=todo.md&to=archive/todo.md" \
  -H "Authorization: Bearer $TOKEN"

# Move a folder
curl -X POST "http://localhost:8286/api/move?ns=personal&from=drafts&to=archive/drafts" \
  -H "Authorization: Bearer $TOKEN"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid source path"}` | Source path is empty or attempts directory traversal |
| 400 | `{"error":"invalid destination path"}` | Destination path is empty or attempts directory traversal |
| 404 | `{"error":"source not found"}` | Source file or folder does not exist |

---

## Transfer *(v4.7.0+)*

### POST /api/transfer

Move or copy a file or folder to another namespace, or to another place in the same namespace.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `dryRun` | no | `1` runs every check and returns exactly what the real call would, writing nothing |

**Request body:**

```json
{"mode": "move", "from": {"ns": "personal", "path": "Notes/x.md"}, "to": {"ns": "shared", "path": "Project/x.md"}}
```

`mode` is `move` or `copy`. `to.path` is the full destination path including the name, so moving and renaming is one call.

**Access** is checked in the handler for both sides, because the request names two namespaces. A copy needs read on the source; a move needs write on the source (the same as `/api/move`). Both need write on the destination. Grants, group grants and namespace admins all count. An API token gets exactly its user's access.

**What happens:**

- **Never overwrites.** If the destination exists, or a parent of it is a file, the answer is `409` with the colliding path. A folder never merges into an existing one.
- **Copy:** every note gets a fresh ID, and comments are not copied.
- **Move:** every note keeps its ID, and its comment thread (`.mdnest/comments/<uuid>.jsonl`) moves with it. A thread stays where it is, neither copied nor deleted, if a note left behind still carries its ID, if the source namespace is too large to check that (over 5,000 notes), or if the destination already has a thread under that ID. A move never writes into an existing thread. Only lines that are valid comments are carried.
- **Moving between namespaces** never renames across them, since they may be separate mounts with separate git repos. It copies everything, checks the target, and only then deletes the source. A failure before the delete removes the partial target and leaves the source untouched.
- **Same namespace with `move`** is a plain rename, exactly like `/api/move`.
- On a git-backed namespace, each side's next commit names the other side (`moved to shared:Project/x.md` / `moved from personal:Notes/x.md`).
- The search cache and live tree of both namespaces refresh.

**Response** (200 OK):

```json
{"status": "ok", "mode": "copy", "to": {"ns": "shared", "path": "Project/x.md"}, "items": 3, "bytes": 52114, "folder": true}
```

`items` is the number of files carried, `bytes` their total size, and `folder` whether the source is a folder. A dry run returns the same numbers, so a client can say how much a confirm will move. Folders on `to.path` that do not exist yet are created by the transfer, never by a dry run.

**Error responses** (checked in this order, all before anything is written):

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"..."}` | Bad JSON or mode; an invalid path; the namespace root as source or destination; a path inside `.git` or `.mdnest`; the destination equals the source; a folder into itself or a descendant |
| 403 | `{"error":"access denied"}` | Missing access on either side |
| 404 | `{"error":"namespace not found"}` / `{"error":"source not found"}` | |
| 400 | `{"error":"symlink","path":"..."}` | The item, a parent folder, or anything inside it is a symbolic link |
| 409 | `{"error":"exists","path":"Project/x.md"}` | The destination (or a parent that is a file) exists |
| 413 | `{"error":"too_large","files":612,"bytes":146800640,"maxFiles":500,"maxBytes":104857600}` | Over `DOWNLOAD_MAX_FILES` / `DOWNLOAD_MAX_MB`. The server stops counting once a limit is passed; `"partial": true` then marks the counts as lower bounds |
| 429 | `{"error":"busy"}` plus `Retry-After` | The caller already has a transfer running, or `DOWNLOAD_MAX_CONCURRENT` are running server-wide. A dry run is never refused for this |
| 400 | `{"error":"reserved","path":"..."}` | The folder contains a nested `.git` or `.mdnest` |

**Example:**

```bash
curl -X POST "http://localhost:8286/api/transfer?dryRun=1" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"mode":"copy","from":{"ns":"personal","path":"Notes"},"to":{"ns":"shared","path":"Archive/Notes"}}'
```

On `MDNEST_ROLE=app` replicas, the request is forwarded to the writer, which owns the durable tree. Edits still waiting in the durability queue may not have reached the writer yet, so a transfer started within a moment of a save can carry the previous version.

---

## Download *(v4.7.0+)*

### GET /api/download

Download a file, or a folder as a zip.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | no | File or folder; empty means the whole namespace (`<ns>.zip`) |

Access is read on the cleaned `path` (path-scoped, like `GET /api/note`).

- **A file** is sent as an attachment, with range support.
- **A folder** is streamed as `<folder>.zip`. Paths inside start at the folder's name (`Project/sub/note.md`). Hidden files and empty folders are included. `.git/`, `.mdnest/` and symbolic links are left out.
- **Content-Disposition** carries an ASCII `filename=` and, for other names, an RFC 5987 `filename*=UTF-8''...`.

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` / `{"error":"symlink","path":"..."}` | Traversal, a `.git`/`.mdnest` path, or a linked path |
| 403 | `{"error":"access denied"}` | No read access to that path |
| 404 | `{"error":"not found"}` | |
| 413 | same body as transfer (including `"partial"`) | A folder over the limits, refused before any byte is sent |
| 429 | `{"error":"busy"}` plus `Retry-After` | The caller already has a zip download running, or `DOWNLOAD_MAX_CONCURRENT` are running server-wide |

A cancelled download stops at the next read and frees its slots. Folder downloads only are limited and slotted; a single file is served like `/api/files/`.

```bash
curl -OJ "http://localhost:8286/api/download?ns=personal&path=Project" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Access Groups *(v4.2.0+)*

Superadmin-managed named sets whose members are mdnest users and/or IdP (OIDC)
group IDs, carrying namespace grants that mirror per-user grants. A user's
effective access is the **union** of their own grants and the grants of every
group they belong to.

Multi mode only. All three routes are `RequireSuperAdmin`. With no groups defined
and `OIDC_GROUPS_CLAIM` unset, behaviour is identical to before.

| Route | Methods | Purpose |
|---|---|---|
| `/api/admin/groups` | GET, POST, PATCH, DELETE | List / create / rename / delete a group |
| `/api/admin/groups/members` | GET, POST, DELETE | Add or remove a member (a `user_id` **XOR** an `oidc_group` id) |
| `/api/admin/groups/grants` | GET, POST, DELETE | Grant or revoke a namespace/path/permission for a group |

A member row is either a mdnest user or an OIDC group id, never both — enforced
by a database `CHECK`. An OIDC-group member may carry a display label, which is
for the operator's reference only: matching is always on the group id.

**Revocation semantics differ by member kind**, and this matters operationally:
direct user membership is resolved live on every request, so removing a user
takes effect immediately; OIDC-group membership comes from a claim snapshotted
into the session token at login, so a change at the IdP applies at the member's
next sign-in. See `docs/security.md`.

## Attribution *(v4.2.0+)*

### GET /api/note/attribution

Who created a note, who last edited it, and everyone who contributed. Requires
read access to the namespace.

Multi mode only — the route is **not registered** without a database, because a
single-mode install has no user identities to attribute. Backed by the
`note_activity` table (migration `014`), cross-checked against the note's git
history so edits made outside the app are still attributed.

**Query parameters:** `ns`, `path` (both required).

## Marp Themes *(v4.2.0+)*

### GET / PUT / DELETE /api/marp/themes

The centralized Marp theme catalog. Requires `ENABLE_MARP_THEMES=true` on top of
`ENABLE_MARP`; the routes are not registered otherwise.

`GET` is available to any authenticated user (a deck in any namespace has to be
able to resolve its theme). `PUT` and `DELETE` are superadmin-only.

Themes are stored one `<name>.css` per theme in the reserved, hidden
`.marp-themes` namespace, which is excluded from every namespace listing and from
the grant and admin pickers, and is never mirrored to a per-workspace git remote.

## Comments

> **Requires multi-user mode with live collab enabled** (`AUTH_MODE=multi` and `ENABLE_LIVE_COLLAB=true`). The `/api/comments` route is only registered under that combination; in any other mode the endpoints return 404. All endpoints require a valid JWT.

Comments are anchored to notes by an invisible UUID marker (`<!-- mdnest:<uuid> -->`) appended at the end of each note's content. The marker is stripped from the response body on GET and re-injected on PUT, so clients never see it. Comment data lives at `<namespace>/.mdnest/comments/<uuid>.jsonl` — append-only JSONL with soft deletes. Moving or renaming a file preserves its UUID and therefore its comments.

### GET /api/comments

List all active (non-deleted) comments for a note, including both top-level threads and replies.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `ns`   | Namespace name (required) |
| `path` | Note path within the namespace (required) |

**Response:**

```json
[
  {
    "id": "c_a1b2c3d4",
    "parentId": "",
    "authorId": 42,
    "author": "alice",
    "rangeStart": 120,
    "rangeEnd": 145,
    "anchorText": "the selected phrase",
    "body": "What did you mean here?",
    "createdAt": "2026-04-21T10:14:32Z",
    "resolved": false
  },
  {
    "id": "c_e5f6a7b8",
    "parentId": "c_a1b2c3d4",
    "authorId": 7,
    "author": "bob",
    "rangeStart": 120,
    "rangeEnd": 145,
    "anchorText": "the selected phrase",
    "body": "Reworded — better now?",
    "createdAt": "2026-04-21T10:18:05Z",
    "resolved": false
  }
]
```

A comment with a non-empty `parentId` is a reply within the parent's thread.

### POST /api/comments

Create a comment or reply.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `ns`   | Namespace name (required) |
| `path` | Note path within the namespace (required) |

**Request body:**

```json
{
  "parentId": "",
  "rangeStart": 120,
  "rangeEnd": 145,
  "anchorText": "the selected phrase",
  "body": "What did you mean here?"
}
```

- Omit or empty-string `parentId` for a top-level thread.
- Set `parentId` to an existing comment's `id` to post a reply. Replies typically copy the parent's `rangeStart`/`rangeEnd`/`anchorText` so they share an anchor.
- `body` is required.

**Response:** the created comment (201 Created).

### PATCH /api/comments?id=\<comment-id\>

Update a comment — typically to toggle resolved state, optionally to edit the body.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `ns`   | Namespace name (required) |
| `path` | Note path within the namespace (required) |
| `id`   | Comment id (required) |

**Request body (any subset):**

```json
{
  "resolved": true,
  "body": "Updated comment text"
}
```

**Response:** `{"status":"ok"}`.

### DELETE /api/comments?id=\<comment-id\>

Soft-delete a comment. The JSONL file is rewritten with a `deletedAt` timestamp on the matching entry; subsequent GET calls filter it out.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `ns`   | Namespace name (required) |
| `path` | Note path within the namespace (required) |
| `id`   | Comment id (required) |

**Response:** `{"status":"ok"}`.

---

## Task Board

Endpoints backing the [task board](user-guide.md#task-board). Tasks are not
stored separately — they are GFM checkboxes inside notes — so these endpoints
read and rewrite the underlying markdown. The on‑disk format is specified in the
[Task Model](tasks.md).

All routes require read access to the namespace (write for mutations). Mutations
are optimistically concurrent: send the `line`/`raw` you last saw and the server
replies `409 Conflict` if that source line has changed.

### GET /api/tasks

Aggregate the tasks of a namespace (or of a single note).

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `ns`   | Namespace name (required) |
| `path` | Optional. Restrict aggregation to this one note ("this note" view). |

**Response:** `{ "board": <BoardConfig>, "tasks": [<Task>, ...] }`, where a
`Task` carries `id, path, line, raw, text, checked, column` and, when present,
`status, due, priority, workload, assignee, tags[], defaultExpanded, steps[],
notes`, plus the relation lists `dependsOn[], blockedBy[], relatedTo[]` and a
stable `ref` *(v4.2.0+)*. In the cross-namespace view each task also carries
`namespace`.

```bash
curl "http://localhost:8286/api/tasks?ns=work" -H "Authorization: Bearer $TOKEN"
```

**Closing a task with unresolved sub-tasks is refused** *(v4.2.0+)*: checking a
parent done, moving it to a `done` column, or saving an edit into one returns
`422 Unprocessable Entity` with `{"error":"resolve all sub-tasks before closing
this task"}` until every nested step is checked. Enforced server-side, so it
applies to API and MCP callers as well as the board UI.

### GET /api/tasks/all *(v4.2.0+)*

Aggregate tasks across **every namespace the caller can read** — the board's "All
workspaces" scope. Takes no `ns`.

Access is enforced inside the handler rather than by the namespace middleware
(the request isn't scoped to one namespace), using the same filter that backs
`GET /api/namespaces`. A namespace the caller cannot read can never appear. If
that filter is ever left unwired the endpoint serves **nothing** rather than
everything.

**Response:** same shape as `GET /api/tasks`; every task carries `namespace`, and
`board` is the union of the per-namespace column layouts (default columns first,
then any extra columns contributed by a namespace).

```bash
curl "http://localhost:8286/api/tasks/all" -H "Authorization: Bearer $TOKEN"
```

### GET /api/namespace/users *(v4.2.0+)*

List the users who hold a grant on a namespace, to populate the assignee picker.
Requires read access to the namespace: anyone who can see it may see who else is
on it. Multi mode only — the route is not registered in single mode, and the
frontend degrades to a free-choice list.

**Response:** `[{ "id": 1, "username": "sam" }, ...]` — usernames only, ordered
for a stable picker. Emails are never returned. Namespace admins appear (they
hold grants); superadmins do not (they have no grant rows).

### POST /api/tasks

Create a task by appending a rendered task block to a note. The note is created
if it does not exist.

**Query parameters:** `ns` (required).

**Body:** a task spec.

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Required. |
| `note` | string | Target note (namespace‑relative). Defaults to the board's `defaultNote`. |
| `column` | string | Board column id. Sets the checkbox (Done column → `[x]`) and `status:`. |
| `due` | string | `YYYY-MM-DD`. |
| `priority` | string | `high` \| `medium` \| `low`. |
| `workload` | string | Free text. |
| `tags` | string[] | |
| `defaultExpanded` | bool | |
| `steps` | `[{text, checked}]` | |
| `notes` | string | Description (written as a `notes:` block scalar). |

**Response:** `201 Created` with the created `Task`.

```bash
curl -X POST "http://localhost:8286/api/tasks?ns=work" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"note":"tasks.md","title":"Design UI","column":"doing","priority":"high","tags":["ui"],"steps":[{"text":"Wireframes","checked":true}]}'
```

### PATCH /api/tasks

Mutate one task or step. Exactly one action field is used.

**Query parameters:** `ns` (required), `path` (required — the note that owns the
line).

**Body:** `line` and `raw` pin the source line, plus one action:

| Action | Effect |
|--------|--------|
| `toColumn: "<id>"` | Move a card to a column (rewrites `status:` and the checkbox). |
| `checked: <bool>` | Toggle a task or step checkbox. |
| `text: "<title>"` | Rename a task or step (checkbox preserved). |
| `setField: {key, value}` | Set/clear one metadata field (`due`/`priority`/`tags`/`workload`/`status`; empty value removes it). |
| `replace: <task spec>` | Replace the whole task block (checkbox line + detail block) from a full spec (same fields as POST). |

**Response:** the updated `Task` when the mutated line is a top‑level task; for a
step toggle, a small `{path, line, raw, checked, step:true}` acknowledgement.

**Error responses:** `409 Conflict` — the source line is stale; refresh.

```bash
# Move a card to the "done" column
curl -X PATCH "http://localhost:8286/api/tasks?ns=work&path=tasks.md" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"line":12,"raw":"- [ ] Design UI","toColumn":"done"}'
```

### GET /api/board

Return the namespace's board configuration (`.mdnest/board.json`), or the default
To Do / Doing / Done board when none is set.

**Query parameters:** `ns` (required).

**Response:** `{ version, defaultNote, columns: [{id, title, status, done}] }`.

### PUT /api/board

Replace the board configuration.

**Query parameters:** `ns` (required).

**Body:** a `BoardConfig`. Columns must have unique, non‑empty ids and titles.

**Response:** the saved `BoardConfig`.

---

## Chat

A chat is a note whose frontmatter contains `mdnest-chat: true`. The routes
are on by default and absent when `ENABLE_CHAT=false`. Format and behaviour: [chat.md](chat.md).

### GET /api/chat?ns=&path=[&after=N][&exclude=name][&mention=name][&format=text]

Needs read access to the note. Returns only the messages after #N.

```json
{ "ns": "work", "path": "Chats/release.md", "title": "Release", "description": "",
  "count": 2, "you": "ahsan",
  "messages": [ { "n": 2, "author": "claude-api", "via": "ahsan", "time": "2026-10-02T14:03:40Z", "text": "Done." } ],
  "working": [ { "author": "codxu", "kind": "working", "text": "reviewing the PR", "since": "2026-10-02T14:04:10Z" },
               { "author": "lead-qa", "kind": "listening", "since": "2026-10-02T14:04:12Z" } ] }
```

`working` is who is present, busiest first. `kind` is `working` (a status the
agent set), `thinking` (its last poll delivered new messages and it has not
posted since) or `listening` (it polled with `exclude=NAME` in the last 20
seconds; the web UI shows it as "waiting"). An empty poll with
`exclude=NAME` also clears that poster's status. A GET with `exclude=NAME` is what records listening and thinking;
a POST whose body starts with `/status` sets the status instead of adding a
message (an empty `/status` clears it) and answers `200 {"status":"status
set","count":N}`.

A POST whose body starts with `/context` records how much of its context
window the poster has used (`/context 42%`, `/context 87k/200k`,
`/context 87,000 of 200,000 tokens`, or a bare token count) and answers
`200 {"status":"context set","count":N}`; it is not added to the chat. A
report the server cannot read answers `400` with the accepted forms, and an
empty `/context` clears it. Reports are in memory for an hour and come back
on every GET as `contexts`, keyed by poster
(`{"codxu": {"used": 87000, "total": 200000, "pct": 44, "at": "…"}}`, with
`pct` `-1` when only a token count was given), and on that poster's
`working` entry as `context`.

`exclude=name` drops that poster's own messages (a waiting agent is not
woken by its own post). `mention=name` keeps only messages that address
`@name`, `@all` or `@everyone`.

`format=text` returns `[#N] author · time` blocks instead, with the total in
`X-Chat-Count` and any statuses in `X-Chat-Working`
(`codxu: reviewing the PR | claude-b: running tests`). The CLI uses this so it never has to parse JSON. A note
without the tag answers `400`.

### POST /api/chat?ns=&path=[&as=label]

Needs write access. The body is the raw message text (max 64 KB). It is
appended under a per-note lock, so concurrent posts are never lost. In multi
mode, a label other than your username is recorded as `label (via username)`.
Returns `201 {"status":"posted","count":N,"message":{...}}`.

```bash
curl -X POST "$URL/api/chat?ns=work&path=Chats/release.md&as=api-agent" \
  -H "Authorization: Bearer $TOKEN" --data-raw "Migrations done"
```

### POST /api/chat/status?ns=&path=[&as=label]

Needs write access (the same as posting). The body is one short line saying
what the poster is doing; it is shown quietly under the chat as
"label is working: …". It is kept in memory only, expires after 2 minutes
unless set again, and the poster's next message clears it, as does its next
wait poll that finds nothing new (it is waiting again). An empty body clears
it now. Labelled like a post (`label (via username)` in multi mode).

```bash
curl -X POST "$URL/api/chat/status?ns=work&path=Chats/release.md&as=api-agent" \
  -H "Authorization: Bearer $TOKEN" --data-raw "running the migration"
```

### POST /api/chat/convert?ns=&path=[&title=]

Needs write access. Creates the chat note when it does not exist (`201`).
Otherwise it adds the tag in place and keeps the existing content as the
description. Converting a chat again changes nothing.

### GET /api/chat/gifs?ns=[&format=text]

Every image a chat in the namespace can use, which a message names with
`![nod](gif:nod)`. It returns the namespace's own `ChatGifs/` files first
(gif, svg, png, webp, jpg), then each built-in the namespace does not
override by name:
`{"gifs":[{"name":"nod","path":"ChatGifs/nod.svg","scope":"workspace"},{"name":"avatar-codxu","path":"ChatGifs/avatar-codxu.svg","scope":"workspace","avatar":"codxu"},{"name":"done","path":"/api/chat/gifs/builtin/done.svg","scope":"builtin"}]}`.
A file named `avatar-NAME.*` is that poster's avatar. Any access to the
namespace may list it, and each workspace image is read-checked when
`/api/files/` serves it. The tree lists only text files, which is why this
endpoint exists.

Built-in avatars a poster can pick are listed too, with
`"kind":"avatar-choice"` and paths under `/api/chat/gifs/builtin/avatars/`.
They are never shown as reactions or attached to a poster by name.

### GET /api/chat/gifs/builtin/{name}.svg and /api/chat/gifs/builtin/avatars/{name}.svg

The animated set that ships with mdnest, embedded in the binary. It is public
(generic artwork, no user data; an `<img>` cannot send credentials), is
served with the same sandboxing CSP and `nosniff` as other active files, and
is cacheable.

### GET /api/chats[?ns=][&format=text]

Every chat the caller can read, across namespaces, most recently active
first: `{"chats":[{"ns","path","title","count","lastAuthor","lastTime","lastText"}]}`.
It applies the same namespace filter as `/api/tasks/all`, plus a per-note
read check.

---

## File Serving

### GET /api/files/{namespace}/{path}

Serve a file from a namespace. Primarily used to display uploaded images in the preview. The namespace is embedded in the URL path, not as a query parameter.

**URL parameters:**

| Segment | Description |
|---------|-------------|
| `{namespace}` | Namespace name (first path segment after `/api/files/`) |
| `{path}` | Remaining path segments identify the file within the namespace |

**Response:** The raw file content with an appropriate `Content-Type` header inferred by the server.

**Example:**

```bash
curl "http://localhost:8286/api/files/personal/journal/screenshot.png" \
  -H "Authorization: Bearer $TOKEN" \
  --output screenshot.png
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"missing path"}` | No path provided after `/api/files/` |
| 400 | `{"error":"invalid namespace"}` | Namespace contains slashes, dots, or traversal patterns |
| 400 | `{"error":"invalid path"}` | File path attempts directory traversal |
| 404 | `{"error":"namespace not found"}` | Namespace directory does not exist |
