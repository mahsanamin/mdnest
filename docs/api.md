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
