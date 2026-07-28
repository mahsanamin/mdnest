package handlers

import "testing"

// The MCP OAuth bridge lets /api/auth/sso/start carry an optional return_origin
// so the minted JWT can be handed to the MCP server's callback instead of the
// web UI. That extra handoff target is gated by an allowlist. These tests pin
// the gate down so a change here can never silently turn the normal browser
// login into an open redirect, and so a normal login always lands on the
// frontend regardless of what a caller passes.

const testFrontend = "https://notes.example.com"

func TestReturnOriginAllowed_EmptyAllowlist(t *testing.T) {
	// No SSO_ALLOWED_RETURN_ORIGINS configured — the default for every existing
	// install. Only the frontend origin may ever be the handoff target.
	h := NewSSOHandler(nil, nil, "secret", testFrontend, false, nil)

	cases := []struct {
		name   string
		origin string
		want   bool
	}{
		{"frontend origin", testFrontend, true},
		{"frontend origin with trailing slash", testFrontend + "/", true},
		{"empty string", "", false},
		{"arbitrary external origin", "https://evil.example.com", false},
		{"the mcp host (not allowlisted here)", "https://mcp.example.com", false},
		{"frontend host over plain http", "http://notes.example.com", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := h.returnOriginAllowed(tc.origin); got != tc.want {
				t.Fatalf("returnOriginAllowed(%q) = %v, want %v", tc.origin, got, tc.want)
			}
		})
	}
}

func TestReturnOriginAllowed_WithAllowlist(t *testing.T) {
	// A single extra origin allowlisted (the MCP host), plus a blank and a
	// trailing-slash entry that must be normalized away by the constructor.
	h := NewSSOHandler(nil, nil, "secret", testFrontend, false, []string{
		"https://mcp.example.com/",
		"   ",
		"",
	})

	cases := []struct {
		name   string
		origin string
		want   bool
	}{
		{"frontend origin still allowed", testFrontend, true},
		{"allowlisted mcp origin", "https://mcp.example.com", true},
		{"allowlisted mcp origin with trailing slash", "https://mcp.example.com/", true},
		{"allowlisted mcp origin with surrounding space", "  https://mcp.example.com  ", true},
		{"unlisted origin", "https://other.example.com", false},
		{"empty string", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := h.returnOriginAllowed(tc.origin); got != tc.want {
				t.Fatalf("returnOriginAllowed(%q) = %v, want %v", tc.origin, got, tc.want)
			}
		})
	}
}

func TestHandoffBase_EmptyAllowlist_AlwaysFrontend(t *testing.T) {
	// This is the login-regression guard: with no allowlist configured, the
	// post-login redirect base is the frontend for every input — the normal
	// browser login (empty return origin) and any injected origin alike.
	h := NewSSOHandler(nil, nil, "secret", testFrontend, false, nil)

	for _, origin := range []string{
		"",                          // normal browser login
		"https://mcp.example.com",   // would-be bridge target, not allowlisted
		"https://evil.example.com",  // outright injection attempt
		testFrontend + "/",          // frontend itself
	} {
		if got := h.handoffBase(origin); got != testFrontend {
			t.Fatalf("handoffBase(%q) = %q, want frontend %q", origin, got, testFrontend)
		}
	}
}

func TestHandoffBase_WithAllowlist(t *testing.T) {
	h := NewSSOHandler(nil, nil, "secret", testFrontend, false, []string{
		"https://mcp.example.com",
	})

	cases := []struct {
		name   string
		origin string
		want   string
	}{
		{"normal login falls back to frontend", "", testFrontend},
		{"allowlisted origin is honored", "https://mcp.example.com", "https://mcp.example.com"},
		{"allowlisted origin trailing slash trimmed", "https://mcp.example.com/", "https://mcp.example.com"},
		{"unlisted origin falls back to frontend", "https://other.example.com", testFrontend},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := h.handoffBase(tc.origin); got != tc.want {
				t.Fatalf("handoffBase(%q) = %q, want %q", tc.origin, got, tc.want)
			}
		})
	}
}
