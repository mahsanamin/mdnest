package middleware

import "net/http"

// RequireAdmin wraps a handler and returns 403 unless the caller has ANY
// admin role (superadmin or namespace-scoped admin). It's the outer gate
// on /api/admin/*; handlers do per-namespace scoping internally based on
// the request body / query.
//
// In single-user mode (no user context), access is granted.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsAdmin(r.Context()) {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireSuperAdmin is the strict gate for system-wide actions: reset
// another user's 2FA, delete a user, promote between
// superadmin/admin/collaborator, sync all namespaces at once.
//
// In single-user mode (no user context), access is granted.
func RequireSuperAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsSuperAdmin(r.Context()) {
			http.Error(w, `{"error":"superadmin access required"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
