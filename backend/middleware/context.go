package middleware

import (
	"context"
	"net/http"
)

type contextKey string

const userContextKey contextKey = "mdnest_user"

// UserContext holds the authenticated user's identity extracted from the JWT.
type UserContext struct {
	ID       int
	Username string
	Role     string // "admin" or "collaborator"
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

// IsAdmin returns true if the request was made by an admin user.
// In single-user mode (no user context), returns true (single user has full access).
func IsAdmin(ctx context.Context) bool {
	u := UserFromContext(ctx)
	if u == nil {
		return true // single-user mode
	}
	return u.Role == "admin"
}
