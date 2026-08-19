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
	taskBoard       bool                   // ENABLE_TASK_BOARD is on — the frontend may show the board button and load its chunk
	marp            bool                   // ENABLE_MARP is on — the frontend may render Marp-format notes as a slide deck (loads its chunk)
	marpThemes      bool                   // ENABLE_MARP_THEMES is on — the centralized theme catalog + admin editor are available
	excalidraw      bool                   // ENABLE_EXCALIDRAW is on — the frontend may open .excalidraw.md files in the drawing editor (loads its chunk)
	excalidrawLibs  []string               // EXCALIDRAW_LIBRARIES — operator-provided .excalidrawlib URLs preloaded into every drawing
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

// SetTaskBoard flips on the task-board signal. Off by default: when it is
// false the /api/tasks and /api/board routes are not registered at all, so the
// frontend must not offer the board (it would 404). The flag is what keeps an
// operator who just wants notes from carrying the board's UI chunk.
func (h *ConfigHandler) SetTaskBoard(enabled bool) {
	h.taskBoard = enabled
}

// SetMarp flips on the Marp signal. Off by default: when false the frontend
// never renders Marp-format notes as a slide deck and never loads the Marp
// engine chunk — an operator who just wants notes carries none of it.
func (h *ConfigHandler) SetMarp(enabled bool) {
	h.marp = enabled
}

// SetMarpThemes flips on the centralized Marp theme catalog (ENABLE_MARP_THEMES,
// a separate opt-in on top of ENABLE_MARP). Off by default: when false the
// /api/marp/themes route is not registered, nothing is seeded into the reserved
// namespace, and the frontend hides the theme admin tab — an operator who wants
// plain Marp decks carries none of it.
func (h *ConfigHandler) SetMarpThemes(enabled bool) {
	h.marpThemes = enabled
}

// SetExcalidraw flips on the Excalidraw signal. Off by default: when false the
// frontend never opens .excalidraw.md files in the drawing editor and never
// loads the Excalidraw chunk — an operator who just wants notes carries none of
// it.
func (h *ConfigHandler) SetExcalidraw(enabled bool) {
	h.excalidraw = enabled
}

// SetExcalidrawLibraries sets the operator-provided default Excalidraw library
// URLs (.excalidrawlib) the frontend preloads into every drawing, so an
// organisation can ship a shared shape set. Ignored unless Excalidraw is on.
func (h *ConfigHandler) SetExcalidrawLibraries(urls []string) {
	h.excalidrawLibs = urls
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
		"version":      "4.2.3-dev",
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
	if h.taskBoard {
		resp["taskBoard"] = true
	}
	if h.marp {
		resp["marp"] = true
	}
	if h.marpThemes {
		resp["marpThemes"] = true
	}
	if h.excalidraw {
		resp["excalidraw"] = true
		if len(h.excalidrawLibs) > 0 {
			resp["excalidrawLibraries"] = h.excalidrawLibs
		}
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
