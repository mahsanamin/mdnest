package handlers

import (
	"encoding/json"
	"net/http"
	"sync"

	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// ActivityRecorder records one completed note save into the authorship trail.
// Satisfied by *store.PostgresNoteActivityStore. Declared here (rather than
// depending on the concrete store) so the handler package stays usable in
// single mode, where no recorder is wired.
type ActivityRecorder interface {
	Record(namespace, path, noteID string, userID int, action string) error
}

// IdentityResolver maps a user ID to the git author identity (display name and
// email) used for commit Co-authored-by trailers.
type IdentityResolver interface {
	Resolve(userID int) (name, email string, ok bool)
}

// identityLookup is the read side of the user store the resolver needs.
type identityLookup interface {
	GetUserByID(id int) (*store.User, error)
}

// CachedIdentityResolver resolves a user's git identity once and caches it, so
// the frequent autosaves of a live editing session do not each hit the database
// just to stamp a commit trailer. Identities are effectively immutable for this
// purpose (a renamed user simply keeps their old trailer until restart), which
// makes a simple unbounded cache acceptable for the expected user counts.
type CachedIdentityResolver struct {
	users identityLookup
	mu    sync.RWMutex
	cache map[int]identity
}

type identity struct {
	name  string
	email string
}

// NewCachedIdentityResolver builds a resolver backed by the user store.
func NewCachedIdentityResolver(users identityLookup) *CachedIdentityResolver {
	return &CachedIdentityResolver{users: users, cache: make(map[int]identity)}
}

func (r *CachedIdentityResolver) Resolve(userID int) (string, string, bool) {
	if userID <= 0 {
		return "", "", false
	}
	r.mu.RLock()
	id, ok := r.cache[userID]
	r.mu.RUnlock()
	if ok {
		return id.name, id.email, true
	}
	u, err := r.users.GetUserByID(userID)
	if err != nil || u == nil {
		return "", "", false
	}
	id = identity{name: u.Username, email: u.Email}
	r.mu.Lock()
	r.cache[userID] = id
	r.mu.Unlock()
	return id.name, id.email, true
}

// AttributionHandler serves the per-note authorship summary that answers
// "who created / last edited / contributed to this note", read from the
// authorship trail rather than reconstructed from (bot-authored) git history.
type AttributionHandler struct {
	store    storage.Storage
	activity store.NoteActivityStore
}

// NewAttributionHandler creates a new AttributionHandler.
func NewAttributionHandler(stg storage.Storage, activity store.NoteActivityStore) *AttributionHandler {
	return &AttributionHandler{store: stg, activity: activity}
}

// HandleAttribution serves GET /api/note/attribution?ns=<n>&path=<p>. Access to
// the namespace is enforced by the route middleware (RequireNsAccess).
func (h *AttributionHandler) HandleAttribution(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	relPath, ok := SafeRelPath(r.URL.Query().Get("path"))
	if !ok {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	att, err := h.activity.Summary(ns, relPath)
	if err != nil {
		http.Error(w, `{"error":"failed to load attribution"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(att)
}
