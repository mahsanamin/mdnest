package sso

import (
	"strings"
	"testing"
)

// checkIdentity is the only thing between "the IdP signed this token" and a
// session. On an internet-facing install with no proxy in front, it is the
// whole gate, so each rule is pinned in both directions: the case it must
// refuse, and the working install it must not break.

const googleIss = "https://accounts.google.com"

func boolp(b bool) *bool { return &b }

func clientWithDomains(domains ...string) *Client {
	return &Client{cfg: Config{AllowedDomains: domains}}
}

func TestCheckIdentity(t *testing.T) {
	cases := []struct {
		name    string
		domains []string
		issuer  string
		claims  identityClaims
		wantErr string // "" = must be accepted
	}{
		// email_verified
		{"google verified workspace user", []string{"example.com"}, googleIss,
			identityClaims{Email: "Alice@Example.com", EmailVerified: boolp(true), HostedDomain: "example.com"}, ""},
		{"unverified email refused (google)", nil, googleIss,
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(false)}, "not verified"},
		{"unverified email refused (generic IdP)", nil, "https://okta.example.com",
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(false)}, "not verified"},
		{"missing email_verified refused for google", nil, googleIss,
			identityClaims{Email: "alice@example.com"}, "no email_verified"},
		{"missing email_verified allowed for a non-google IdP (Entra omits it)", []string{"example.com"}, "https://login.microsoftonline.com/tid/v2.0",
			identityClaims{Email: "alice@example.com"}, ""},

		// hd
		{"google hd mismatch refused", []string{"example.com"}, googleIss,
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(true), HostedDomain: "other.com"}, "hosted domain"},
		{"google consumer account on a company address (no hd) refused", []string{"example.com"}, googleIss,
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(true)}, "hosted domain"},
		{"google bare-issuer form is still google", []string{"example.com"}, "accounts.google.com",
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(true)}, "hosted domain"},
		{"google with no allowlist does not require hd", nil, googleIss,
			identityClaims{Email: "alice@gmail.com", EmailVerified: boolp(true)}, ""},
		{"non-google IdP without hd still allowed", []string{"example.com"}, "https://okta.example.com",
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(true)}, ""},

		// pre-existing rules keep working
		{"email domain not allowed", []string{"example.com"}, "https://okta.example.com",
			identityClaims{Email: "alice@evil.com", EmailVerified: boolp(true)}, "SSO_ALLOWED_DOMAINS"},
		{"no email claim", nil, googleIss, identityClaims{EmailVerified: boolp(true)}, "no email"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			email, err := clientWithDomains(tc.domains...).checkIdentity(tc.issuer, tc.claims)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("want accepted, got %v", err)
				}
				if email != strings.ToLower(strings.TrimSpace(tc.claims.Email)) {
					t.Fatalf("email not normalized: %q", email)
				}
				return
			}
			if err == nil {
				t.Fatalf("want refusal containing %q, got accepted (%q)", tc.wantErr, email)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}
