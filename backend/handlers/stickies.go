package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// StickiesHandler serves GET/PUT /api/stickies — the current user's personal
// sticky board. Registered in BOTH auth modes, like preferences: a scratch
// board is at least as useful on a single-user box as on a shared one.
//
// The board is addressed only by the authenticated identity. There is no user
// id or path in the request, so one user reaching another user's board is not
// a check that can be forgotten — it is not expressible.
type StickiesHandler struct {
	store     store.StickyStore
	multiMode bool
}

// NewStickiesHandler creates a stickies handler over the given store.
// multiMode must match the server's auth mode; see userID for why.
func NewStickiesHandler(s store.StickyStore, multiMode bool) *StickiesHandler {
	return &StickiesHandler{store: s, multiMode: multiMode}
}

// maxStickyRequest caps the request body before it is decoded. The board's own
// limit is 256 KB after marshalling; this leaves room for JSON whitespace and
// still refuses a body that could never be a valid board.
const maxStickyRequest = 512 * 1024

// userID resolves the caller to a board owner.
//
// Same subtlety as PreferencesHandler.userID, and it is worth restating rather
// than cross-referencing: the auth middleware attaches a UserContext only in
// MULTI mode. A fully authenticated single-mode request arrives with no user
// context at all, so treating nil as an error would fail every single-mode
// request while unit tests that inject a context by hand all pass.
//
// In multi mode nil is still refused. There it means an authenticated API
// token that could not be mapped to a user, and pooling those into one shared
// board would be wrong — a sticky is more personal than a preference.
func (h *StickiesHandler) userID(uc *middleware.UserContext) (int, bool) {
	if uc != nil {
		return uc.ID, true
	}
	if h.multiMode {
		return 0, false
	}
	return singleModeUserID, true
}

// Handle dispatches on method — one route per resource, like the other
// handlers.
func (h *StickiesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	uid, ok := h.userID(middleware.UserFromContext(r.Context()))
	if !ok {
		http.Error(w, `{"error":"user context not found"}`, http.StatusInternalServerError)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.get(w, uid)
	case http.MethodPut:
		h.put(w, r, uid)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *StickiesHandler) get(w http.ResponseWriter, userID int) {
	cards, err := h.store.Get(userID)
	if err != nil {
		http.Error(w, `{"error":"failed to read stickies"}`, http.StatusInternalServerError)
		return
	}
	if cards == nil {
		cards = []store.Sticky{}
	}
	writeStickies(w, cards)
}

// put replaces the whole board. Not PATCH and not per-card CRUD: the client
// holds the array, sends it whole, and last write wins. Stickies are personal,
// so the concurrent-editor problem PUT would normally raise is two tabs owned
// by the same person — not worth an ETag dance for a scratch pad.
func (h *StickiesHandler) put(w http.ResponseWriter, r *http.Request, userID int) {
	var body struct {
		Stickies []store.Sticky `json:"stickies"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxStickyRequest)).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	cards, err := store.ValidateBoard(body.Stickies)
	if err != nil {
		// The specific message is the point — "too many stickies (max 200)"
		// tells the user what to do, "bad request" does not. Anything that is
		// not a validation failure is ours, not theirs.
		if errors.Is(err, store.ErrStickyBoard) {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		http.Error(w, `{"error":"failed to save stickies"}`, http.StatusInternalServerError)
		return
	}

	if err := h.store.Set(userID, cards); err != nil {
		http.Error(w, `{"error":"failed to save stickies"}`, http.StatusInternalServerError)
		return
	}
	writeStickies(w, cards)
}

func writeStickies(w http.ResponseWriter, cards []store.Sticky) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"stickies": cards})
}

// writeJSONError emits an error whose message came from validation. It goes
// through the JSON encoder rather than fmt so a message containing a quote
// cannot produce a malformed body.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
