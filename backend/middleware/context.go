package middleware

import (
	"context"
	"net/http"
)

type contextKey string

const userContextKey contextKey = "mdnest_user"

// viaAPITokenKey marks a request that was authenticated with an mdnest_ API
// token rather than a browser session. It is a separate context value, not
// only the field on UserContext, because a single-mode request carries no
// UserContext at all and still has to be told apart (agent approvals refuse
// a decision made with a token in BOTH modes).
const viaAPITokenKey contextKey = "mdnest_via_api_token"

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
	// Groups holds the IdP (OIDC) group IDs carried in the JWT, snapshotted at
	// login. Used to resolve access-group membership. Empty for local users or
	// when the IdP emits no groups claim.
	Groups []string
	// ViaAPIToken is true when the request was authenticated with an mdnest_
	// API token instead of a browser login. Set by AuthMiddleware. In single
	// mode there is no UserContext, so read RequestViaAPIToken instead.
	ViaAPIToken bool
}

// withAPIToken marks the request as authenticated by an API token.
func withAPIToken(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), viaAPITokenKey, true))
}

// RequestViaAPIToken reports whether the request was authenticated with an
// mdnest_ API token. Works in both auth modes. A request that never went
// through AuthMiddleware reports false, so a check built on it must also
// require that the route is behind auth (every /api/approvals route is).
func RequestViaAPIToken(r *http.Request) bool {
	if v, _ := r.Context().Value(viaAPITokenKey).(bool); v {
		return true
	}
	if u := UserFromContext(r.Context()); u != nil && u.ViaAPIToken {
		return true
	}
	return false
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
