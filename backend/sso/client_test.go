package sso

import (
	"encoding/json"
	"strings"
	"testing"
)

// checkIdentity is the only thing between "the IdP signed this token" and a
// session. On an internet-facing install with no proxy in front, it is the
// whole gate, so each rule is pinned in both directions: the case it must
// refuse, and the working install it must not break.

const googleIss = "https://accounts.google.com"

func boolp(b bool) *flexBool { v := flexBool(b); return &v }

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
		{"google consumer account on a company address (no hd) refused", []string{"example.com"}, googleIss,
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(true)}, "no hd claim"},
		{"google bare-issuer form is still google", []string{"example.com"}, "accounts.google.com",
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(true)}, "no hd claim"},
		// hd is the org's PRIMARY domain: a user on a secondary domain carries
		// the primary as hd, and must not be locked out.
		{"google workspace user on a secondary domain allowed", []string{"b.example"}, googleIss,
			identityClaims{Email: "alice@b.example", EmailVerified: boolp(true), HostedDomain: "a.example"}, ""},
		// gmail.com accounts never have hd; listing gmail.com admits them on purpose.
		{"gmail.com in the allowlist admits consumer gmail", []string{"gmail.com"}, googleIss,
			identityClaims{Email: "alice@gmail.com", EmailVerified: boolp(true)}, ""},
		{"gmail.com allowlisted does not open other domains", []string{"gmail.com", "example.com"}, googleIss,
			identityClaims{Email: "alice@example.com", EmailVerified: boolp(true)}, "no hd claim"},
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

// email_verified is a boolean in the spec, but some IdPs send "true"/"false".
// A strict bool failed the whole claim decode, so sign-in broke on those IdPs.
func TestEmailVerifiedDecoding(t *testing.T) {
	cases := []struct {
		raw     string
		want    *bool // nil = claim absent
		wantErr bool
	}{
		{`{"email":"a@x.com","email_verified":true}`, ptr(true), false},
		{`{"email":"a@x.com","email_verified":false}`, ptr(false), false},
		{`{"email":"a@x.com","email_verified":"true"}`, ptr(true), false},
		{`{"email":"a@x.com","email_verified":"False"}`, ptr(false), false},
		{`{"email":"a@x.com"}`, nil, false},
		{`{"email":"a@x.com","email_verified":"maybe"}`, nil, true},
	}
	for _, tc := range cases {
		var c identityClaims
		err := json.Unmarshal([]byte(tc.raw), &c)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%s: want decode error", tc.raw)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", tc.raw, err)
		}
		switch {
		case tc.want == nil && c.EmailVerified != nil:
			t.Fatalf("%s: want absent, got %v", tc.raw, *c.EmailVerified)
		case tc.want != nil && (c.EmailVerified == nil || bool(*c.EmailVerified) != *tc.want):
			t.Fatalf("%s: want %v, got %v", tc.raw, *tc.want, c.EmailVerified)
		}
	}
	// A string "false" must still be refused by the gate, not just decoded.
	var c identityClaims
	_ = json.Unmarshal([]byte(`{"email":"a@x.com","email_verified":"false"}`), &c)
	if _, err := clientWithDomains().checkIdentity("https://cognito.example", c); err == nil {
		t.Fatal(`email_verified "false" (string) was accepted`)
	}
}

func ptr(b bool) *bool { return &b }
