package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// personalNamespaceLister reports the namespaces that are someone's personal
// workspace, so the management plane can exclude them.
type personalNamespaceLister interface {
	PersonalNamespaces() ([]string, error)
}

// NamespaceHandler lists namespaces via the storage backend.
type NamespaceHandler struct {
	store storage.Storage
	perms *middleware.PermissionChecker // nil in single mode
	// personal lists personal-workspace namespaces to exclude from the
	// management plane; nil in single mode.
	personal personalNamespaceLister
}

// NewNamespaceHandler creates a new namespace handler.
func NewNamespaceHandler(store storage.Storage, perms *middleware.PermissionChecker, personal personalNamespaceLister) *NamespaceHandler {
	return &NamespaceHandler{store: store, perms: perms, personal: personal}
}

// ListNamespaces handles GET /api/namespaces.
func (h *NamespaceHandler) ListNamespaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	names, err := h.store.ListNamespaces(r.Context())
	if err != nil {
		http.Error(w, `{"error":"failed to read namespaces"}`, http.StatusInternalServerError)
		return
	}

	// In multi mode, filter to namespaces the user has access to. The
	// management plane (?scope=manage) instead lists the namespaces the
	// caller may administer — a superadmin manages every namespace but no
	// longer has implicit data access, so the admin UI needs this wider list.
	if h.perms != nil {
		if r.URL.Query().Get("scope") == "manage" {
			names = h.perms.FilterManageableNamespaces(r, names)
			// Personal namespaces are self-managed by their owner (implicit
			// access) and are never administered by others, so they must not
			// appear in the admin grant / namespace-admin pickers.
			names = h.excludePersonal(names)
		} else {
			names = h.perms.FilterNamespaces(r, names)
		}
		if names == nil {
			names = []string{}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(names)
}

// excludePersonal drops personal-workspace namespaces (the owner's own
// namespace, self-managed via Settings → Git remote) from a management-plane
// list — they are never administered by others.
func (h *NamespaceHandler) excludePersonal(names []string) []string {
	if h.personal == nil {
		return names
	}
	ps, err := h.personal.PersonalNamespaces()
	if err != nil {
		return names
	}
	personal := make(map[string]bool, len(ps))
	for _, p := range ps {
		personal[p] = true
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if personal[n] {
			continue
		}
		out = append(out, n)
	}
	return out
}
