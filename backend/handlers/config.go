package handlers

import (
	"encoding/json"
	"net/http"
)

// ConfigHandler returns public configuration (no auth required).
type ConfigHandler struct {
	authMode string
}

// NewConfigHandler creates a new config handler.
func NewConfigHandler(authMode string) *ConfigHandler {
	return &ConfigHandler{authMode: authMode}
}

// HandleConfig handles GET /api/config (unauthenticated).
func (h *ConfigHandler) HandleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"authMode": h.authMode,
		"version":  "2.0",
	})
}
