package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/mdnest/mdnest/backend/updates"
)

// Commit is the short git commit the backend binary was built from. It is
// injected at build time via -ldflags "-X .../handlers.Commit=<sha>" (see
// backend/Dockerfile) so /api/config can report exactly which build is
// running — the version string alone can't distinguish a stale container.
// Defaults to "dev" for local `go run`/`go build` without the ldflag.
var Commit = "dev"

// BuildTime is the UTC timestamp the backend binary was built, injected the
// same way as Commit (-ldflags "-X .../handlers.BuildTime=<iso8601>"). Lets
// /api/config report *when* the running build was produced, not just which
// commit — so "which version is live" is unambiguous. Empty/"dev" locally.
var BuildTime = "dev"

// ConfigHandler returns public configuration (no auth required).
type ConfigHandler struct {
	authMode        string
	liveCollab      bool
	serverAlias     string
	require2FA      bool
	userProvider    string                 // "local" | "firebase" | "sso"
	firebaseWeb     map[string]interface{} // parsed firebase-web-config.json (Firebase mode only)
	ssoProvider     string                 // human label for the SSO button (e.g. "Google")
	devLoginEnabled bool                   // INSECURE_DEV_LOGIN is on (signals frontend to expose /?login=dev + warning bar)
	grantMaxDepth   int                    // server-side ceiling on grant path depth (0 = no limit). PathPicker uses this to filter the dropdown.
	updateChecker   *updates.Checker       // optional — polls GitHub releases so the frontend can hint when a newer mdnest is available
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

// SetDevLoginEnabled flips on the INSECURE_DEV_LOGIN signal so the
// frontend knows to (a) accept /?login=dev navigations, (b) render a
// loud warning bar in every authenticated view.
func (h *ConfigHandler) SetDevLoginEnabled(enabled bool) {
	h.devLoginEnabled = enabled
}

// SetGrantMaxDepth tells the frontend how deep into a namespace tree a
// grant path can go. The frontend's PathPicker uses this to hide
// too-deep folders from the dropdown — but the backend still enforces
// the same value at grant-creation time (frontend filtering is UX, not
// authorization).
func (h *ConfigHandler) SetGrantMaxDepth(depth int) {
	h.grantMaxDepth = depth
}

// SetUpdateChecker wires in the GitHub-release poller. When set, /api/config
// includes a latestRelease object (once the first poll has succeeded) so the
// frontend can hint that a newer mdnest version is available.
func (h *ConfigHandler) SetUpdateChecker(c *updates.Checker) {
	h.updateChecker = c
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
		"version":      "3.11.8-dev",
		"commit":       Commit,
		"buildTime":    BuildTime,
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
	if h.devLoginEnabled {
		resp["devLoginEnabled"] = true
	}
	if h.grantMaxDepth > 0 {
		resp["grantMaxDepth"] = h.grantMaxDepth
	}
	if h.updateChecker != nil {
		s := h.updateChecker.Status()
		// Skip the field entirely until the first poll succeeds — the
		// frontend treats absence as "unknown, no banner."
		if s.LatestVersion != "" {
			rel := map[string]interface{}{
				"version":   s.LatestVersion,
				"url":       s.ReleaseURL,
				"checkedAt": s.CheckedAt.Format("2006-01-02T15:04:05Z"),
			}
			if s.Name != "" {
				rel["name"] = s.Name
			}
			if s.Notes != "" {
				rel["notes"] = s.Notes
			}
			if !s.PublishedAt.IsZero() {
				rel["publishedAt"] = s.PublishedAt.Format("2006-01-02T15:04:05Z")
			}
			resp["latestRelease"] = rel
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
