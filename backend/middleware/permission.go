package middleware

import (
	"net/http"

	"github.com/mdnest/mdnest/backend/store"
)

// PermissionChecker validates user access to namespaces and paths.
// Nil in single-user mode (all access granted).
type PermissionChecker struct {
	grantStore   store.GrantStore
	nsAdminStore store.NamespaceAdminStore
}

// NewPermissionChecker creates a new PermissionChecker. nsAdminStore is
// consulted for role="admin" requests to decide whether the namespace is
// in the user's admin scope; superadmins bypass it entirely.
func NewPermissionChecker(grantStore store.GrantStore, nsAdminStore store.NamespaceAdminStore) *PermissionChecker {
	return &PermissionChecker{grantStore: grantStore, nsAdminStore: nsAdminStore}
}

// hasAdminScope returns true if the user's role grants admin-level
// access to the given namespace (superadmin bypasses everything;
// namespace-admin must have a row in namespace_admins). Used as the
// short-circuit before falling through to grant lookups.
func (pc *PermissionChecker) hasAdminScope(uc *UserContext, namespace string) bool {
	if uc.Role == "superadmin" {
		return true
	}
	if uc.Role == "admin" && pc.nsAdminStore != nil && namespace != "" {
		ok, err := pc.nsAdminStore.IsAdminOf(uc.ID, namespace)
		return err == nil && ok
	}
	return false
}

// CheckRead returns true if the user can read the given namespace/path.
// Admins always have access. In single-user mode (no user context), access is granted.
func (pc *PermissionChecker) CheckRead(r *http.Request, namespace, path string) bool {
	return pc.check(r, namespace, path, "read")
}

// CheckWrite returns true if the user can write to the given namespace/path.
func (pc *PermissionChecker) CheckWrite(r *http.Request, namespace, path string) bool {
	return pc.check(r, namespace, path, "write")
}

func (pc *PermissionChecker) check(r *http.Request, namespace, path, permission string) bool {
	uc := UserFromContext(r.Context())
	if uc == nil {
		return true // single-user mode
	}
	if pc.hasAdminScope(uc, namespace) {
		return true
	}
	return pc.grantStore.CheckAccess(uc.ID, namespace, path, permission)
}

// FilterNamespaces returns only the namespaces the user has access to.
// Single-user mode and superadmins see everything; namespace-admins see
// the union of (admin namespaces, granted namespaces); collaborators see
// only their granted namespaces.
func (pc *PermissionChecker) FilterNamespaces(r *http.Request, namespaces []string) []string {
	uc := UserFromContext(r.Context())
	if uc == nil || uc.Role == "superadmin" {
		return namespaces
	}

	accessSet := make(map[string]bool)
	if accessible, err := pc.grantStore.GetAccessibleNamespaces(uc.ID); err == nil {
		for _, ns := range accessible {
			accessSet[ns] = true
		}
	}
	if uc.Role == "admin" && pc.nsAdminStore != nil {
		if adminOf, err := pc.nsAdminStore.ListByUser(uc.ID); err == nil {
			for _, ns := range adminOf {
				accessSet[ns] = true
			}
		}
	}

	var filtered []string
	for _, ns := range namespaces {
		if accessSet[ns] {
			filtered = append(filtered, ns)
		}
	}
	return filtered
}

// DenyJSON writes a 403 JSON error response.
func DenyJSON(w http.ResponseWriter) {
	http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
}

// RequireRead wraps a handler and checks read access for the namespace/path
// from query parameters. Admins and single-mode users pass through.
func (pc *PermissionChecker) RequireRead(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/"
		}
		if ns != "" && !pc.CheckRead(r, ns, path) {
			DenyJSON(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireWrite wraps a handler and checks write access for the namespace/path
// from query parameters.
func (pc *PermissionChecker) RequireWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/"
		}
		if ns != "" && !pc.CheckWrite(r, ns, path) {
			DenyJSON(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireNsAccess wraps a handler and checks that the user has any grant
// at all in the namespace. Used for tree and search endpoints where the user
// needs at least some access to the namespace.
func (pc *PermissionChecker) RequireNsAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		if ns == "" {
			next.ServeHTTP(w, r)
			return
		}
		uc := UserFromContext(r.Context())
		if uc == nil {
			next.ServeHTTP(w, r)
			return
		}
		if pc.hasAdminScope(uc, ns) {
			next.ServeHTTP(w, r)
			return
		}
		// Check if user has any grant in this namespace
		accessible, err := pc.grantStore.GetAccessibleNamespaces(uc.ID)
		if err != nil {
			DenyJSON(w)
			return
		}
		for _, a := range accessible {
			if a == ns {
				next.ServeHTTP(w, r)
				return
			}
		}
		DenyJSON(w)
	})
}

// CheckMoveAccess checks write permission on both source and destination paths.
func (pc *PermissionChecker) CheckMoveAccess(r *http.Request) bool {
	ns := r.URL.Query().Get("ns")
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if ns == "" {
		return true
	}
	return pc.CheckWrite(r, ns, from) && pc.CheckWrite(r, ns, to)
}

// RequireMove wraps a handler and checks write access on both from and to paths.
func (pc *PermissionChecker) RequireMove(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !pc.CheckMoveAccess(r) {
			DenyJSON(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ReadWriteRouter wraps a handler and applies read check for GET/HEAD,
// write check for POST/PUT/PATCH/DELETE. Used for the /api/note endpoint.
func (pc *PermissionChecker) ReadWriteRouter(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/"
		}
		if ns == "" {
			next.ServeHTTP(w, r)
			return
		}
		switch r.Method {
		case "GET", "HEAD":
			if !pc.CheckRead(r, ns, path) {
				DenyJSON(w)
				return
			}
		default:
			if !pc.CheckWrite(r, ns, path) {
				DenyJSON(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
