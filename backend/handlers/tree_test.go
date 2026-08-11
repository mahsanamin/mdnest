package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// treeGroupStore is a store.GroupStore whose only meaningful behaviour is
// MemberGroupGrants: it hands back the grants a user inherits from their groups.
type treeGroupStore struct {
	// grants maps userID -> namespace -> the group grants the user inherits.
	grants map[int]map[string][]store.GroupGrant
}

func (treeGroupStore) CreateGroup(string, string) (*store.AccessGroup, error) { return nil, nil }
func (treeGroupStore) UpdateGroup(int, string, string) error                  { return nil }
func (treeGroupStore) DeleteGroup(int) error                                  { return nil }
func (treeGroupStore) GetGroup(int) (*store.AccessGroup, error)               { return nil, nil }
func (treeGroupStore) ListGroups() ([]store.AccessGroup, error)               { return nil, nil }
func (treeGroupStore) AddUserMember(int, int) error                           { return nil }
func (treeGroupStore) AddOIDCMember(int, string, string) error                { return nil }
func (treeGroupStore) RemoveUserMember(int, int) error                        { return nil }
func (treeGroupStore) RemoveOIDCMember(int, string) error                     { return nil }
func (treeGroupStore) ListMembers(int) ([]store.GroupMember, error)           { return nil, nil }
func (treeGroupStore) CreateGroupGrant(int, string, string, string, *int) (*store.GroupGrant, error) {
	return nil, nil
}
func (treeGroupStore) UpdateGroupGrantPermission(int, string) error        { return nil }
func (treeGroupStore) DeleteGroupGrant(int) error                          { return nil }
func (treeGroupStore) ListGrantsForGroup(int) ([]store.GroupGrant, error)  { return nil, nil }
func (treeGroupStore) DeleteGroupGrantsForNamespace(string) (int64, error) { return 0, nil }
func (treeGroupStore) CheckGroupAccess(int, []string, string, string, string) bool {
	return false
}
func (s treeGroupStore) GetAccessibleNamespacesForGroups(userID int, _ []string) ([]string, error) {
	var out []string
	for ns := range s.grants[userID] {
		out = append(out, ns)
	}
	return out, nil
}
func (s treeGroupStore) MemberGroupGrants(userID int, _ []string, namespace string) ([]store.GroupGrant, error) {
	return s.grants[userID][namespace], nil
}

// notesDirWithTree builds <tmp>/team/{readme.md,docs/guide.md} on disk.
func notesDirWithTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	docs := filepath.Join(root, "team", "docs")
	if err := os.MkdirAll(docs, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", docs, err)
	}
	if err := os.WriteFile(filepath.Join(root, "team", "readme.md"), []byte("# readme"), 0o644); err != nil {
		t.Fatalf("write readme: %v", err)
	}
	if err := os.WriteFile(filepath.Join(docs, "guide.md"), []byte("# guide"), 0o644); err != nil {
		t.Fatalf("write guide: %v", err)
	}
	return root
}

// countLeaves returns the number of file (non-folder) nodes in the tree.
func countLeaves(n *TreeNode) int {
	if n.Type != "folder" {
		return 1
	}
	total := 0
	for _, c := range n.Children {
		total += countLeaves(c)
	}
	return total
}

func serveTree(h *TreeHandler, uc *middleware.UserContext, ns string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/tree?ns="+ns, nil)
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	h.GetTree(w, r)
	return w
}

// A user who can reach a namespace only through an access group must see its
// notes, not just the namespace. Before the fix the tree was filtered against
// the user's direct grants alone, so a group-only member got an empty tree —
// they saw the namespace in the list but none of the notes inside it.
func TestGetTreeIncludesGroupInheritedNotes(t *testing.T) {
	notesDir := notesDirWithTree(t)
	stg := localStore(t, notesDir)
	grantStore := &fakeGrantStore{userID: 0, namespace: ""} // no direct grants
	groupStore := treeGroupStore{grants: map[int]map[string][]store.GroupGrant{
		7: {"team": {{Namespace: "team", Path: "/", Permission: "read"}}},
	}}
	h := NewTreeHandler(stg, grantStore, groupStore)

	member := &middleware.UserContext{ID: 7, Username: "carol", Role: "collaborator"}

	w := serveTree(h, member, "team")
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var root TreeNode
	if err := json.Unmarshal(w.Body.Bytes(), &root); err != nil {
		t.Fatalf("decode tree: %v", err)
	}
	if got := countLeaves(&root); got != 2 {
		t.Fatalf("group-only member should see all 2 notes, got %d: %s", got, w.Body.String())
	}
}

// A collaborator with neither a direct grant nor a group grant still sees an
// empty tree — the group fallback must not hand out access it wasn't given.
func TestGetTreeHidesNotesWithoutAnyGrant(t *testing.T) {
	notesDir := notesDirWithTree(t)
	stg := localStore(t, notesDir)
	grantStore := &fakeGrantStore{userID: 0, namespace: ""}
	groupStore := treeGroupStore{grants: map[int]map[string][]store.GroupGrant{}}
	h := NewTreeHandler(stg, grantStore, groupStore)

	stranger := &middleware.UserContext{ID: 9, Username: "dave", Role: "collaborator"}

	w := serveTree(h, stranger, "team")
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var root TreeNode
	if err := json.Unmarshal(w.Body.Bytes(), &root); err != nil {
		t.Fatalf("decode tree: %v", err)
	}
	if got := countLeaves(&root); got != 0 {
		t.Fatalf("ungranted member should see no notes, got %d: %s", got, w.Body.String())
	}
}
