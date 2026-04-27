package middleware

import (
	"context"
	"net/http"
)

type contextKey string

const userContextKey contextKey = "mdnest_user"

// UserContext holds the authenticated user's identity extracted from the JWT.
//
// Role values (v3.5.0+):
//   - "superadmin"    — global; bypasses all permission checks
//   - "admin"         — namespace-scoped; bypasses checks only on
//                       namespaces the user has a row for in
//                       namespace_admins (looked up at request time)
//   - "collaborator"  — only the explicit grants in access_grants
//
// The legacy single-value "admin" role from earlier versions is migrated
// to "superadmin" by migration 007, so any pre-v3.5.0 token still in
// circulation that carries role="admin" will be treated as a
// namespace-scoped admin with no namespaces — i.e. it will fail every
// check until the holder logs in again. That's the correct fail-closed
// behavior for a privilege downgrade.
type UserContext struct {
	ID       int
	Username string
	Role     string
}

// WithUser attaches a UserContext to the request context.
func WithUser(r *http.Request, u *UserContext) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), userContextKey, u))
}

// UserFromContext extracts the UserContext from a request context.
// Returns nil in single-user mode (no user context set).
func UserFromContext(ctx context.Context) *UserContext {
	u, _ := ctx.Value(userContextKey).(*UserContext)
	return u
}

// IsAdmin returns true if the request was made by ANY admin role
// (superadmin or namespace-scoped admin). Used as the outer gate on
// /api/admin/* — handlers do further per-namespace scoping internally.
// In single-user mode (no user context), returns true.
func IsAdmin(ctx context.Context) bool {
	u := UserFromContext(ctx)
	if u == nil {
		return true // single-user mode
	}
	return u.Role == "superadmin" || u.Role == "admin"
}

// IsSuperAdmin returns true only for the global "superadmin" role. Used
// to gate endpoints that touch global state (reset 2FA, delete users,
// promote/demote between superadmin/admin/collaborator, sync all
// namespaces).
func IsSuperAdmin(ctx context.Context) bool {
	u := UserFromContext(ctx)
	if u == nil {
		return true // single-user mode — owner has god mode
	}
	return u.Role == "superadmin"
}
