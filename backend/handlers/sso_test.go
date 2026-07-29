package handlers

import (
	"testing"

	"github.com/lib/pq"
	"github.com/mdnest/mdnest/backend/store"
)

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
