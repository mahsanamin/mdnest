// Package sso implements a small OIDC relying-party so the mdnest backend can
// accept "sign in with <corporate IdP>" logins alongside (or instead of) its
// built-in username/password and Firebase flows.
//
// Design constraints from the product side:
//   - Generic OIDC, not locked to Google. Any provider with a discoverable
//     OIDC issuer works (Google, Okta, Microsoft Entra, Keycloak, Auth0, etc.).
//   - Email is the primary identity key. An incoming user must already exist
//     in the mdnest users table (matched by lowercased email) — we do NOT
//     auto-provision. Roles and grants continue to live in Postgres.
//   - Optional domain allowlist (SSO_ALLOWED_DOMAINS) as a second defense.
//   - No server-side session store: the CSRF/nonce state is carried in a
//     short-lived signed cookie.
//   - 2FA is skipped in SSO mode (the IdP owns MFA).
package sso

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Config is the startup configuration for the SSO client.
type Config struct {
	IssuerURL      string   // e.g. https://accounts.google.com
	ClientID       string   // OAuth client ID from the IdP
	ClientSecret   string   // OAuth client secret from the IdP
	RedirectURL    string   // absolute URL of our callback endpoint
	AllowedDomains []string // optional lowercase email-domain allowlist
	Scopes         []string // defaults to ["openid","email","profile"]
	CookieSecret   []byte   // used to HMAC the state cookie (reuses JWT secret)
}

// Client wraps the OIDC provider + OAuth2 config. Safe for concurrent use.
type Client struct {
	cfg      Config
	provider *oidc.Provider
	oauth2   *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// NewClient discovers the provider metadata and returns a ready client.
func NewClient(ctx context.Context, cfg Config) (*Client, error) {
	if cfg.IssuerURL == "" {
		return nil, errors.New("SSO_ISSUER_URL is required")
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, errors.New("SSO_CLIENT_ID and SSO_CLIENT_SECRET are required")
	}
	if cfg.RedirectURL == "" {
		return nil, errors.New("SSO redirect URL could not be derived; set SSO_REDIRECT_URL or FRONTEND_ORIGIN")
	}
	if len(cfg.CookieSecret) == 0 {
		return nil, errors.New("SSO cookie secret must not be empty (reuses MDNEST_JWT_SECRET)")
	}

	scopes := cfg.Scopes
	if len(scopes) == 0 {
		scopes = []string{oidc.ScopeOpenID, "email", "profile"}
	}

	provider, err := oidc.NewProvider(ctx, cfg.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery failed for %s: %w", cfg.IssuerURL, err)
	}

	c := &Client{
		cfg:      cfg,
		provider: provider,
		oauth2: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       scopes,
		},
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
	}
	return c, nil
}

// stateCookieName is the short-lived cookie that carries the CSRF state,
// the PKCE verifier, the OIDC nonce, and the post-login "from" URL. We HMAC
// it with the JWT secret so it can't be forged or replayed from another
// client. TTL is 10 minutes, which is plenty for an interactive login.
const stateCookieName = "mdnest_sso_state"

type stateCookie struct {
	State        string `json:"s"`
	Nonce        string `json:"n"`
	CodeVerifier string `json:"v"`
	From         string `json:"f"`
	ExpiresAt    int64  `json:"e"`
}

// BuildAuthURL returns the provider's authorization URL and the cookie value
// that must be Set-Cookie'd back to the browser.
// `from` is where to send the user after a successful login.
func (c *Client) BuildAuthURL(from string) (authURL, cookieValue string, err error) {
	state, err := randomToken(32)
	if err != nil {
		return "", "", err
	}
	nonce, err := randomToken(32)
	if err != nil {
		return "", "", err
	}
	verifier, err := randomToken(48)
	if err != nil {
		return "", "", err
	}

	sc := stateCookie{
		State:        state,
		Nonce:        nonce,
		CodeVerifier: verifier,
		From:         from,
		ExpiresAt:    time.Now().Add(10 * time.Minute).Unix(),
	}
	payload, err := json.Marshal(sc)
	if err != nil {
		return "", "", err
	}
	signed := signCookiePayload(payload, c.cfg.CookieSecret)

	challenge := oauth2.S256ChallengeFromVerifier(verifier)
	authURL = c.oauth2.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
	return authURL, signed, nil
}

// CookieName is the name of the state cookie (exposed so handlers can set/clear it).
func (c *Client) CookieName() string { return stateCookieName }

// VerifiedClaims is the trimmed set of OIDC claims we care about.
type VerifiedClaims struct {
	Email         string
	EmailVerified bool
	Name          string
	Subject       string
	From          string // where the original request wanted to land
}

// ExchangeCallback validates the callback query parameters, exchanges the
// code for tokens, verifies the ID token, and returns the extracted claims.
// The cookieValue is the raw value of the state cookie read from the request.
func (c *Client) ExchangeCallback(ctx context.Context, cookieValue, state, code string) (*VerifiedClaims, error) {
	if cookieValue == "" {
		return nil, errors.New("missing state cookie")
	}
	payload, ok := verifyCookiePayload(cookieValue, c.cfg.CookieSecret)
	if !ok {
		return nil, errors.New("state cookie signature invalid")
	}
	var sc stateCookie
	if err := json.Unmarshal(payload, &sc); err != nil {
		return nil, fmt.Errorf("state cookie malformed: %w", err)
	}
	if time.Now().Unix() > sc.ExpiresAt {
		return nil, errors.New("login state expired — try again")
	}
	if state == "" || !hmac.Equal([]byte(state), []byte(sc.State)) {
		return nil, errors.New("state mismatch")
	}
	if code == "" {
		return nil, errors.New("missing authorization code")
	}

	tok, err := c.oauth2.Exchange(ctx, code,
		oauth2.SetAuthURLParam("code_verifier", sc.CodeVerifier),
	)
	if err != nil {
		return nil, fmt.Errorf("oauth2 exchange: %w", err)
	}
	rawIDToken, ok := tok.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return nil, errors.New("no id_token in token response")
	}
	idToken, err := c.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("id_token verify: %w", err)
	}
	if idToken.Nonce != sc.Nonce {
		return nil, errors.New("id_token nonce mismatch")
	}

	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("claim decode: %w", err)
	}
	if claims.Email == "" {
		return nil, errors.New("id_token has no email claim")
	}
	email := strings.ToLower(strings.TrimSpace(claims.Email))
	if !c.domainAllowed(email) {
		return nil, fmt.Errorf("email domain not in SSO_ALLOWED_DOMAINS: %s", email)
	}

	return &VerifiedClaims{
		Email:         email,
		EmailVerified: claims.EmailVerified,
		Name:          claims.Name,
		Subject:       idToken.Subject,
		From:          sc.From,
	}, nil
}

func (c *Client) domainAllowed(email string) bool {
	if len(c.cfg.AllowedDomains) == 0 {
		return true // no allowlist configured = accept anything
	}
	at := strings.LastIndex(email, "@")
	if at < 0 {
		return false
	}
	domain := strings.ToLower(email[at+1:])
	for _, d := range c.cfg.AllowedDomains {
		if strings.ToLower(strings.TrimSpace(d)) == domain {
			return true
		}
	}
	return false
}

// --- helpers ---

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// signCookiePayload returns base64(payload) + "." + base64(hmac_sha256(payload)).
func signCookiePayload(payload, secret []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func verifyCookiePayload(cookieValue string, secret []byte) ([]byte, bool) {
	parts := strings.SplitN(cookieValue, ".", 2)
	if len(parts) != 2 {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, false
	}
	return payload, true
}

// SanitizeFromPath strips off absolute URLs and returns a safe path-only
// "from" value for the post-login redirect. Prevents open-redirect abuse
// by refusing any value that doesn't start with a single leading slash.
func SanitizeFromPath(raw string) string {
	if raw == "" {
		return "/"
	}
	// Reject full URLs outright.
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") || strings.HasPrefix(raw, "//") {
		return "/"
	}
	if u, err := url.Parse(raw); err == nil {
		if u.Scheme != "" || u.Host != "" {
			return "/"
		}
		// Path only. We deliberately drop fragments and queries:
		//   - Fragments collide with our #sso_token= handoff. URLs only allow
		//     one #, so combining /#some-note + #sso_token=… produces a
		//     concatenated mess that the frontend can't parse and the user
		//     gets stuck on the login screen.
		//   - Queries could be used to smuggle tokens or open-redirect markers.
		// Note navigation isn't worth the breakage — users land at the root
		// after SSO and re-navigate from there.
		out := u.Path
		if !strings.HasPrefix(out, "/") {
			return "/"
		}
		return out
	}
	return "/"
}

// SetStateCookie is a small helper so handlers in the caller package don't
// need to know the cookie-name / flag conventions.
func (c *Client) SetStateCookie(w http.ResponseWriter, value string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode, // Lax is required so the cookie survives the IdP redirect
		MaxAge:   int((10 * time.Minute).Seconds()),
	})
}

// ClearStateCookie removes the state cookie once the callback has consumed it.
func (c *Client) ClearStateCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
