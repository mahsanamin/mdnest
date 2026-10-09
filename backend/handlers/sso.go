package handlers

import (
	"crypto/rand"
	"encoding/hex"
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
//   3. We look the email up in the local users table. By default there is NO
//      auto-provisioning — if the email isn't already invited, we redirect
//      back to the frontend with an error in the hash. When the operator opts
//      in (autoProvisionUsers), an unknown but IdP-authenticated email is
//      instead created as a least-privilege collaborator on first login.
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
	// returnOrigins is the set of extra absolute origins (scheme://host[:port])
	// that /start may target for the post-login handoff, in addition to
	// frontendURL. Populated from SSO_ALLOWED_RETURN_ORIGINS. Used by the MCP
	// OAuth bridge so the minted JWT can be handed to the MCP server's callback
	// instead of the web UI. Empty by default → only frontendURL is allowed.
	returnOrigins map[string]bool
	// autoProvisionUsers, when true, creates a least-privilege collaborator
	// for an unknown but IdP-authenticated email instead of rejecting it.
	// Off by default. The operator opts in only when they trust their IdP to
	// gate who may obtain a token (e.g. a domain-restricted enterprise IdP).
	autoProvisionUsers bool
}

// NewSSOHandler wires an SSO client to a user store. frontendURL is the
// absolute origin of the web UI ("https://notes.example.com"), used to
// redirect the browser back after a successful (or failed) login.
// allowedReturnOrigins is an optional allowlist of extra absolute origins the
// post-login handoff may target (for the MCP OAuth bridge); nil/empty keeps the
// default behavior of only redirecting to frontendURL. autoProvisionUsers
// creates a least-privilege collaborator for an unknown IdP-authenticated
// email instead of rejecting it; false keeps the invite-only default.
func NewSSOHandler(client *sso.Client, userStore store.UserStore, jwtSecret, frontendURL string, secureCookie bool, allowedReturnOrigins []string, autoProvisionUsers bool) *SSOHandler {
	origins := make(map[string]bool, len(allowedReturnOrigins))
	for _, o := range allowedReturnOrigins {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			origins[o] = true
		}
	}
	return &SSOHandler{
		client:             client,
		userStore:          userStore,
		secret:             []byte(jwtSecret),
		frontendURL:        strings.TrimRight(frontendURL, "/"),
		secureCookie:       secureCookie,
		returnOrigins:      origins,
		autoProvisionUsers: autoProvisionUsers,
	}
}

// returnOriginAllowed reports whether an absolute origin is permitted as the
// post-login handoff target. The frontend origin is always allowed; any extra
// origin must be present in the configured allowlist.
func (h *SSOHandler) returnOriginAllowed(origin string) bool {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return false
	}
	if origin == h.frontendURL {
		return true
	}
	return h.returnOrigins[origin]
}

// handoffBase returns the absolute origin the post-login redirect must target.
// It defaults to the frontend origin and only switches to a caller-supplied
// return origin when that origin is on the allowlist (the MCP OAuth bridge).
// Centralizing the decision keeps /callback from drifting away from the gate
// applied at /start, so a normal login can never be diverted off the frontend.
func (h *SSOHandler) handoffBase(returnOrigin string) string {
	if returnOrigin != "" && h.returnOriginAllowed(returnOrigin) {
		return strings.TrimRight(returnOrigin, "/")
	}
	return h.frontendURL
}

// HandleStart redirects the browser to the IdP's authorize URL.
// GET /api/auth/sso/start?from=/path/to/return/to
func (h *SSOHandler) HandleStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	from := sso.SanitizeFromPath(r.URL.Query().Get("from"))
	// Optional, allowlisted handoff target (MCP OAuth bridge). Ignored unless
	// the exact origin is permitted; otherwise we fall back to the frontend.
	returnOrigin := ""
	if ro := r.URL.Query().Get("return_origin"); ro != "" && h.returnOriginAllowed(ro) {
		returnOrigin = strings.TrimRight(strings.TrimSpace(ro), "/")
	}
	authURL, cookieValue, err := h.client.BuildAuthURL(from, returnOrigin)
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
		if !h.autoProvisionUsers {
			log.Printf("sso rejected: %s has no mdnest account", claims.Email)
			h.redirectWithError(w, r, "/", "sso_not_invited")
			return
		}
		// Opt-in auto-provisioning: the IdP has already authenticated this
		// identity, so create a least-privilege collaborator. It has no
		// namespace access until granted (or until a personal namespace is
		// auto-provisioned), so a fresh account can see nothing by default.
		// The password is random and unusable — SSO users never password-auth.
		provisioned, perr := h.provisionSSOUser(claims.Email, claims.Name)
		if perr != nil {
			log.Printf("sso auto-provision failed for %s: %v", claims.Email, perr)
			h.redirectWithError(w, r, "/", "sso_internal")
			return
		}
		log.Printf("sso auto-provisioned %s as collaborator (id %d)", claims.Email, provisioned.ID)
		user = provisioned
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
		// SSO tokens snapshot IdP group membership (used for authorization),
		// so they use a short TTL that bounds how long a stale snapshot can
		// outlive an IdP change. The IdP owns the session UX; re-auth within
		// an active IdP session is typically silent.
		"exp": time.Now().Add(ssoJWTTTL()).Unix(),
	})
	// Carry the IdP group IDs (snapshot at login) so access-group membership
	// can be resolved per request. Omitted when the IdP emits none.
	if len(claims.Groups) > 0 {
		token.Claims.(jwt.MapClaims)["groups"] = claims.Groups
	}
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
	//
	// When the flow was initiated by an allowlisted return origin (the MCP
	// OAuth bridge), hand the token to that origin's callback instead of the
	// web UI. The origin was validated at /start and is carried, signed,
	// inside the state cookie — we re-check it here as defense in depth.
	redirect := h.handoffBase(claims.ReturnOrigin) + h.safeFrom(claims.From) + "#sso_token=" + url.QueryEscape(signed)
	http.Redirect(w, r, redirect, http.StatusFound)
}

func (h *SSOHandler) safeFrom(from string) string {
	p := sso.SanitizeFromPath(from)
	if p == "" || p == "/" {
		return "/"
	}
	return p
}

// provisionSSOUser creates a least-privilege collaborator for an
// IdP-authenticated email that has no local account yet. The username is
// derived from the IdP display name (falling back to the email local part),
// and the password is random and unusable — SSO users authenticate through
// the IdP, never with a password.
func (h *SSOHandler) provisionSSOUser(email, displayName string) (*store.User, error) {
	username := strings.TrimSpace(displayName)
	if username == "" {
		if i := strings.IndexByte(email, '@'); i > 0 {
			username = email[:i]
		} else {
			username = email
		}
	}
	var buf [24]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return nil, err
	}
	pw := hex.EncodeToString(buf[:])

	user, err := h.userStore.CreateUser(email, username, pw, "collaborator", nil)
	if err != nil && store.IsUniqueViolation(err) {
		// Display names are not unique (two "Alice Smith" in a directory), but
		// users.username is. We only reach provisioning when the email has no
		// account yet, so the email is a collision-free fallback username.
		user, err = h.userStore.CreateUser(email, email, pw, "collaborator", nil)
	}
	if err != nil {
		return nil, err
	}

	// CreateUser hardcodes must_change_password = true, which is inert for SSO
	// users (only the password-login path reads it) but diverges from the
	// Firebase federated path, which sets it false. Clear it so both IdP paths
	// behave the same.
	if cerr := h.userStore.ClearMustChangePassword(user.ID); cerr != nil {
		log.Printf("sso auto-provision: could not clear must_change_password for user %d: %v", user.ID, cerr)
	}
	return user, nil
}

func (h *SSOHandler) redirectWithError(w http.ResponseWriter, r *http.Request, from, code string) {
	redirect := h.frontendURL + h.safeFrom(from) + "#sso_error=" + url.QueryEscape(code)
	http.Redirect(w, r, redirect, http.StatusFound)
}
