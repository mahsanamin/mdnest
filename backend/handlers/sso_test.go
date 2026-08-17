package handlers

import (
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/mdnest/mdnest/backend/store"
)

// The MCP OAuth bridge lets /api/auth/sso/start carry an optional return_origin
// so the minted JWT can be handed to the MCP server's callback instead of the
// web UI. That extra handoff target is gated by an allowlist. These tests pin
// the gate down so a change here can never silently turn the normal browser
// login into an open redirect, and so a normal login always lands on the
// frontend regardless of what a caller passes.

const testFrontend = "https://notes.example.com"

// SSO tokens snapshot IdP group membership, which drives access-group
// authorization, so their lifetime bounds how long a revoked IdP group can
// still grant access. Pin that the SSO TTL stays short and well under the
// "remember me" lifetime, so it can't be quietly bumped back to the year-long
// token and silently widen the offboarding window.
func TestSSOJWTTTLIsShortLived(t *testing.T) {
	ttl := ssoJWTTTL()
	if ttl <= 0 || ttl > 24*time.Hour {
		t.Fatalf("SSO token TTL must be short (<=24h) to bound stale group snapshots, got %s", ttl)
	}
	if ttl >= jwtTTL(true) {
		t.Fatalf("SSO token TTL (%s) must be far shorter than the remember-me TTL (%s)", ttl, jwtTTL(true))
	}
}

func TestReturnOriginAllowed_EmptyAllowlist(t *testing.T) {
	// No SSO_ALLOWED_RETURN_ORIGINS configured — the default for every existing
	// install. Only the frontend origin may ever be the handoff target.
	h := NewSSOHandler(nil, nil, "secret", testFrontend, false, nil, false)

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
	}, false)

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
	h := NewSSOHandler(nil, nil, "secret", testFrontend, false, nil, false)

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
	}, false)

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
// fakeUserStore implements just enough of store.UserStore to drive
// provisionSSOUser. Unused methods are inherited from the embedded interface
// (nil) and panic if called, which keeps the tested surface honest.
type fakeUserStore struct {
	store.UserStore
	taken   map[string]bool // usernames already created
	created []*store.User
	cleared []int // user IDs passed to ClearMustChangePassword
	nextID  int
}

func newFakeUserStore() *fakeUserStore {
	return &fakeUserStore{taken: map[string]bool{}}
}

func (f *fakeUserStore) CreateUser(email, username, password, role string, invitedBy *int) (*store.User, error) {
	if f.taken[username] {
		return nil, &pq.Error{Code: "23505", Message: "duplicate key value violates unique constraint \"users_username_key\""}
	}
	f.taken[username] = true
	f.nextID++
	u := &store.User{ID: f.nextID, Email: email, Username: username, Role: role, MustChangePassword: true}
	f.created = append(f.created, u)
	return u, nil
}

func (f *fakeUserStore) ClearMustChangePassword(userID int) error {
	f.cleared = append(f.cleared, userID)
	return nil
}

// A duplicate IdP display name must not lock the second user out: the unique
// violation on username triggers a fallback to the (unique) email. This is the
// blocking bug the maintainer flagged.
func TestProvisionSSOUser_CollisionFallsBackToEmail(t *testing.T) {
	fs := newFakeUserStore()
	h := &SSOHandler{userStore: fs}

	u1, err := h.provisionSSOUser("alice@example.com", "Alice Smith")
	if err != nil {
		t.Fatalf("first provision: %v", err)
	}
	if u1.Username != "Alice Smith" {
		t.Errorf("first user username = %q, want %q", u1.Username, "Alice Smith")
	}

	u2, err := h.provisionSSOUser("alice@other.example.com", "Alice Smith")
	if err != nil {
		t.Fatalf("second provision (duplicate display name) must succeed, got: %v", err)
	}
	if u2.Username != "alice@other.example.com" {
		t.Errorf("second user username = %q, want the email fallback %q", u2.Username, "alice@other.example.com")
	}
}

// A provisioned user is a least-privilege collaborator with no grants, and
// must_change_password is cleared so SSO matches the Firebase path.
func TestProvisionSSOUser_LeastPrivilegeCollaborator(t *testing.T) {
	fs := newFakeUserStore()
	h := &SSOHandler{userStore: fs}

	u, err := h.provisionSSOUser("bob@example.com", "Bob")
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if u.Role != "collaborator" {
		t.Errorf("role = %q, want collaborator", u.Role)
	}
	// provisionSSOUser must create exactly the one collaborator and never a
	// grant — a fresh account can see nothing until explicitly granted.
	if len(fs.created) != 1 {
		t.Errorf("created %d users, want exactly 1 (no side effects)", len(fs.created))
	}
	if len(fs.cleared) != 1 || fs.cleared[0] != u.ID {
		t.Errorf("ClearMustChangePassword calls = %v, want [%d]", fs.cleared, u.ID)
	}
}

// An empty/whitespace IdP display name falls back to the email local part.
func TestProvisionSSOUser_EmptyDisplayNameUsesEmailLocalPart(t *testing.T) {
	fs := newFakeUserStore()
	h := &SSOHandler{userStore: fs}

	u, err := h.provisionSSOUser("carol@example.com", "   ")
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if u.Username != "carol" {
		t.Errorf("username = %q, want email local-part %q", u.Username, "carol")
	}
}
