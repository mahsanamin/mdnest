package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// GET /api/files/<ns>/<path> carries its namespace in the URL path rather than
// the ?ns= query param, so it cannot be wrapped in the query-param permission
// middleware the other content routes use. It was therefore registered with
// only the auth middleware and had no per-namespace check at all: any
// authenticated principal — including an API token — could read any file in
// any namespace by guessing the URL. These tests pin the handler-level check
// that closes it.

// fakeGrantStore grants exactly one (namespace, permission) pair.
type fakeGrantStore struct {
	userID    int
	namespace string
}

func (f *fakeGrantStore) CheckAccess(userID int, namespace, path, requiredPermission string) bool {
	return userID == f.userID && namespace == f.namespace
}

func (f *fakeGrantStore) CreateGrant(int, string, string, string, *int) (*store.Grant, error) {
	return nil, nil
}
func (f *fakeGrantStore) UpdateGrantPermission(int, string) error { return nil }
func (f *fakeGrantStore) DeleteGrant(int) error                   { return nil }
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
func (f *fakeGrantStore) GetAccessibleNamespaces(int) ([]string, error) {
	return []string{f.namespace}, nil
}

// fakeNsAdminStore makes nobody a namespace-admin; no role short-circuits data
// access here — every principal falls through to the grant check.
type fakeNsAdminStore struct{}

func (fakeNsAdminStore) Add(int, string, *int) error             { return nil }
func (fakeNsAdminStore) Remove(int, string) error                { return nil }
func (fakeNsAdminStore) IsAdminOf(int, string) (bool, error)     { return false, nil }
func (fakeNsAdminStore) ListByUser(int) ([]string, error)        { return nil, nil }
func (fakeNsAdminStore) CountByUser(int) (int, error)            { return 0, nil }
func (fakeNsAdminStore) ListByNamespace(string) ([]store.NamespaceAdminWithUser, error) {
	return nil, nil
}

// notesDirWithTwoNamespaces builds <tmp>/{alpha,beta}/secret.txt on disk.
func notesDirWithTwoNamespaces(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, ns := range []string{"alpha", "beta"} {
		dir := filepath.Join(root, ns)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
		body := []byte(ns + " namespace file contents")
		if err := os.WriteFile(filepath.Join(dir, "secret.txt"), body, 0o644); err != nil {
			t.Fatalf("write file in %s: %v", ns, err)
		}
	}
	return root
}

// localStore roots a local storage backend at the given notes directory.
func localStore(t *testing.T, root string) storage.Storage {
	t.Helper()
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatalf("new local storage: %v", err)
	}
	return stg
}

func serveFile(h *UploadHandler, uc *middleware.UserContext, ns string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/files/"+ns+"/secret.txt", nil)
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	h.HandleServeFile(w, r)
	return w
}

func TestServeFileEnforcesNamespaceReadAccess(t *testing.T) {
	notesDir := notesDirWithTwoNamespaces(t)
	perms := middleware.NewPermissionChecker(&fakeGrantStore{userID: 7, namespace: "alpha"}, fakeNsAdminStore{})
	h := NewUploadHandler(localStore(t, notesDir), perms)

	collaborator := &middleware.UserContext{ID: 7, Username: "carol", Role: "collaborator"}

	t.Run("granted namespace is served", func(t *testing.T) {
		w := serveFile(h, collaborator, "alpha")
		if w.Code != http.StatusOK {
			t.Fatalf("want 200 for the granted namespace, got %d (%s)", w.Code, w.Body.String())
		}
		if got := w.Body.String(); got != "alpha namespace file contents" {
			t.Fatalf("unexpected body: %q", got)
		}
	})

	// The regression: a user with no grant in "beta" must not be able to read
	// beta's files just because they hold a valid token.
	t.Run("ungranted namespace is refused", func(t *testing.T) {
		w := serveFile(h, collaborator, "beta")
		if w.Code != http.StatusForbidden {
			t.Fatalf("want 403 for an ungranted namespace, got %d (%s)", w.Code, w.Body.String())
		}
		if body := w.Body.String(); body == "beta namespace file contents" {
			t.Fatal("file contents leaked across namespaces")
		}
	})

	// Since v3.12.0 a superadmin administers every namespace but has no implicit
	// read access to note content: an ungranted namespace is refused just as it is
	// for anyone else. The full role matrix lives in middleware/permission_test.go.
	t.Run("superadmin has no implicit read on an ungranted namespace", func(t *testing.T) {
		root := &middleware.UserContext{ID: 1, Username: "root", Role: "superadmin"}
		w := serveFile(h, root, "beta")
		if w.Code != http.StatusForbidden {
			t.Fatalf("want 403 for an ungranted superadmin, got %d (%s)", w.Code, w.Body.String())
		}
		if body := w.Body.String(); body == "beta namespace file contents" {
			t.Fatal("file contents leaked to an ungranted superadmin")
		}
	})
}

// Single-user mode constructs the handler with a nil PermissionChecker; the
// check must be skipped rather than deny-by-default, or every image in every
// note 403s on a single-user install.
func TestServeFileSingleUserModeUnaffected(t *testing.T) {
	notesDir := notesDirWithTwoNamespaces(t)
	h := NewUploadHandler(localStore(t, notesDir), nil)

	for _, ns := range []string{"alpha", "beta"} {
		if w := serveFile(h, nil, ns); w.Code != http.StatusOK {
			t.Fatalf("single-user mode: want 200 for %s, got %d (%s)", ns, w.Code, w.Body.String())
		}
	}
}
