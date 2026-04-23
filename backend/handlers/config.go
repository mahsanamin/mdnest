package handlers

import (
	"encoding/json"
	"net/http"
)

// ConfigHandler returns public configuration (no auth required).
type ConfigHandler struct {
	authMode     string
	liveCollab   bool
	serverAlias  string
	require2FA   bool
	userProvider string                 // "local" | "firebase" | "sso"
	firebaseWeb  map[string]interface{} // parsed firebase-web-config.json (Firebase mode only)
	ssoProvider  string                 // human label for the SSO button (e.g. "Google")
}

// NewConfigHandler creates a new config handler.
func NewConfigHandler(authMode string, liveCollab bool, serverAlias string, require2FA bool) *ConfigHandler {
	return &ConfigHandler{
		authMode:     authMode,
		liveCollab:   liveCollab,
		serverAlias:  serverAlias,
		require2FA:   require2FA,
		userProvider: "local",
	}
}

// SetFirebase tells the config handler that federated identity is on and
// supplies the web-side Firebase config the frontend needs to init its SDK.
func (h *ConfigHandler) SetFirebase(webConfig map[string]interface{}) {
	h.userProvider = "firebase"
	h.firebaseWeb = webConfig
}

// SetSSO marks this deployment as running in SSO mode. providerLabel is an
// optional human-readable label the frontend shows on the sign-in button
// (e.g. "Google", "Okta"). Defaults to "SSO" when empty.
func (h *ConfigHandler) SetSSO(providerLabel string) {
	h.userProvider = "sso"
	if providerLabel == "" {
		providerLabel = "SSO"
	}
	h.ssoProvider = providerLabel
}

// HandleConfig handles GET /api/config (unauthenticated).
func (h *ConfigHandler) HandleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	resp := map[string]interface{}{
		"authMode":     h.authMode,
		"liveCollab":   h.liveCollab,
		"require2FA":   h.require2FA,
		"userProvider": h.userProvider,
		"version":      "3.4.0",
	}
	if h.serverAlias != "" {
		resp["serverAlias"] = h.serverAlias
	}
	if h.userProvider == "firebase" && h.firebaseWeb != nil {
		resp["firebaseWebConfig"] = h.firebaseWeb
	}
	if h.userProvider == "sso" {
		resp["ssoProvider"] = h.ssoProvider
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
