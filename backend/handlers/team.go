package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// namespaceUsersLister is the read side needed to list a namespace's members.
// Satisfied by *store.PostgresGrantStore. Declared narrowly so this handler does
// not depend on the whole GrantStore interface (and its fakes).
type namespaceUsersLister interface {
	UsersForNamespace(namespace string) ([]store.NamespaceUser, error)
}

// TeamHandler serves the list of users who have access to a namespace, used to
// populate assignment pickers (e.g. the task board's assignee dropdown).
type TeamHandler struct {
	store storage.Storage
	users namespaceUsersLister
}

// NewTeamHandler creates a new TeamHandler.
func NewTeamHandler(stg storage.Storage, users namespaceUsersLister) *TeamHandler {
	return &TeamHandler{store: stg, users: users}
}

// HandleNamespaceUsers serves GET /api/namespace/users?ns=<n>. Access to the
// namespace is enforced by the route middleware (RequireNsAccess): anyone who
// can read the namespace may see who else is on it, so a task can be assigned.
func (h *TeamHandler) HandleNamespaceUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return
	}
	users, err := h.users.UsersForNamespace(ns)
	if err != nil {
		http.Error(w, `{"error":"failed to list namespace users"}`, http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []store.NamespaceUser{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(users)
}
