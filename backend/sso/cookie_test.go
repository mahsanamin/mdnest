package sso

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The MCP OAuth bridge threads an allowlisted return origin through the signed
// state cookie so /callback can re-validate it. These tests pin down that the
// value survives the round-trip, that a normal login carries no return origin,
// and that any tampering with the cookie is rejected — i.e. a client cannot
// forge or alter the handoff target.

func roundTrip(t *testing.T, sc stateCookie, secret []byte) stateCookie {
	t.Helper()
	payload, err := json.Marshal(sc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	signed := signCookiePayload(payload, secret)
	got, ok := verifyCookiePayload(signed, secret)
	if !ok {
		t.Fatal("verifyCookiePayload rejected a freshly signed cookie")
	}
	var out stateCookie
	if err := json.Unmarshal(got, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func TestStateCookie_ReturnOriginRoundTrips(t *testing.T) {
	secret := []byte("test-secret")
	in := stateCookie{
		State:        "state",
		Nonce:        "nonce",
		CodeVerifier: "verifier",
		From:         "/notes",
		ReturnOrigin: "https://mcp.example.com",
		ExpiresAt:    time.Now().Add(10 * time.Minute).Unix(),
	}
	out := roundTrip(t, in, secret)
	if out.ReturnOrigin != in.ReturnOrigin {
		t.Fatalf("ReturnOrigin = %q, want %q", out.ReturnOrigin, in.ReturnOrigin)
	}
}

func TestStateCookie_NormalLoginHasNoReturnOrigin(t *testing.T) {
	secret := []byte("test-secret")
	in := stateCookie{
		State:     "state",
		Nonce:     "nonce",
		From:      "/",
		ExpiresAt: time.Now().Add(10 * time.Minute).Unix(),
	}
	out := roundTrip(t, in, secret)
	if out.ReturnOrigin != "" {
		t.Fatalf("ReturnOrigin = %q, want empty for a normal login", out.ReturnOrigin)
	}
}

func TestStateCookie_TamperedReturnOriginRejected(t *testing.T) {
	secret := []byte("test-secret")
	in := stateCookie{
		State:        "state",
		Nonce:        "nonce",
		From:         "/",
		ReturnOrigin: "https://mcp.example.com",
		ExpiresAt:    time.Now().Add(10 * time.Minute).Unix(),
	}
	payload, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	signed := signCookiePayload(payload, secret)

	parts := strings.SplitN(signed, ".", 2)
	if len(parts) != 2 {
		t.Fatalf("signed cookie has unexpected shape: %q", signed)
	}
	// Flip the last byte of the base64 payload so it decodes to a different
	// stateCookie whose signature no longer matches.
	body := []byte(parts[0])
	if body[len(body)-1] == 'A' {
		body[len(body)-1] = 'B'
	} else {
		body[len(body)-1] = 'A'
	}
	tampered := string(body) + "." + parts[1]

	if _, ok := verifyCookiePayload(tampered, secret); ok {
		t.Fatal("verifyCookiePayload accepted a tampered cookie")
	}

	// A different secret must also be rejected (cookie can't be re-signed by a
	// client that doesn't hold MDNEST_JWT_SECRET).
	if _, ok := verifyCookiePayload(signed, []byte("other-secret")); ok {
		t.Fatal("verifyCookiePayload accepted a cookie signed with a different secret")
	}
}
