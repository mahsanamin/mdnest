package middleware

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"

	"github.com/mdnest/mdnest/backend/store"
)

// These tests pin the semantic change in this PR: a superadmin administers
// every namespace (manage users/grants, create/delete) but no longer has
// implicit read/write access to note content — data access flows through
// grants for everyone. The two planes therefore diverge for superadmins:
// FilterManageableNamespaces stays global, FilterNamespaces/CheckRead do not.
// This is a change to live installs (a superadmin loses ambient read), so it is
// exactly the kind of authz property that is easy to reintroduce by accident.

// fakeGrantStore records per-user namespace grants (path-agnostic — enough for
// the checker, which only consults CheckAccess and GetAccessibleNamespaces).
type fakeGrantStore struct {
	grants map[int]map[string]bool
}

func (f *fakeGrantStore) CheckAccess(userID int, namespace, path, requiredPermission string) bool {
	return f.grants[userID][namespace]
}

func (f *fakeGrantStore) GetAccessibleNamespaces(userID int) ([]string, error) {
	var out []string
	for ns := range f.grants[userID] {
		out = append(out, ns)
	}
	sort.Strings(out)
	return out, nil
}

func (f *fakeGrantStore) CreateGrant(int, string, string, string, *int) (*store.Grant, error) {
	return nil, nil
}
func (f *fakeGrantStore) UpdateGrantPermission(int, string) error { return nil }
func (f *fakeGrantStore) DeleteGrant(int) error                   { return nil }
func (f *fakeGrantStore) DeleteGrantsForNamespace(string) (int64, error) { return 0, nil }
func (f *fakeGrantStore) GetGrant(int) (*store.Grant, error)      { return nil, nil }
func (f *fakeGrantStore) GetGrantsForUser(int) ([]store.Grant, error) {
	return nil, nil
}
func (f *fakeGrantStore) GetGrantsForNamespace(string) ([]store.Grant, error) {
	return nil, nil
}
func (f *fakeGrantStore) GetGrantsForPath(string, string) ([]store.GrantWithUser, error) {
	return nil, nil
}
func (f *fakeGrantStore) ListAllGrants() ([]store.GrantWithUser, error) { return nil, nil }

// fakeNsAdminStore records per-user namespace-admin scope.
type fakeNsAdminStore struct {
	admin map[int]map[string]bool
}

func (f fakeNsAdminStore) IsAdminOf(userID int, namespace string) (bool, error) {
	return f.admin[userID][namespace], nil
}
func (f fakeNsAdminStore) DeleteAllForNamespace(string) (int64, error) { return 0, nil }
func (f fakeNsAdminStore) ListByUser(userID int) ([]string, error) {
	var out []string
	for ns := range f.admin[userID] {
		out = append(out, ns)
	}
	sort.Strings(out)
	return out, nil
}
func (fakeNsAdminStore) Add(int, string, *int) error { return nil }
func (fakeNsAdminStore) Remove(int, string) error    { return nil }
func (fakeNsAdminStore) CountByUser(int) (int, error) { return 0, nil }
func (fakeNsAdminStore) ListByNamespace(string) ([]store.NamespaceAdminWithUser, error) {
	return nil, nil
}

// allNamespaces is the full server-side set the filters are applied against.
var allNamespaces = []string{"alpha", "beta", "gamma"}

// newChecker wires a fixed fixture:
//   - superadmin (ID 1): self-granted read on "alpha" only.
//   - admin (ID 2): namespace-admin of "beta", plus a grant on "gamma".
//   - collaborator (ID 3): a grant on "gamma".
//   - token-superadmin (ID 4): superadmin role, no grants (models an API token).
func newChecker() *PermissionChecker {
	return NewPermissionChecker(
		&fakeGrantStore{grants: map[int]map[string]bool{
			1: {"alpha": true},
			2: {"gamma": true},
			3: {"gamma": true},
		}},
		fakeNsAdminStore{admin: map[int]map[string]bool{
			2: {"beta": true},
		}},
	)
}

func reqAs(uc *UserContext) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if uc != nil {
		r = WithUser(r, uc)
	}
	return r
}

func assertSlice(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("want %v, got %v", want, got)
		}
	}
}

// A superadmin manages every namespace but reads only what they are granted.
func TestSuperadminManagesButDoesNotRead(t *testing.T) {
	pc := newChecker()
	super := &UserContext{ID: 1, Username: "root", Role: "superadmin"}

	t.Run("no implicit read on an administered namespace", func(t *testing.T) {
		if pc.CheckRead(reqAs(super), "beta", "note.md") {
			t.Fatal("superadmin read an ungranted namespace it merely administers")
		}
		if pc.CheckWrite(reqAs(super), "beta", "note.md") {
			t.Fatal("superadmin wrote an ungranted namespace it merely administers")
		}
	})

	t.Run("read where self-granted", func(t *testing.T) {
		if !pc.CheckRead(reqAs(super), "alpha", "note.md") {
			t.Fatal("superadmin denied read on a namespace it holds a grant in")
		}
	})

	t.Run("manages every namespace", func(t *testing.T) {
		assertSlice(t, pc.FilterManageableNamespaces(reqAs(super), allNamespaces),
			[]string{"alpha", "beta", "gamma"})
	})

	// The FilterNamespaces call: deliberately NOT the full list — a superadmin's
	// data-plane view is their grants, not everything they can administer.
	t.Run("data view is grants only", func(t *testing.T) {
		assertSlice(t, pc.FilterNamespaces(reqAs(super), allNamespaces),
			[]string{"alpha"})
	})
}

// Namespace-admins are unchanged: admin scope still confers data access to the
// namespaces they administer, and the union with their grants is unchanged.
func TestNamespaceAdminUnchanged(t *testing.T) {
	pc := newChecker()
	admin := &UserContext{ID: 2, Username: "nsadmin", Role: "admin"}

	if !pc.CheckRead(reqAs(admin), "beta", "note.md") {
		t.Fatal("namespace-admin denied read on its own namespace")
	}
	if !pc.CheckWrite(reqAs(admin), "beta", "note.md") {
		t.Fatal("namespace-admin denied write on its own namespace")
	}
	if pc.CheckRead(reqAs(admin), "alpha", "note.md") {
		t.Fatal("namespace-admin read a namespace it neither administers nor was granted")
	}
	if !pc.CheckRead(reqAs(admin), "gamma", "note.md") {
		t.Fatal("namespace-admin denied read on a granted namespace")
	}

	assertSlice(t, pc.FilterNamespaces(reqAs(admin), allNamespaces),
		[]string{"beta", "gamma"})
	assertSlice(t, pc.FilterManageableNamespaces(reqAs(admin), allNamespaces),
		[]string{"beta"})
}

// Collaborators are unchanged: grants only, and no management plane at all.
func TestCollaboratorUnchanged(t *testing.T) {
	pc := newChecker()
	collab := &UserContext{ID: 3, Username: "carol", Role: "collaborator"}

	if !pc.CheckRead(reqAs(collab), "gamma", "note.md") {
		t.Fatal("collaborator denied read on a granted namespace")
	}
	if pc.CheckRead(reqAs(collab), "alpha", "note.md") {
		t.Fatal("collaborator read an ungranted namespace")
	}

	assertSlice(t, pc.FilterNamespaces(reqAs(collab), allNamespaces),
		[]string{"gamma"})
	if got := pc.FilterManageableNamespaces(reqAs(collab), allNamespaces); len(got) != 0 {
		t.Fatalf("collaborator has a management plane: %v", got)
	}
}

// Single-user mode carries no user context; the checker must grant everything
// rather than deny-by-default, on both planes. Unchanged by this PR.
func TestSingleUserModeUnaffected(t *testing.T) {
	pc := newChecker()

	if !pc.CheckRead(reqAs(nil), "beta", "note.md") {
		t.Fatal("single-user read denied")
	}
	if !pc.CheckWrite(reqAs(nil), "beta", "note.md") {
		t.Fatal("single-user write denied")
	}
	assertSlice(t, pc.FilterNamespaces(reqAs(nil), allNamespaces),
		[]string{"alpha", "beta", "gamma"})
}

// An API token resolves to the same UserContext its user carries, so a token
// belonging to a superadmin gets the superadmin role — and must be subject to
// the same grant checks. Since the role no longer confers a bypass, the token
// cannot bypass either: it manages everything but reads nothing ungranted.
func TestAPITokenSuperadminHasNoBypass(t *testing.T) {
	pc := newChecker()
	tokenSuper := &UserContext{ID: 4, Username: "ci-bot", Role: "superadmin"}

	if pc.CheckRead(reqAs(tokenSuper), "alpha", "note.md") {
		t.Fatal("a superadmin API token bypassed the grant check")
	}
	if got := pc.FilterNamespaces(reqAs(tokenSuper), allNamespaces); len(got) != 0 {
		t.Fatalf("a superadmin API token has ambient data access: %v", got)
	}
	assertSlice(t, pc.FilterManageableNamespaces(reqAs(tokenSuper), allNamespaces),
		[]string{"alpha", "beta", "gamma"})
}
