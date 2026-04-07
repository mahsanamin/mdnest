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
}

// NewConfigHandler creates a new config handler.
func NewConfigHandler(authMode string, liveCollab bool, serverAlias string) *ConfigHandler {
	return &ConfigHandler{authMode: authMode, liveCollab: liveCollab, serverAlias: serverAlias}
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
		"version":    "3.1.2",
	}
	if h.serverAlias != "" {
		resp["serverAlias"] = h.serverAlias
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
