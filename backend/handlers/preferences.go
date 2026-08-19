package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// PreferencesHandler serves GET/PATCH /api/preferences — the current user's UI
// settings. Registered in BOTH auth modes, unlike /api/me, which needs a user
// store and so does not exist in single mode. A preference has to survive in a
// single-user install too, otherwise the frontend would be forced back onto
// localStorage exactly where mdnest is most often run.
type PreferencesHandler struct {
	store     store.PreferenceStore
	multiMode bool
}

// NewPreferencesHandler creates a preferences handler over the given store.
// multiMode must match the server's auth mode: it decides whether a request
// without a user context is the single-mode user or a bug — see userID.
func NewPreferencesHandler(s store.PreferenceStore, multiMode bool) *PreferencesHandler {
	return &PreferencesHandler{store: s, multiMode: multiMode}
}

// singleModeUserID is the identity every single-mode request resolves to. It
// matches the convention the API-token store already uses for host-side tokens.
const singleModeUserID = 0

// userID resolves the caller to a preference owner.
//
// The subtlety that cost a round of e2e failures: the auth middleware only
// attaches a UserContext in MULTI mode. In single mode a fully authenticated
// request arrives with no user context at all, because there are no user
// identities to attach — so treating nil as an error made every single-mode
// request fail with 500 while the unit tests, which injected a context by
// hand, all passed.
//
// In multi mode nil is still refused rather than silently pooled into user 0:
// it means an authenticated API token the resolver could not map to a user,
// and quietly sharing one preference bucket between such tokens would be
// wrong even though preferences are not sensitive.
func (h *PreferencesHandler) userID(uc *middleware.UserContext) (int, bool) {
	if uc != nil {
		return uc.ID, true
	}
	if h.multiMode {
		return 0, false
	}
	return singleModeUserID, true
}

// Handle dispatches on method, matching the single-route-per-resource pattern
// the other handlers use.
func (h *PreferencesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	uid, ok := h.userID(middleware.UserFromContext(r.Context()))
	if !ok {
		http.Error(w, `{"error":"user context not found"}`, http.StatusInternalServerError)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.get(w, uid)
	case http.MethodPatch:
		h.patch(w, r, uid)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *PreferencesHandler) get(w http.ResponseWriter, userID int) {
	prefs, err := h.store.Get(userID)
	if err != nil {
		http.Error(w, `{"error":"failed to read preferences"}`, http.StatusInternalServerError)
		return
	}
	if prefs == nil {
		prefs = store.Preferences{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(prefs)
}

// patch merges the posted keys into the user's existing preferences. PATCH,
// not PUT: the client sends only what changed, so a future second preference
// written by another tab is not wiped by a theme toggle here.
func (h *PreferencesHandler) patch(w http.ResponseWriter, r *http.Request, userID int) {
	var incoming store.Preferences
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&incoming); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	// Reject the whole request on an unknown or oversized key rather than
	// storing the acceptable subset — a partial write that reports 200 is
	// indistinguishable from success to the client.
	for k, v := range incoming {
		if !store.ValidPreference(k, v) {
			http.Error(w, `{"error":"unsupported preference"}`, http.StatusBadRequest)
			return
		}
	}
	if len(incoming) == 0 {
		http.Error(w, `{"error":"no preferences supplied"}`, http.StatusBadRequest)
		return
	}

	if err := h.store.Set(userID, incoming); err != nil {
		http.Error(w, `{"error":"failed to save preferences"}`, http.StatusInternalServerError)
		return
	}
	h.get(w, userID)
}
