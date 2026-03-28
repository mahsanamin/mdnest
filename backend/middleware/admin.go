package middleware

import "net/http"

// RequireAdmin wraps a handler and returns 403 if the user is not an admin.
// In single-user mode (no user context), access is granted (single user has full control).
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsAdmin(r.Context()) {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
