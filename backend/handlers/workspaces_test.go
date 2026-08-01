package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// fakeWSStore is an in-memory store.WorkspaceStore recording the last write.
type fakeWSStore struct {
	personal    map[int]*store.Workspace
	byNS        map[string]*store.Workspace
	groups      map[int]*store.WorkspaceGroup
	getResult   *store.Workspace
	lastCreate  store.WorkspaceInput
	created     bool
	inGroupNS   string
	inGroupID   int
	inGroupCall bool
}

func (f *fakeWSStore) List() ([]store.Workspace, error)  { return nil, nil }
func (f *fakeWSStore) Get(int) (*store.Workspace, error) { return f.getResult, nil }
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
func (f *fakeWSStore) PersonalNamespaces() ([]string, error)       { return nil, nil }
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
func (f *fakeWSStore) EnsureProvisionedGroup(spec store.ProvisionedGroupSpec) (*store.WorkspaceGroup, error) {
	return &store.WorkspaceGroup{Name: spec.Name, BaseURL: spec.BaseURL, Source: "provisioned"}, nil
}
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
	deleted string
}

func (f *fakeGrants) GetGrantsForUser(int) ([]store.Grant, error) { return nil, nil }
func (f *fakeGrants) CreateGrant(userID int, ns, path, perm string, by *int) (*store.Grant, error) {
	f.created = true
	f.ns = ns
	return &store.Grant{}, nil
}
func (f *fakeGrants) DeleteGrantsForNamespace(ns string) (int64, error) {
	f.deleted = ns
	return 0, nil
}

// fakeNsCleaner records the namespace whose admin rows were removed.
type fakeNsCleaner struct{ deleted string }

func (f *fakeNsCleaner) DeleteAllForNamespace(ns string) (int64, error) {
	f.deleted = ns
	return 0, nil
}

// Deleting a workspace/project revokes every access grant and namespace-admin
// row on its namespace so no orphaned access metadata lingers.
func TestAdminDeleteRevokesNamespaceAccess(t *testing.T) {
	fs := &fakeWSStore{getResult: &store.Workspace{ID: 5, Namespace: "team-x"}}
	gr := &fakeGrants{}
	nsa := &fakeNsCleaner{}
	h := NewWorkspaceHandler(fs, nil, gr, nil, nil, true)
	h.SetNamespaceAdminCleaner(nsa)
	r := httptest.NewRequest(http.MethodDelete, "/api/admin/workspaces?id=5", nil)
	w := httptest.NewRecorder()
	h.HandleAdmin(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if gr.deleted != "team-x" {
		t.Fatalf("grants not revoked for namespace: %q", gr.deleted)
	}
	if nsa.deleted != "team-x" {
		t.Fatalf("namespace-admins not revoked: %q", nsa.deleted)
	}
}

// Storage is purged only when a durable copy demonstrably exists: git mirroring
// enabled AND the last sync succeeded. A timestamp alone (stamped on failed
// syncs too) or a mount-backed / unsynced namespace must NOT be purged — the
// bytes could be the only copy.
func TestStorageHasDurableCopy(t *testing.T) {
	ts := time.Now()
	for _, c := range []struct {
		name string
		ws   *store.Workspace
		want bool
	}{
		{"nil", nil, false},
		{"not git-enabled (e.g. a mount)", &store.Workspace{Namespace: "n", GitEnabled: false, LastSyncAt: &ts}, false},
		{"git-enabled, never synced (pending)", &store.Workspace{Namespace: "n", GitEnabled: true, LastSyncAt: nil}, false},
		{"git-enabled, last sync errored", &store.Workspace{Namespace: "n", GitEnabled: true, LastSyncAt: &ts, LastSyncError: "boom"}, false},
		{"git-enabled, last sync ok", &store.Workspace{Namespace: "n", GitEnabled: true, LastSyncAt: &ts, LastSyncError: ""}, true},
	} {
		if got := storageHasDurableCopy(c.ws); got != c.want {
			t.Errorf("%s: storageHasDurableCopy = %v, want %v", c.name, got, c.want)
		}
	}
}

// A personal-workspace PUT ignores a client-supplied namespace and always
// stores the caller's derived namespace, owned by the caller, is_personal.
func TestMinePutForcesOwnerAndDerivedNamespace(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, fakeUsers{email: "me@forterro.com"}, &fakeGrants{}, nil, nil, true)

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

// A personal namespace is materialised only once the workspace actually
// mirrors to a repo the owner controls, so it is durable by construction.
// Namespaces otherwise come from mounts or operator config — a runtime-created
// namespace with no remote lives in the container's writable layer on the local
// backend, which `mdnest-server rebuild` discards.
func TestMinePutOnlyCreatesNamespaceWhenMirroring(t *testing.T) {
	t.Run("mirroring off: config saved, no namespace or grant", func(t *testing.T) {
		fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
		gr := &fakeGrants{}
		h := NewWorkspaceHandler(fs, fakeUsers{email: "me@example.com"}, gr, nil, nil, true)
		w := httptest.NewRecorder()
		h.HandleMine(w, mineReq(7, `{"git_enabled":false}`))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
		}
		if !fs.created {
			t.Error("the workspace row should still be saved")
		}
		if gr.created {
			t.Error("granted a namespace that was never materialised")
		}
	})

	t.Run("mirroring on: namespace and grant created", func(t *testing.T) {
		fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
		gr := &fakeGrants{}
		h := NewWorkspaceHandler(fs, fakeUsers{email: "me@example.com"}, gr, nil, nil, true)
		w := httptest.NewRecorder()
		h.HandleMine(w, mineReq(7, `{"git_enabled":true,"transport":"https","remote_url":"https://gitlab.com/me/notes.git","credential":"glpat-x"}`))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
		}
		if !gr.created || gr.ns != "me@example.com" {
			t.Errorf("expected a write grant on the personal namespace, got created=%v ns=%q", gr.created, gr.ns)
		}
	})
}

// git_enabled with a bad remote is rejected before any store write.
func TestMinePutRejectsBadRemote(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil, true)
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
	h := NewWorkspaceHandler(fs, fakeUsers{email: "me@forterro.com"}, &fakeGrants{}, nil, nil, true)
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

// Fail-closed: when the server has no dedicated sealing secret, enabling
// mirroring is refused so a PAT / SSH key is never sealed under a default key.
func TestMinePutFailsClosedWithoutEncryption(t *testing.T) {
	fs := &fakeWSStore{personal: map[int]*store.Workspace{}}
	h := NewWorkspaceHandler(fs, fakeUsers{email: "me@forterro.com"}, &fakeGrants{}, nil, nil, false)
	body := `{"git_enabled":true,"transport":"https","remote_url":"https://gitlab.com/me/notes.git","credential":"glpat-x"}`
	w := httptest.NewRecorder()
	h.HandleMine(w, mineReq(7, body))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (encryption not configured)", w.Code)
	}
	if fs.created {
		t.Fatal("stored a credential without a sealing secret")
	}
}

// Fail-closed also covers groups, which seal a shared credential.
func TestGroupCreateFailsClosedWithoutEncryption(t *testing.T) {
	h := NewWorkspaceHandler(&fakeWSStore{groups: map[int]*store.WorkspaceGroup{}}, nil, nil, nil, nil, false)
	body := `{"name":"dev","transport":"https","base_url":"https://gitlab.forterro.com/g","credential":"glpat-x"}`
	r := httptest.NewRequest(http.MethodPost, "/api/admin/workspace-groups", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleGroups(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (encryption not configured)", w.Code)
	}
}

func TestValidateRemote(t *testing.T) {
	h := NewWorkspaceHandler(nil, nil, nil, nil, []string{"gitlab.forterro.com"}, true)
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
	h := NewWorkspaceHandler(&fakeWSStore{}, nil, nil, nil, nil, true)
	r := httptest.NewRequest(http.MethodPatch, "/api/me/workspace", nil)
	r = middleware.WithUser(r, &middleware.UserContext{ID: 1, Role: "collaborator"})
	w := httptest.NewRecorder()
	h.HandleMine(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}

func TestMineGetDefaultWhenNone(t *testing.T) {
	h := NewWorkspaceHandler(&fakeWSStore{personal: map[int]*store.Workspace{}}, fakeUsers{email: "u5@forterro.com"}, &fakeGrants{}, nil, nil, true)
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
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil, true)
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
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil, true)
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
	h := NewWorkspaceHandler(&fakeWSStore{groups: map[int]*store.WorkspaceGroup{}}, nil, nil, nil, []string{"gitlab.forterro.com"}, true)
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

// A provisioned group is owned by the deployment: the admin panel may manage its
// sub-projects but must not edit or delete the group itself.
func TestProvisionedGroupIsImmutable(t *testing.T) {
	fs := &fakeWSStore{groups: map[int]*store.WorkspaceGroup{
		3: {ID: 3, Name: "Provisioned workspaces", Source: "provisioned", BaseURL: "https://gitlab.forterro.com/mdnest-workspaces/dev"},
	}}
	h := NewWorkspaceHandler(fs, nil, nil, nil, nil, true)

	put := httptest.NewRequest(http.MethodPut, "/api/admin/workspace-groups?id=3", strings.NewReader(`{"name":"renamed","transport":"https","base_url":"https://gitlab.forterro.com/g"}`))
	pw := httptest.NewRecorder()
	h.HandleGroups(pw, put)
	if pw.Code != http.StatusForbidden {
		t.Fatalf("PUT status=%d, want 403 for provisioned group", pw.Code)
	}

	del := httptest.NewRequest(http.MethodDelete, "/api/admin/workspace-groups?id=3", nil)
	dw := httptest.NewRecorder()
	h.HandleGroups(dw, del)
	if dw.Code != http.StatusForbidden {
		t.Fatalf("DELETE status=%d, want 403 for provisioned group", dw.Code)
	}
}

// remote_url and branch are passed to git as positional arguments, so a value
// beginning with "-" is parsed as an option instead. `--upload-pack=<cmd>`
// makes git execute <cmd>, which turns "configure my own workspace" — available
// to any authenticated user via PUT /api/me/workspace — into command execution
// on the writer. The scp-like ssh form is the way in: it only looks for
// user@host:path anywhere in the string, so a leading "-" passed host checks.
func TestValidateRemoteRejectsFlagSmuggling(t *testing.T) {
	h := NewWorkspaceHandler(nil, nil, nil, nil, nil, true)
	for _, tc := range []struct {
		name, transport, url string
	}{
		{"ssh scp-like upload-pack payload", "ssh", "--upload-pack=touch /tmp/pwned;x@evil.com:notes.git"},
		{"ssh scp-like bare dash", "ssh", "-x@evil.com:notes.git"},
		{"ssh url form", "ssh", "--upload-pack=id@evil.com:x"},
		{"https form", "https", "--upload-pack=id"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := h.validateRemote(tc.transport, tc.url); err == nil {
				t.Errorf("accepted a flag-smuggling remote_url %q", tc.url)
			}
		})
	}
	// A legitimate scp-like remote must still work.
	if err := h.validateRemote("ssh", "git@gitlab.example.com:team/notes.git"); err != nil {
		t.Errorf("rejected a valid scp-like remote: %v", err)
	}
}

func TestBranchRejectsFlagSmuggling(t *testing.T) {
	h := NewWorkspaceHandler(nil, nil, nil, nil, nil, true)
	for _, bad := range []string{"--upload-pack=touch /tmp/pwned", "-x", "main;rm -rf /", "main branch"} {
		if _, err := h.inputFrom(workspaceRequest{Branch: bad}, false); err == nil {
			t.Errorf("accepted branch %q", bad)
		}
		if _, err := h.groupInputFrom(groupRequest{
			Transport: "https", BaseURL: "https://gitlab.example.com/notes", Branch: bad,
		}); err == nil {
			t.Errorf("group accepted branch %q", bad)
		}
	}
	for _, ok := range []string{"", "main", "release/v1.2", "feature_x-1"} {
		if _, err := h.inputFrom(workspaceRequest{Branch: ok}, false); err != nil {
			t.Errorf("rejected valid branch %q: %v", ok, err)
		}
	}
}
