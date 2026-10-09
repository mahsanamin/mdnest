package handlers

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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
func (f *fakeGrantStore) UpdateGrantPermission(int, string) error        { return nil }
func (f *fakeGrantStore) DeleteGrant(int) error                          { return nil }
func (f *fakeGrantStore) DeleteGrantsForNamespace(string) (int64, error) { return 0, nil }
func (f *fakeGrantStore) GetGrant(int) (*store.Grant, error)             { return nil, nil }
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

func (fakeNsAdminStore) Add(int, string, *int) error                 { return nil }
func (fakeNsAdminStore) Remove(int, string) error                    { return nil }
func (fakeNsAdminStore) IsAdminOf(int, string) (bool, error)         { return false, nil }
func (fakeNsAdminStore) DeleteAllForNamespace(string) (int64, error) { return 0, nil }
func (fakeNsAdminStore) ListByUser(int) ([]string, error)            { return nil, nil }
func (fakeNsAdminStore) CountByUser(int) (int, error)                { return 0, nil }
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
	perms := middleware.NewPermissionChecker(&fakeGrantStore{userID: 7, namespace: "alpha"}, fakeNsAdminStore{}, nil)
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

// App replicas hold no attachment bytes: when an attachment proxy is set,
// HandleServeFile must delegate the whole request to it (the writer) instead of
// reading locally.
func TestServeFileDelegatesToAttachmentProxy(t *testing.T) {
	h := NewUploadHandler(nil, nil)
	var gotPath string
	h.SetWriterProxy(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusTeapot)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/files/alpha/img/a.png", nil)
	rec := httptest.NewRecorder()
	h.HandleServeFile(rec, req)

	if rec.Code != http.StatusTeapot || gotPath != "/api/files/alpha/img/a.png" {
		t.Fatalf("expected delegation to proxy, got code=%d path=%q", rec.Code, gotPath)
	}
}

// Attachment uploads on an app replica must also be forwarded to the writer
// (keeping binary bytes off the durability queue) rather than written locally.
func TestUploadDelegatesToWriterProxy(t *testing.T) {
	h := NewUploadHandler(nil, nil)
	var gotPath string
	h.SetWriterProxy(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusTeapot)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/upload?ns=alpha&path=x", nil)
	rec := httptest.NewRecorder()
	h.HandleUpload(rec, req)

	if rec.Code != http.StatusTeapot || gotPath != "/api/upload" {
		t.Fatalf("expected upload delegation to proxy, got code=%d path=%q", rec.Code, gotPath)
	}
}

// pathWriteGrantStore grants write on exactly one (namespace, path) subtree,
// matched with the real store.PathCovers.
type pathWriteGrantStore struct {
	fakeGrantStore
	path string
}

func (f *pathWriteGrantStore) CheckAccess(userID int, namespace, p, _ string) bool {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return userID == f.userID && namespace == f.namespace && store.PathCovers(f.path, p)
}

func uploadAs(h *UploadHandler, uc *middleware.UserContext, ns, reqPath, filename string) *httptest.ResponseRecorder {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", filename)
	fw.Write([]byte("uploaded bytes"))
	mw.Close()
	q := url.Values{"ns": {ns}, "path": {reqPath}}
	r := httptest.NewRequest(http.MethodPost, "/api/upload?"+q.Encode(), &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r = middleware.WithUser(r, uc)
	w := httptest.NewRecorder()
	h.HandleUpload(w, r)
	return w
}

// /api/upload is authorised by the route middleware on ?path=, but the file is
// written to dir(path)/<uploaded filename>. With a grant on /Shared, sending
// path=Shared put the file at the namespace root — outside the grant. The
// handler must check write access on the destination it actually writes.
func TestUploadChecksWriteOnActualDestination(t *testing.T) {
	notesDir := notesDirWithTwoNamespaces(t)
	gs := &pathWriteGrantStore{fakeGrantStore: fakeGrantStore{userID: 7, namespace: "alpha"}, path: "/Shared"}
	h := NewUploadHandler(localStore(t, notesDir), middleware.NewPermissionChecker(gs, fakeNsAdminStore{}, nil))
	collaborator := &middleware.UserContext{ID: 7, Username: "carol", Role: "collaborator"}

	t.Run("upload next to a note inside the grant is allowed", func(t *testing.T) {
		w := uploadAs(h, collaborator, "alpha", "Shared/note.md", "pic.png")
		if w.Code != http.StatusOK {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		if _, err := os.Stat(filepath.Join(notesDir, "alpha", "Shared", "pic.png")); err != nil {
			t.Fatalf("upload not written inside the grant: %v", err)
		}
	})

	t.Run("destination outside the grant is refused", func(t *testing.T) {
		w := uploadAs(h, collaborator, "alpha", "Shared", "escape.png")
		if w.Code != http.StatusForbidden {
			t.Fatalf("want 403 for a destination outside the grant, got %d (%s)", w.Code, w.Body.String())
		}
		if _, err := os.Stat(filepath.Join(notesDir, "alpha", "escape.png")); err == nil {
			t.Fatal("file was written at the namespace root, outside the /Shared grant")
		}
	})
}

// An SVG (or HTML) note opened directly from /api/files must not be able to
// run script on mdnest's origin, where it could read the viewer's session
// token. A CSP sandbox makes the directly-opened document inert; <img>
// rendering is unaffected. nosniff goes on every file.
func TestServeFileActiveContentIsSandboxed(t *testing.T) {
	notesDir := t.TempDir()
	os.MkdirAll(filepath.Join(notesDir, "alpha"), 0o755)
	os.WriteFile(filepath.Join(notesDir, "alpha", "x.svg"), []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), 0o644)
	os.WriteFile(filepath.Join(notesDir, "alpha", "page.html"), []byte(`<script>alert(1)</script>`), 0o644)
	os.WriteFile(filepath.Join(notesDir, "alpha", "a.png"), []byte("\x89PNG"), 0o644)
	os.WriteFile(filepath.Join(notesDir, "alpha", "noext"), []byte(`<html><script>alert(1)</script></html>`), 0o644)
	h := NewUploadHandler(localStore(t, notesDir), nil)

	for _, f := range []string{"x.svg", "page.html"} {
		rec := httptest.NewRecorder()
		h.HandleServeFile(rec, httptest.NewRequest(http.MethodGet, "/api/files/alpha/"+f, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", f, rec.Code)
		}
		if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") || !strings.Contains(csp, "default-src 'none'") {
			t.Errorf("%s: active content served without a sandboxing CSP (got %q)", f, csp)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: missing nosniff", f)
		}
	}
	rec := httptest.NewRecorder()
	h.HandleServeFile(rec, httptest.NewRequest(http.MethodGet, "/api/files/alpha/a.png", nil))
	if rec.Header().Get("Content-Security-Policy") != "" {
		t.Errorf("a plain image must not get the sandbox CSP")
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("png: missing nosniff")
	}

	// No recognised extension: the type must be declared, never sniffed from
	// the bytes, or HTML content would be served as text/html.
	rec = httptest.NewRecorder()
	h.HandleServeFile(rec, httptest.NewRequest(http.MethodGet, "/api/files/alpha/noext", nil))
	if ct := rec.Header().Get("Content-Type"); strings.Contains(ct, "html") || ct == "" {
		t.Errorf("extension-less file served as %q; want a declared, non-HTML type", ct)
	}
}

func TestIsActiveContentType(t *testing.T) {
	for ct, want := range map[string]bool{
		"text/html; charset=utf-8":  true,
		"application/xhtml+xml":     true,
		"image/svg+xml":             true,
		"text/xml":                  true,
		"text/javascript":           true,
		"image/png":                 false,
		"application/pdf":           false,
		"application/octet-stream":  false,
		"text/plain; charset=utf-8": false,
	} {
		if got := isActiveContentType(ct); got != want {
			t.Errorf("isActiveContentType(%q) = %v, want %v", ct, got, want)
		}
	}
}
