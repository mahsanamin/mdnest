package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// NamespaceHandler lists namespaces via the storage backend.
type NamespaceHandler struct {
	store storage.Storage
	perms *middleware.PermissionChecker // nil in single mode
}

// NewNamespaceHandler creates a new namespace handler.
func NewNamespaceHandler(store storage.Storage, perms *middleware.PermissionChecker) *NamespaceHandler {
	return &NamespaceHandler{store: store, perms: perms}
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

	// In multi mode, filter to namespaces the user has access to
	if h.perms != nil {
		names = h.perms.FilterNamespaces(r, names)
		if names == nil {
			names = []string{}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(names)
}
