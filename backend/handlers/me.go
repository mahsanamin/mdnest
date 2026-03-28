package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// MeHandler returns the current user's info and grants.
type MeHandler struct {
	userStore  store.UserStore
	grantStore store.GrantStore
}

// NewMeHandler creates a new MeHandler.
func NewMeHandler(userStore store.UserStore, grantStore store.GrantStore) *MeHandler {
	return &MeHandler{userStore: userStore, grantStore: grantStore}
}

type meResponse struct {
	ID        int         `json:"id"`
	Email     string      `json:"email"`
	Username  string      `json:"username"`
	Role      string      `json:"role"`
	CreatedAt string      `json:"created_at"`
	Grants    []meGrant   `json:"grants"`
}

type meGrant struct {
	ID         int    `json:"id"`
	Namespace  string `json:"namespace"`
	Path       string `json:"path"`
	Permission string `json:"permission"`
}

// HandleMe handles GET /api/me.
func (h *MeHandler) HandleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"user context not found"}`, http.StatusInternalServerError)
		return
	}

	user, err := h.userStore.GetUserByID(uc.ID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusInternalServerError)
		return
	}

	grants, err := h.grantStore.GetGrantsForUser(uc.ID)
	if err != nil {
		grants = nil
	}

	meGrants := make([]meGrant, 0, len(grants))
	for _, g := range grants {
		meGrants = append(meGrants, meGrant{
			ID:         g.ID,
			Namespace:  g.Namespace,
			Path:       g.Path,
			Permission: g.Permission,
		})
	}

	resp := meResponse{
		ID:        user.ID,
		Email:     user.Email,
		Username:  user.Username,
		Role:      user.Role,
		CreatedAt: user.CreatedAt.Format(time.RFC3339),
		Grants:    meGrants,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
