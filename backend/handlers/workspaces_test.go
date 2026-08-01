package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// fakeWSStore is an in-memory store.WorkspaceStore recording the last write.
type fakeWSStore struct {
	personal    map[int]*store.Workspace
	byNS        map[string]*store.Workspace
	groups      map[int]*store.WorkspaceGroup
	lastCreate  store.WorkspaceInput
	created     bool
	inGroupNS   string
	inGroupID   int
	inGroupCall bool
}

func (f *fakeWSStore) List() ([]store.Workspace, error)  { return nil, nil }
func (f *fakeWSStore) Get(int) (*store.Workspace, error) { return nil, nil }
func (f *fakeWSStore) GetByNamespace(ns string) (*store.Workspace, error) {
	return f.byNS[ns], nil
}
func (f *fakeWSStore) GetPersonalByOwner(id int) (*store.Workspace, error) {
	return f.personal[id], nil
}
func (f *fakeWSStore) Create(in store.WorkspaceInput) (*store.Workspace, error) {
	f.lastCreate = in
	f.created = true
	owner := in.OwnerID
	return &store.Workspace{Namespace: in.Namespace, OwnerID: owner, IsPersonal: in.IsPersonal, GitEnabled: in.GitEnabled}, nil
}
func (f *fakeWSStore) Update(_ int, in store.WorkspaceInput) (*store.Workspace, error) {
	f.lastCreate = in
	return &store.Workspace{Namespace: in.Namespace, IsPersonal: in.IsPersonal}, nil
}
func (f *fakeWSStore) Delete(int) (bool, error) { return true, nil }
func (f *fakeWSStore) RemoteForNamespace(string) (*store.WorkspaceRemote, error) {
	return nil, nil
}
func (f *fakeWSStore) SetSyncStatus(string, string) error          { return nil }
func (f *fakeWSStore) ListGroups() ([]store.WorkspaceGroup, error) { return nil, nil }
func (f *fakeWSStore) GetGroup(id int) (*store.WorkspaceGroup, error) {
	return f.groups[id], nil
}
func (f *fakeWSStore) GetGroupByName(string) (*store.WorkspaceGroup, error) { return nil, nil }
func (f *fakeWSStore) CreateGroup(in store.WorkspaceGroupInput) (*store.WorkspaceGroup, error) {
	return &store.WorkspaceGroup{Name: in.Name, Transport: in.Transport, BaseURL: in.BaseURL}, nil
}
func (f *fakeWSStore) UpdateGroup(_ int, in store.WorkspaceGroupInput) (*store.WorkspaceGroup, error) {
	return &store.WorkspaceGroup{Name: in.Name}, nil
}
func (f *fakeWSStore) DeleteGroup(int) (bool, error) { return true, nil }
func (f *fakeWSStore) CreateInGroup(groupID int, ns string, _ bool) (*store.Workspace, error) {
	f.inGroupCall = true
	f.inGroupID = groupID
	f.inGroupNS = ns
	gid := groupID
	return &store.Workspace{Namespace: ns, GroupID: &gid, GitEnabled: true}, nil
}

func mineReq(userID int, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPut, "/api/me/workspace", strings.NewReader(body))
	return middleware.WithUser(r, &middleware.UserContext{ID: userID, Username: "u", Role: "collaborator"})
}

type fakeUsers struct{ email string }

func (f fakeUsers) GetUserByID(id int) (*store.User, error) {
	return &store.User{ID: id, Email: f.email}, nil
}

type fakeGrants struct {
	created bool
	ns      string
}

func (f *fakeGrants) GetGrantsForUser(int) ([]store.Grant, error) { return nil, nil }
func (f *fakeGrants) CreateGrant(userID int, ns, path, perm string, by *int) (*store.Grant, error) {
	f.created = true
	f.ns = ns
	return &store.Grant{}, nil
}

// A personal-workspace PUT ignores a client-supplied namespace and always
// stores the caller's derived namespace, owned by the caller, is_personal.
func TestMinePutForcesOwnerAndDerivedNamespace(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, fakeUsers{email: "me@forterro.com"}, &fakeGrants{}, nil, nil)

	body := `{"namespace":"someone-elses","git_enabled":true,"transport":"https","remote_url":"https://gitlab.com/me/notes.git","credential":"glpat-x"}`
	w := httptest.NewRecorder()
	h.HandleMine(w, mineReq(7, body))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if !fs.created {
		t.Fatal("expected a create")
	}
	if fs.lastCreate.Namespace != "me@forterro.com" {
		t.Fatalf("namespace = %q, want the caller's email (client value ignored)", fs.lastCreate.Namespace)
	}
	if !fs.lastCreate.IsPersonal || fs.lastCreate.OwnerID == nil || *fs.lastCreate.OwnerID != 7 {
		t.Fatalf("owner/personal not enforced: %+v", fs.lastCreate)
	}
}

// git_enabled with a bad remote is rejected before any store write.
func TestMinePutRejectsBadRemote(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil)
	body := `{"git_enabled":true,"transport":"https","remote_url":"http://insecure.example/x.git"}`
	w := httptest.NewRecorder()
	h.HandleMine(w, mineReq(7, body))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if fs.created {
		t.Fatal("stored a workspace despite an invalid remote")
	}
}

// Enabling mirroring without any credential (none provided, none stored) is
// rejected so it can't sit silently failing in the background.
func TestMinePutRequiresCredentialForMirror(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, fakeUsers{email: "me@forterro.com"}, &fakeGrants{}, nil, nil)
	body := `{"git_enabled":true,"transport":"https","remote_url":"https://gitlab.com/me/notes.git"}`
	w := httptest.NewRecorder()
	h.HandleMine(w, mineReq(7, body))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (no credential)", w.Code)
	}
	if fs.created {
		t.Fatal("stored a mirror workspace without a credential")
	}
}

func TestAdminCreateRejectsReservedPrefix(t *testing.T) {
	fs := &fakeWSStore{byNS: map[string]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil)
	body := `{"namespace":"user-1","git_enabled":false}`
	r := httptest.NewRequest(http.MethodPost, "/api/admin/workspaces", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleAdmin(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for reserved user- prefix", w.Code)
	}
}

func TestValidateRemote(t *testing.T) {
	h := NewWorkspaceHandler(nil, nil, nil, nil, []string{"gitlab.forterro.com"})
	cases := []struct {
		transport, url string
		ok             bool
	}{
		{"https", "https://gitlab.forterro.com/g/ns.git", true},
		{"https", "http://gitlab.forterro.com/g/ns.git", false}, // not https
		{"https", "https://evil.example.com/g/ns.git", false},   // not allow-listed
		{"ssh", "git@gitlab.forterro.com:g/ns.git", true},
		{"ssh", "ssh://git@gitlab.forterro.com/g/ns.git", true},
		{"ssh", "git@evil.example.com:g/ns.git", false},
		{"https", "", false},
	}
	for _, c := range cases {
		err := h.validateRemote(c.transport, c.url)
		if (err == nil) != c.ok {
			t.Fatalf("validateRemote(%q,%q) err=%v, want ok=%v", c.transport, c.url, err, c.ok)
		}
	}
}

func TestHandleMineMethodNotAllowed(t *testing.T) {
	h := NewWorkspaceHandler(&fakeWSStore{}, nil, nil, nil, nil)
	r := httptest.NewRequest(http.MethodPatch, "/api/me/workspace", nil)
	r = middleware.WithUser(r, &middleware.UserContext{ID: 1, Role: "collaborator"})
	w := httptest.NewRecorder()
	h.HandleMine(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}

func TestMineGetDefaultWhenNone(t *testing.T) {
	h := NewWorkspaceHandler(&fakeWSStore{personal: map[int]*store.Workspace{}}, fakeUsers{email: "u5@forterro.com"}, &fakeGrants{}, nil, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/me/workspace", nil)
	r = middleware.WithUser(r, &middleware.UserContext{ID: 5, Role: "collaborator"})
	w := httptest.NewRecorder()
	h.HandleMine(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var got map[string]any
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["namespace"] != "u5@forterro.com" || got["configured"] != false {
		t.Fatalf("unexpected default: %v", got)
	}
}

// Creating a workspace with a group_id routes to CreateInGroup with the namespace.
func TestAdminCreateInGroup(t *testing.T) {
	fs := &fakeWSStore{byNS: map[string]*store.Workspace{}, groups: map[int]*store.WorkspaceGroup{7: {ID: 7, Name: "dev", BaseURL: "https://gitlab.forterro.com/mdnest-workspaces/dev"}}}
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/admin/workspaces", strings.NewReader(`{"namespace":"team-a","group_id":7}`))
	w := httptest.NewRecorder()
	h.HandleAdmin(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !fs.inGroupCall || fs.inGroupID != 7 || fs.inGroupNS != "team-a" {
		t.Fatalf("CreateInGroup not called correctly: call=%v id=%d ns=%q", fs.inGroupCall, fs.inGroupID, fs.inGroupNS)
	}
	if fs.created {
		t.Fatal("standalone Create must not be used for a grouped create")
	}
}

// Creating in a nonexistent group is rejected before any write.
func TestAdminCreateInMissingGroup(t *testing.T) {
	fs := &fakeWSStore{byNS: map[string]*store.Workspace{}, groups: map[int]*store.WorkspaceGroup{}}
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil)
	r := httptest.NewRequest(http.MethodPost, "/api/admin/workspaces", strings.NewReader(`{"namespace":"team-b","group_id":99}`))
	w := httptest.NewRecorder()
	h.HandleAdmin(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400 for missing group", w.Code)
	}
	if fs.inGroupCall {
		t.Fatal("must not create in a missing group")
	}
}

// A group POST validates the base URL against the allow-list.
func TestGroupCreateValidatesBaseURL(t *testing.T) {
	h := NewWorkspaceHandler(&fakeWSStore{groups: map[int]*store.WorkspaceGroup{}}, nil, nil, nil, []string{"gitlab.forterro.com"})
	r := httptest.NewRequest(http.MethodPost, "/api/admin/workspace-groups", strings.NewReader(`{"name":"dev","transport":"https","base_url":"https://evil.example.com/g"}`))
	w := httptest.NewRecorder()
	h.HandleGroups(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400 for disallowed host", w.Code)
	}
	r2 := httptest.NewRequest(http.MethodPost, "/api/admin/workspace-groups", strings.NewReader(`{"name":"dev","transport":"https","base_url":"https://gitlab.forterro.com/mdnest-workspaces/dev"}`))
	w2 := httptest.NewRecorder()
	h.HandleGroups(w2, r2)
	if w2.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s, want 201", w2.Code, w2.Body.String())
	}
}
