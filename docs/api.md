# mdnest API Reference

All endpoints are served under the `/api` prefix. Unless noted otherwise, every endpoint requires an `Authorization: Bearer <token>` header obtained from the login endpoint.

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

Authenticate with username and password. Returns a JWT token valid for 24 hours.

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

## Admin (multi-user mode only)

These endpoints are only available when `AUTH_MODE=multi`. All require admin role -- non-admin users receive a 403.

### POST /api/admin/invite

Create a new user.

**Request body** (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | yes | User's email (must be unique) |
| `username` | string | yes | Login username (must be unique) |
| `password` | string | yes | Initial password |
| `role` | string | no | `admin` or `collaborator` (default: `collaborator`) |

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
  -d '{"email": "bob@example.com", "username": "bob", "password": "securepass", "role": "collaborator"}'
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"email, username, and password are required"}` | Missing fields |
| 400 | `{"error":"role must be admin or collaborator"}` | Invalid role |
| 403 | `{"error":"admin access required"}` | Non-admin user |
| 409 | `{"error":"email already in use"}` | Duplicate email |
| 409 | `{"error":"username already in use"}` | Duplicate username |

---

### GET /api/admin/users

List all users.

**Response** (200 OK):

```json
[
  {"id": 1, "email": "admin@mdnest.local", "username": "admin", "role": "admin", "created_at": "2026-03-28T10:00:00Z"},
  {"id": 2, "email": "bob@example.com", "username": "bob", "role": "collaborator", "invited_by": 1, "created_at": "2026-03-28T12:00:00Z"}
]
```

---

### PUT /api/admin/users?id=\<user-id\>

Update a user's role.

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
| 400 | `{"error":"cannot remove the last admin"}` | Demoting the only admin |

---

### DELETE /api/admin/users?id=\<user-id\>

Delete a user. Access grants are cascade-deleted.

**Response** (200 OK):

```json
{"status": "deleted"}
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"cannot delete yourself"}` | Attempting self-deletion |
| 400 | `{"error":"cannot remove the last admin"}` | Deleting the only admin |
| 404 | `{"error":"user not found"}` | User ID does not exist |

**Examples:**

```bash
# List users
curl "http://localhost:8286/api/admin/users" -H "Authorization: Bearer $TOKEN"

# Change role
curl -X PUT "http://localhost:8286/api/admin/users?id=2" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# Delete user
curl -X DELETE "http://localhost:8286/api/admin/users?id=2" \
  -H "Authorization: Bearer $TOKEN"
```

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

Returns the current user's profile and access grants. Requires authentication (any role).

**Response** (200 OK):

```json
{
  "id": 2,
  "email": "bob@example.com",
  "username": "bob",
  "avatar_url": "https://lh3.googleusercontent.com/a/...",
  "role": "collaborator",
  "created_at": "2026-03-28T12:00:00Z",
  "grants": [
    {"id": 1, "namespace": "work", "path": "/", "permission": "write"},
    {"id": 2, "namespace": "personal", "path": "/docs", "permission": "read"}
  ]
}
```

`avatar_url` is populated from the IdP's `picture` OIDC claim on every SSO login (see `docs/sso-setup.md`). Omitted from the JSON response when empty.

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

**Request body:** The new file content (replaces the entire file).

**Response** (200 OK):

```json
{"status": "ok"}
```

**Example:**

```bash
curl -X PUT "http://localhost:8286/api/note?ns=personal&path=todo.md" \
  -H "Authorization: Bearer $TOKEN" \
  -d "# Todo

- [x] Set up mdnest
- [ ] Write documentation"
```

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error":"invalid path"}` | Path is empty or attempts directory traversal |
| 404 | `{"error":"not found"}` | File does not exist |

---

### PATCH /api/note

Append or prepend text to a note. Creates the file if it doesn't exist.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `ns` | yes | Namespace name |
| `path` | yes | Relative path to the note |
| `position` | no | `top` (prepend) or `bottom` (append, default) |

**Request body:** Plain text to append/prepend.

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
