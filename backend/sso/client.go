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
//   - The IdP must have verified the email; for Google, the account must also
//     belong to a Workspace (`hd`) unless it is a gmail.com address. See checkIdentity.
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
	GroupsClaim    string   // optional ID-token claim holding the user's group IDs (e.g. "groups"); empty = disabled
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
	// ReturnOrigin is an optional absolute origin (scheme://host[:port]) that
	// the caller of /start requested the post-login handoff be sent to instead
	// of the default frontend origin. It is only ever set when the origin was
	// already validated against the server-side allowlist, and it travels
	// inside this HMAC-signed cookie so a client cannot tamper with it. Used by
	// the MCP OAuth bridge so the minted JWT can land on the MCP server's
	// callback. Empty for the normal browser login.
	ReturnOrigin string `json:"r,omitempty"`
	ExpiresAt    int64  `json:"e"`
}

// BuildAuthURL returns the provider's authorization URL and the cookie value
// that must be Set-Cookie'd back to the browser.
// `from` is where to send the user after a successful login.
// `returnOrigin` is an optional, already-allowlisted absolute origin that the
// post-login handoff should target instead of the default frontend origin
// (used by the MCP OAuth bridge). Pass "" for the normal browser login.
func (c *Client) BuildAuthURL(from, returnOrigin string) (authURL, cookieValue string, err error) {
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
		ReturnOrigin: returnOrigin,
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
	Picture       string // OIDC `picture` claim (profile image URL); empty if the IdP doesn't provide one
	Subject       string
	Groups        []string // IdP group IDs from the configured GroupsClaim; empty when disabled or absent
	From          string   // where the original request wanted to land
	ReturnOrigin  string   // optional allowlisted origin for the handoff (MCP OAuth bridge); empty for normal login
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

	var claims identityClaims
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("claim decode: %w", err)
	}
	email, err := c.checkIdentity(idToken.Issuer, claims)
	if err != nil {
		return nil, err
	}

	return &VerifiedClaims{
		Email:         email,
		EmailVerified: claims.EmailVerified != nil && bool(*claims.EmailVerified),
		Name:          claims.Name,
		Picture:       claims.Picture,
		Subject:       idToken.Subject,
		Groups:        c.extractGroups(idToken),
		From:          sc.From,
		ReturnOrigin:  sc.ReturnOrigin,
	}, nil
}

// extractGroups pulls the configured groups claim (GroupsClaim) from the ID
// token as a list of group IDs. Returns nil when the feature is disabled
// (empty GroupsClaim) or the claim is absent/malformed — the IdP's group
// values are treated as opaque strings.
func (c *Client) extractGroups(idToken *oidc.IDToken) []string {
	if c.cfg.GroupsClaim == "" {
		return nil
	}
	var all map[string]json.RawMessage
	if err := idToken.Claims(&all); err != nil {
		return nil
	}
	raw, ok := all[c.cfg.GroupsClaim]
	if !ok {
		return nil
	}
	var groups []string
	if err := json.Unmarshal(raw, &groups); err != nil {
		return nil
	}
	out := groups[:0]
	for _, g := range groups {
		if g = strings.TrimSpace(g); g != "" {
			out = append(out, g)
		}
	}
	return out
}

// identityClaims is the subset of ID-token claims that decides WHO signed in.
// EmailVerified is a pointer so "claim absent" stays distinguishable from
// "claim present and false" — the two get different treatment below.
type identityClaims struct {
	Email         string    `json:"email"`
	EmailVerified *flexBool `json:"email_verified"`
	HostedDomain  string    `json:"hd"`
	Name          string    `json:"name"`
	Picture       string    `json:"picture"`
}

// flexBool decodes a JSON boolean or its string form ("true"/"false"). The
// OIDC spec says email_verified is a boolean, but some IdPs (AWS Cognito among
// them) send the string, and a strict bool made the whole claim decode fail —
// so sign-in broke outright on those IdPs rather than just skipping a check.
type flexBool bool

func (b *flexBool) UnmarshalJSON(data []byte) error {
	switch strings.ToLower(strings.Trim(string(data), `"`)) {
	case "true":
		*b = true
	case "false":
		*b = false
	default:
		return fmt.Errorf("email_verified: not a boolean: %s", data)
	}
	return nil
}

// isGoogleIssuer reports whether iss is Google's OIDC issuer. Google puts
// either form in `iss`, so both are accepted.
func isGoogleIssuer(iss string) bool {
	iss = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(iss)), "/")
	return iss == "https://accounts.google.com" || iss == "accounts.google.com"
}

// googleConsumerDomains are Google's own address domains. An account there is
// a personal Google account by construction, never has `hd`, and its address
// is owned by Google rather than by whoever registered it — so the Workspace
// check below does not apply to it. An operator who lists gmail.com in
// SSO_ALLOWED_DOMAINS is admitting consumer accounts on purpose.
var googleConsumerDomains = map[string]bool{"gmail.com": true, "googlemail.com": true}

// checkIdentity is the gate between "the IdP signed this token" and "this is
// someone we let in". It returns the normalized email, or why it refused.
// Pure (no network), so every rule is unit-tested without an IdP.
//
//   - email_verified: an email the IdP itself has not verified is not an
//     identity — anyone can type one into a consumer account. A claim that is
//     present and false is refused for every IdP. An ABSENT claim is refused
//     for Google (which always sends it, so absence means something is wrong)
//     and allowed for other IdPs, because Microsoft Entra ID omits it by
//     default and refusing there would lock out working installs.
//   - hd (Google hosted domain): SSO_ALLOWED_DOMAINS checks the email's
//     domain, but a personal Google account can be registered on a company
//     address, and its email then passes that check. Such an account has no
//     `hd` — `hd` is only present for accounts a Google Workspace manages — so
//     for Google, when SSO_ALLOWED_DOMAINS is set, `hd` must be present.
//     Presence is the test, not membership of the list: `hd` is the org's
//     PRIMARY domain, so a user on a secondary domain (alice@b.com in an org
//     whose primary is a.com) carries hd=a.com, and a Workspace can only issue
//     addresses on domains it has verified, so the email-domain check above
//     already pins which org it is. Google's own consumer domains (gmail.com)
//     are exempt: those accounts never have `hd`. `hd` is Google-specific:
//     other IdPs never send it and are not checked for it, so
//     Okta/Entra/Keycloak/Clerk installs see no new failure mode.
func (c *Client) checkIdentity(issuer string, claims identityClaims) (string, error) {
	if claims.Email == "" {
		return "", errors.New("id_token has no email claim")
	}
	email := strings.ToLower(strings.TrimSpace(claims.Email))
	google := isGoogleIssuer(issuer)
	if claims.EmailVerified != nil && !*claims.EmailVerified {
		return "", fmt.Errorf("email not verified by the IdP: %s", email)
	}
	if claims.EmailVerified == nil && google {
		return "", fmt.Errorf("id_token has no email_verified claim: %s", email)
	}
	if !c.domainAllowed(email) {
		return "", fmt.Errorf("email domain not in SSO_ALLOWED_DOMAINS: %s", email)
	}
	if google && len(c.cfg.AllowedDomains) > 0 && strings.TrimSpace(claims.HostedDomain) == "" &&
		!googleConsumerDomains[email[strings.LastIndex(email, "@")+1:]] {
		return "", fmt.Errorf("google account is not in a Workspace (no hd claim), so its address is not proof of the domain: %s", email)
	}
	return email, nil
}

func (c *Client) domainAllowed(email string) bool {
	if len(c.cfg.AllowedDomains) == 0 {
		return true // no allowlist configured = accept anything
	}
	at := strings.LastIndex(email, "@")
	if at < 0 {
		return false
	}
	return c.domainInList(email[at+1:])
}

// domainInList reports whether domain is one of SSO_ALLOWED_DOMAINS. An empty
// domain never matches.
func (c *Client) domainInList(domain string) bool {
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" {
		return false
	}
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
