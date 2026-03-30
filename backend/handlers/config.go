package handlers

import (
	"encoding/json"
	"net/http"
)

// ConfigHandler returns public configuration (no auth required).
type ConfigHandler struct {
	authMode  string
	liveCollab bool
}

// NewConfigHandler creates a new config handler.
func NewConfigHandler(authMode string, liveCollab bool) *ConfigHandler {
	return &ConfigHandler{authMode: authMode, liveCollab: liveCollab}
}

// HandleConfig handles GET /api/config (unauthenticated).
func (h *ConfigHandler) HandleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"authMode":   h.authMode,
		"liveCollab": h.liveCollab,
		"version":    "2.0",
	})
}
