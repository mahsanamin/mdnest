package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// usersOnlyStore satisfies store.UserStore but only implements ListUsers —
// the embedded nil interface covers the rest, which listUsers never calls.
type usersOnlyStore struct {
	store.UserStore
	users []store.User
}

func (u usersOnlyStore) ListUsers() ([]store.User, error) { return u.users, nil }

// nsAdminForNamespaces satisfies store.NamespaceAdminStore, reporting the
// caller as admin of a fixed set of namespaces.
type nsAdminForNamespaces struct {
	store.NamespaceAdminStore
	adminOf []string
}

func (n nsAdminForNamespaces) ListByUser(int) ([]string, error) { return n.adminOf, nil }
func (n nsAdminForNamespaces) IsAdminOf(_ int, ns string) (bool, error) {
	for _, a := range n.adminOf {
		if a == ns {
			return true, nil
		}
	}
	return false, nil
}

// grantStoreStub satisfies store.GrantStore; unused by listUsers.
type grantStoreStub struct{ store.GrantStore }

// A namespace admin with no pre-existing grants for anyone else must still
// see the whole directory, so they can grant a brand-new user their first
// access (the previous scoping was a chicken-and-egg).
func TestListUsersReturnsAllUsersForNamespaceAdmin(t *testing.T) {
	all := []store.User{
		{ID: 1, Username: "alice", Email: "alice@example.com", Role: "collaborator"},
		{ID: 2, Username: "bob", Email: "bob@example.com", Role: "admin"},
		{ID: 3, Username: "carol", Email: "carol@example.com", Role: "collaborator"},
	}
	h := NewAdminHandler(
		usersOnlyStore{users: all},
		grantStoreStub{},
		nsAdminForNamespaces{adminOf: []string{"team-a"}},
		nil, "local", 0,
	)

	r := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	r = middleware.WithUser(r, &middleware.UserContext{ID: 9, Username: "nsadmin", Role: "admin"})
	w := httptest.NewRecorder()
	h.HandleUsers(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var got []userResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != len(all) {
		t.Fatalf("namespace admin should see all %d users, got %d (%s)", len(all), len(got), w.Body.String())
	}
}
