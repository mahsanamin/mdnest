package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mdnest/mdnest/backend/store"
)

// memGroupStore is an in-memory GroupStore for handler tests. Only the methods
// the handlers exercise are meaningful; the rest satisfy the interface.
type memGroupStore struct {
	groups  map[int]*store.AccessGroup
	members map[int][]store.GroupMember
	grants  map[int][]store.GroupGrant
	nextG   int
	nextGr  int
}

func newMemGroupStore() *memGroupStore {
	return &memGroupStore{groups: map[int]*store.AccessGroup{}, members: map[int][]store.GroupMember{}, grants: map[int][]store.GroupGrant{}, nextG: 1, nextGr: 1}
}

func (m *memGroupStore) CreateGroup(name, desc string) (*store.AccessGroup, error) {
	g := &store.AccessGroup{ID: m.nextG, Name: name, Description: desc}
	m.groups[g.ID] = g
	m.nextG++
	return g, nil
}
func (m *memGroupStore) UpdateGroup(id int, name, desc string) error {
	if g := m.groups[id]; g != nil {
		g.Name, g.Description = name, desc
	}
	return nil
}
func (m *memGroupStore) DeleteGroup(id int) error { delete(m.groups, id); return nil }
func (m *memGroupStore) GetGroup(id int) (*store.AccessGroup, error) {
	return m.groups[id], nil
}
func (m *memGroupStore) ListGroups() ([]store.AccessGroup, error) {
	var out []store.AccessGroup
	for _, g := range m.groups {
		out = append(out, *g)
	}
	return out, nil
}
func (m *memGroupStore) AddUserMember(gid, uid int) error {
	u := uid
	m.members[gid] = append(m.members[gid], store.GroupMember{GroupID: gid, UserID: &u, Username: "carol"})
	return nil
}
func (m *memGroupStore) AddOIDCMember(gid int, oidc, label string) error {
	o := oidc
	m.members[gid] = append(m.members[gid], store.GroupMember{GroupID: gid, OIDCGroup: &o, OIDCLabel: label})
	return nil
}
func (m *memGroupStore) RemoveUserMember(int, int) error    { return nil }
func (m *memGroupStore) RemoveOIDCMember(int, string) error { return nil }
func (m *memGroupStore) ListMembers(gid int) ([]store.GroupMember, error) {
	return m.members[gid], nil
}
func (m *memGroupStore) CreateGroupGrant(gid int, ns, path, perm string, by *int) (*store.GroupGrant, error) {
	if path == "" {
		path = "/"
	}
	if perm == "" {
		perm = "write"
	}
	g := store.GroupGrant{ID: m.nextGr, GroupID: gid, Namespace: ns, Path: path, Permission: perm}
	m.nextGr++
	m.grants[gid] = append(m.grants[gid], g)
	return &g, nil
}
func (m *memGroupStore) UpdateGroupGrantPermission(int, string) error { return nil }
func (m *memGroupStore) DeleteGroupGrant(int) error                   { return nil }
func (m *memGroupStore) ListGrantsForGroup(gid int) ([]store.GroupGrant, error) {
	return m.grants[gid], nil
}
func (m *memGroupStore) DeleteGroupGrantsForNamespace(string) (int64, error) { return 0, nil }
func (m *memGroupStore) CheckGroupAccess(int, []string, string, string, string) bool {
	return false
}
func (m *memGroupStore) GetAccessibleNamespacesForGroups(int, []string) ([]string, error) {
	return nil, nil
}
func (m *memGroupStore) MemberGroupGrants(int, []string, string) ([]store.GroupGrant, error) {
	return nil, nil
}

func doJSON(t *testing.T, h http.HandlerFunc, method, target string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	r := httptest.NewRequest(method, target, &buf)
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func TestGroupsHandlerLifecycle(t *testing.T) {
	h := NewGroupsHandler(newMemGroupStore())

	// Create a group.
	w := doJSON(t, h.HandleGroups, http.MethodPost, "/api/admin/groups", map[string]string{"name": "Engineering", "description": "eng"})
	if w.Code != http.StatusOK {
		t.Fatalf("create group: %d %s", w.Code, w.Body.String())
	}
	var g groupResponse
	json.Unmarshal(w.Body.Bytes(), &g)
	if g.ID == 0 || g.Name != "Engineering" {
		t.Fatalf("bad create response: %+v", g)
	}

	// Add an OIDC member with a display label; the label must round-trip.
	w = doJSON(t, h.HandleMembers, http.MethodPost, "/api/admin/groups/members",
		map[string]interface{}{"group_id": g.ID, "oidc_group": "abc-123-guid", "oidc_label": "IT Ops"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("add oidc member: %d %s", w.Code, w.Body.String())
	}
	w = doJSON(t, h.HandleMembers, http.MethodGet, "/api/admin/groups/members?group_id=1", nil)
	var members []groupMemberResponse
	json.Unmarshal(w.Body.Bytes(), &members)
	if len(members) != 1 || members[0].OIDCGroup == nil || *members[0].OIDCGroup != "abc-123-guid" || members[0].OIDCLabel != "IT Ops" {
		t.Fatalf("oidc member/label did not round-trip: %+v", members)
	}

	// Attach a namespace grant.
	w = doJSON(t, h.HandleGrants, http.MethodPost, "/api/admin/groups/grants",
		map[string]interface{}{"group_id": g.ID, "namespace": "team-a", "path": "/", "permission": "read"})
	if w.Code != http.StatusOK {
		t.Fatalf("create grant: %d %s", w.Code, w.Body.String())
	}
	w = doJSON(t, h.HandleGrants, http.MethodGet, "/api/admin/groups/grants?group_id=1", nil)
	var grants []groupGrantResponse
	json.Unmarshal(w.Body.Bytes(), &grants)
	if len(grants) != 1 || grants[0].Namespace != "team-a" || grants[0].Permission != "read" {
		t.Fatalf("grant did not round-trip: %+v", grants)
	}

	// A group grant requires a namespace.
	w = doJSON(t, h.HandleGrants, http.MethodPost, "/api/admin/groups/grants", map[string]interface{}{"group_id": g.ID})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for grant without namespace, got %d", w.Code)
	}
}
