# Backend (Go)

Rules for `backend/`. The full explanation of each rule, with the history behind
it, is in `docs/dev/backend.md`. Read that section before changing the code it
names. Per-file traps are in `docs/codemap.md`.

## Shape of the code

- Standard library `net/http` with `ServeMux`, no web framework. Dependencies:
  golang-jwt v5, pgx v5 (Postgres), golang.org/x/crypto. Adding one needs a reason.
- Handler pattern: a struct holding `notesDir`, a `NewXHandler()` constructor,
  one route per resource with a `switch r.Method` inside `Handle()`.
- Responses: JSON for structured data, raw text for note content, errors as
  `{"error":"message"}` with the right status.
- Every file API takes the `ns` query param. Resolve it with `RequireNamespace()`
  and every path with `SafePath()` (`handlers/path.go`). No exceptions.

## Modes and identity

- `AUTH_MODE=single` (files only, the `store/` package is not even initialized)
  or `AUTH_MODE=multi` (Postgres). Nothing may add a database to single mode, and
  every multi-user feature must be fully conditional so single mode keeps working.
- `USER_PROVIDER=local | firebase | sso`, chosen at startup. In `sso` mode 2FA is
  skipped. IdP-specific rules go in `sso.checkIdentity`, keyed on the issuer.
- Roles: `superadmin` (global management, but NO implicit access to note
  content), `admin` (per namespace, `namespace_admins`), `collaborator` (grants
  only). Checks go through `middleware.PermissionChecker`. API tokens follow the
  same chain. The superadmin's management powers stay complete by default.
- Effective access = own grants plus access-group grants. A nil group store
  disables groups.

## Traps

- Postgres driver is pgx, never lib/pq: `sql.Open("pgx", dsn)`, unique
  violations via `pgconn.PgError` code `23505`, pass Go slices directly for
  `= ANY($n)`.
- An access filter passed as a function is a required argument and nil means
  deny-all (see `/api/tasks/all`).
- Adding a column to a query: update every `Scan()` for that table.
- App data that is not user notes needs its own declared volume in `setup.sh`,
  or `./mdnest-server rebuild` deletes it.
- Collaboration server (`collab/`): every join goes through `Conn.Authorize`; read
  "Live editing" in `docs/dev/frontend.md` before changing the websocket protocol.

## Testing

`go vet ./... && go test -race ./...` from `backend/`. Tests that need Redis
read `MDNEST_TEST_REDIS_URL` and skip without it. Multi-mode behavior has
end-to-end suites (`tests/e2e-*-multi.sh`); see `tests/AGENTS.md`.
