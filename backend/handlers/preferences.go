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
	store store.PreferenceStore
}

// NewPreferencesHandler creates a preferences handler over the given store.
func NewPreferencesHandler(s store.PreferenceStore) *PreferencesHandler {
	return &PreferencesHandler{store: s}
}

// Handle dispatches on method, matching the single-route-per-resource pattern
// the other handlers use.
func (h *PreferencesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"user context not found"}`, http.StatusInternalServerError)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.get(w, uc.ID)
	case http.MethodPatch:
		h.patch(w, r, uc.ID)
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
