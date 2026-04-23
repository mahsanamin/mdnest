package handlers

import (
	"encoding/json"
	"net/http"
)

// ConfigHandler returns public configuration (no auth required).
type ConfigHandler struct {
	authMode    string
	liveCollab  bool
	serverAlias string
	require2FA  bool
}

// NewConfigHandler creates a new config handler.
func NewConfigHandler(authMode string, liveCollab bool, serverAlias string, require2FA bool) *ConfigHandler {
	return &ConfigHandler{authMode: authMode, liveCollab: liveCollab, serverAlias: serverAlias, require2FA: require2FA}
}

// HandleConfig handles GET /api/config (unauthenticated).
func (h *ConfigHandler) HandleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	resp := map[string]interface{}{
		"authMode":   h.authMode,
		"liveCollab": h.liveCollab,
		"require2FA": h.require2FA,
		"version":    "3.3.1",
	}
	if h.serverAlias != "" {
		resp["serverAlias"] = h.serverAlias
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
