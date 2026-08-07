package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

type fakeNsUsers struct {
	users []store.NamespaceUser
	ns    string
}

func (f *fakeNsUsers) UsersForNamespace(ns string) ([]store.NamespaceUser, error) {
	f.ns = ns
	return f.users, nil
}

func TestHandleNamespaceUsers(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	lister := &fakeNsUsers{users: []store.NamespaceUser{{ID: 1, Username: "alice"}, {ID: 2, Username: "bob"}}}
	h := NewTeamHandler(stg, lister)

	r := httptest.NewRequest(http.MethodGet, "/api/namespace/users?ns=team", nil)
	w := httptest.NewRecorder()
	h.HandleNamespaceUsers(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if lister.ns != "team" {
		t.Errorf("lister queried ns %q, want team", lister.ns)
	}
	var got []store.NamespaceUser
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 || got[0].Username != "alice" || got[1].Username != "bob" {
		t.Fatalf("users = %+v", got)
	}
}

func TestHandleNamespaceUsers_MethodNotAllowed(t *testing.T) {
	stg, _ := storage.NewLocalStorage(t.TempDir())
	h := NewTeamHandler(stg, &fakeNsUsers{})
	r := httptest.NewRequest(http.MethodPost, "/api/namespace/users?ns=team", nil)
	w := httptest.NewRecorder()
	h.HandleNamespaceUsers(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}
