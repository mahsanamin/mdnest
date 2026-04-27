package handlers

import (
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/sso"
	"github.com/mdnest/mdnest/backend/store"
)

// SSOHandler owns /api/auth/sso/start and /api/auth/sso/callback.
//
// Flow:
//   1. Browser hits /api/auth/sso/start → we generate CSRF state + PKCE
//      verifier + OIDC nonce, pack them into a signed cookie, and redirect
//      to the IdP's authorization endpoint.
//   2. IdP bounces the browser back to /api/auth/sso/callback with
//      ?code=...&state=... — we verify the state cookie, exchange the code,
//      verify the ID token, and extract the email.
//   3. We look the email up in the local users table. NO auto-provisioning —
//      if the email isn't already invited, we redirect back to the frontend
//      with an error in the hash.
//   4. On success we mint the normal mdnest JWT (same shape as password /
//      Firebase flow) and redirect to the frontend with the token in the
//      URL fragment (#token=...). The frontend bootstrap reads the fragment,
//      stores the token in localStorage, strips the hash, and proceeds.
type SSOHandler struct {
	client       *sso.Client
	userStore    store.UserStore
	secret       []byte
	frontendURL  string // where to redirect the browser after login
	secureCookie bool   // set Secure flag on state cookie (HTTPS deployments)
}

// NewSSOHandler wires an SSO client to a user store. frontendURL is the
// absolute origin of the web UI ("https://notes.example.com"), used to
// redirect the browser back after a successful (or failed) login.
func NewSSOHandler(client *sso.Client, userStore store.UserStore, jwtSecret, frontendURL string, secureCookie bool) *SSOHandler {
	return &SSOHandler{
		client:       client,
		userStore:    userStore,
		secret:       []byte(jwtSecret),
		frontendURL:  strings.TrimRight(frontendURL, "/"),
		secureCookie: secureCookie,
	}
}

// HandleStart redirects the browser to the IdP's authorize URL.
// GET /api/auth/sso/start?from=/path/to/return/to
func (h *SSOHandler) HandleStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	from := sso.SanitizeFromPath(r.URL.Query().Get("from"))
	authURL, cookieValue, err := h.client.BuildAuthURL(from)
	if err != nil {
		log.Printf("sso start: %v", err)
		http.Error(w, `{"error":"sso not configured"}`, http.StatusInternalServerError)
		return
	}
	h.client.SetStateCookie(w, cookieValue, h.secureCookie)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// HandleCallback completes the OIDC exchange.
// GET /api/auth/sso/callback?code=...&state=...
func (h *SSOHandler) HandleCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	// An IdP-side error (user denied, wrong redirect, etc.) comes back as
	// ?error=... Surface it to the user without trying to exchange.
	if ssoErr := r.URL.Query().Get("error"); ssoErr != "" {
		h.redirectWithError(w, r, "/", "sso_denied:"+ssoErr)
		return
	}

	cookie, err := r.Cookie(h.client.CookieName())
	cookieValue := ""
	if err == nil {
		cookieValue = cookie.Value
	}
	h.client.ClearStateCookie(w, h.secureCookie)

	claims, err := h.client.ExchangeCallback(r.Context(), cookieValue,
		r.URL.Query().Get("state"),
		r.URL.Query().Get("code"),
	)
	if err != nil {
		log.Printf("sso callback: %v", err)
		h.redirectWithError(w, r, "/", "sso_failed")
		return
	}

	// Email → local user row. NO auto-provisioning — users must be invited
	// first via the normal admin flow. This matches the product decision.
	user, err := h.userStore.GetUserByEmail(claims.Email)
	if err != nil {
		log.Printf("sso user lookup failed for %s: %v", claims.Email, err)
		h.redirectWithError(w, r, "/", "sso_internal")
		return
	}
	if user == nil {
		log.Printf("sso rejected: %s has no mdnest account", claims.Email)
		h.redirectWithError(w, r, "/", "sso_not_invited")
		return
	}
	if user.Blocked {
		log.Printf("sso rejected: %s is blocked", claims.Email)
		h.redirectWithError(w, r, "/", "sso_blocked")
		return
	}

	// Mirror the IdP's display name + profile picture into the local row
	// so the frontend can show a real face + name. Username only fills
	// when it's still empty (admin-set values are never overwritten);
	// avatar refreshes every login since picture URLs rotate at the IdP.
	if err := h.userStore.BackfillSSOProfile(user.ID, claims.Name, claims.Picture); err != nil {
		log.Printf("sso profile backfill failed for user %d: %v", user.ID, err)
		// Non-fatal — proceed with login.
	} else if claims.Name != "" || claims.Picture != "" {
		// Re-fetch so the JWT/sub fallback below sees the freshly-written
		// username (otherwise a brand-new user would still have sub=email
		// for one extra login until they refresh).
		if refreshed, err := h.userStore.GetUserByID(user.ID); err == nil && refreshed != nil {
			user = refreshed
		}
	}

	// SSO mode skips 2FA — the IdP owns MFA. Mint the full mdnest JWT
	// directly. `totp_enabled` is always false in this mode.
	//
	// `sub` falls back through username → IdP display name → email so the
	// frontend always has something human-readable to show, even when the
	// users row was created via a minimal SQL INSERT (username NULL because
	// migration 005 made it nullable).
	sub := user.Username
	if sub == "" {
		sub = claims.Name
	}
	if sub == "" {
		sub = claims.Email
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":          sub,
		"user_id":      user.ID,
		"role":         user.Role,
		"totp_enabled": false,
		"iat":          time.Now().Unix(),
		"exp":          time.Now().Add(30 * 24 * time.Hour).Unix(),
	})
	signed, err := token.SignedString(h.secret)
	if err != nil {
		log.Printf("sso jwt sign: %v", err)
		h.redirectWithError(w, r, "/", "sso_internal")
		return
	}

	log.Printf("sso login: %s (user_id=%d)", user.Username, user.ID)

	// Redirect the browser to the frontend with the token in the URL
	// fragment. Fragments aren't sent to the server on subsequent requests
	// and won't leak into referer headers from third parties, which makes
	// them a reasonable transport for a one-shot token handoff.
	redirect := h.frontendURL + h.safeFrom(claims.From) + "#sso_token=" + url.QueryEscape(signed)
	http.Redirect(w, r, redirect, http.StatusFound)
}

func (h *SSOHandler) safeFrom(from string) string {
	p := sso.SanitizeFromPath(from)
	if p == "" || p == "/" {
		return "/"
	}
	return p
}

func (h *SSOHandler) redirectWithError(w http.ResponseWriter, r *http.Request, from, code string) {
	redirect := h.frontendURL + h.safeFrom(from) + "#sso_error=" + url.QueryEscape(code)
	http.Redirect(w, r, redirect, http.StatusFound)
}
