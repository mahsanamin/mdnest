package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// meUserStore implements just enough of store.UserStore for HandleMe.
type meUserStore struct {
	store.UserStore
	user *store.User
}

func (s meUserStore) GetUserByID(int) (*store.User, error) { return s.user, nil }

// A user who reaches a namespace only through an access group must receive the
// group's grants in /api/me, otherwise the frontend derives no write access and
// renders the namespace read-only (can see notes but cannot edit/create/delete).
func TestMeIncludesGroupInheritedWriteGrant(t *testing.T) {
	grantStore := &fakeGrantStore{} // no direct grants
	groupStore := treeGroupStore{grants: map[int]map[string][]store.GroupGrant{
		7: {"team": {{ID: 5, Namespace: "team", Path: "/", Permission: "write"}}},
	}}
	h := NewMeHandler(
		meUserStore{user: &store.User{ID: 7, Username: "carol", Email: "carol@x", Role: "collaborator", CreatedAt: time.Now()}},
		grantStore, nil, groupStore,
	)

	r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	r = middleware.WithUser(r, &middleware.UserContext{ID: 7, Username: "carol", Role: "collaborator"})
	w := httptest.NewRecorder()
	h.HandleMe(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Grants []struct {
			Namespace  string `json:"namespace"`
			Path       string `json:"path"`
			Permission string `json:"permission"`
		} `json:"grants"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode /api/me: %v", err)
	}
	for _, g := range resp.Grants {
		if g.Namespace == "team" && g.Path == "/" && g.Permission == "write" {
			return // group write grant surfaced — the UI can enable editing
		}
	}
	t.Fatalf("group-inherited write grant missing from /api/me: %s", w.Body.String())
}
