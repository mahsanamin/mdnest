# MCP server (Node.js)

- Uses `@modelcontextprotocol/sdk`. It wraps the mdnest REST API; it holds no
  logic of its own that the backend does not also enforce.
- Config comes from env vars (`MDNEST_URL`, `MDNEST_USER`, `MDNEST_PASSWORD`).
  It logs in on startup, keeps the JWT, and logs in again on a 401.
- Tools: list_namespaces, list_tree, read_note, write_note, create_note,
  create_folder, delete_item, move_item, search_notes. Resources:
  `notes://{namespace}` and `notes://{namespace}/{path}`.
- Native `fetch` (Node 18+). Do not add an HTTP library.
- When you add or rename a tool, update `docs/mcp.md` and the README list in the
  same change.
- `npm audit --audit-level=high` here is a required check on `main`.
