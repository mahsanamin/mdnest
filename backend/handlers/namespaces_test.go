package handlers

import (
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
)

type fakePersonalLister struct{ ns []string }

func (f fakePersonalLister) PersonalNamespaces() ([]string, error) { return f.ns, nil }

// The management-plane namespace list must drop personal workspaces (the
// owner's own namespace, reported via PersonalNamespaces) while keeping team
// namespaces untouched.
func TestExcludePersonal(t *testing.T) {
	h := NewNamespaceHandler(nil, nil, fakePersonalLister{ns: []string{"olivier@forterro.com"}})
	got := h.excludePersonal([]string{
		"team-a",
		"olivier@forterro.com", // personal → drop
		"it-operations",
	})
	want := []string{"team-a", "it-operations"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("excludePersonal = %v, want %v", got, want)
	}
}

// With no personal lister (single mode) the list is returned unchanged.
func TestExcludePersonalNilLister(t *testing.T) {
	h := NewNamespaceHandler(nil, nil, nil)
	got := h.excludePersonal([]string{"team-a", "team-b"})
	want := []string{"team-a", "team-b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("excludePersonal = %v, want %v", got, want)
	}
}

// GitHub issue #123: an empty namespace list must say why, so the UI can name
// the fix instead of always blaming "mdnest.conf mounts".
func emptyReasonFor(t *testing.T, root string) (string, string) {
	t.Helper()
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	h := NewNamespaceHandler(stg, nil, nil)
	h.SetNotesDir(root)
	w := httptest.NewRecorder()
	h.ListNamespaces(w, httptest.NewRequest(http.MethodGet, "/api/namespaces", nil))
	return w.Header().Get("X-Namespaces-Empty-Reason"), strings.TrimSpace(w.Body.String())
}

func TestEmptyNamespacesSayWhy(t *testing.T) {
	// Nothing mounted (volumes on the frontend, or none at all).
	root := t.TempDir()
	if reason, body := emptyReasonFor(t, root); reason != "none-mounted" || body != "[]" {
		t.Fatalf("empty NOTES_DIR: reason=%q body=%s", reason, body)
	}
	// The notes folder mounted AT /data/notes: files, no folders.
	os.WriteFile(filepath.Join(root, "todo.md"), []byte("# todo\n"), 0o644)
	os.WriteFile(filepath.Join(root, ".DS_Store"), []byte("x"), 0o644)
	if reason, _ := emptyReasonFor(t, root); reason != "files-at-root" {
		t.Fatalf("files directly in NOTES_DIR: reason=%q", reason)
	}
	// A hidden folder (.git, .mdnest) is not a namespace and does not count.
	only := t.TempDir()
	os.MkdirAll(filepath.Join(only, ".git"), 0o755)
	if reason, _ := emptyReasonFor(t, only); reason != "none-mounted" {
		t.Fatalf("only a hidden folder: reason=%q", reason)
	}
	// Mounted properly: a list and no header.
	os.MkdirAll(filepath.Join(root, "notes"), 0o755)
	if reason, body := emptyReasonFor(t, root); reason != "" || body != `["notes"]` {
		t.Fatalf("mounted: reason=%q body=%s", reason, body)
	}
}

// A NOTES_DIR the backend may not read (permissions, SELinux without :z) is
// reported as such, not as a bare 500 the UI can only call "no namespaces".
type permDeniedStore struct{ storage.Storage }

func (permDeniedStore) ListNamespaces(context.Context) ([]string, error) {
	return nil, &fs.PathError{Op: "open", Path: "/data/notes", Err: fs.ErrPermission}
}

func TestUnreadableNotesDirSaysSo(t *testing.T) {
	h := NewNamespaceHandler(permDeniedStore{}, nil, nil)
	w := httptest.NewRecorder()
	h.ListNamespaces(w, httptest.NewRequest(http.MethodGet, "/api/namespaces", nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" || w.Header().Get("X-Namespaces-Empty-Reason") != "unreadable" {
		t.Fatalf("unreadable: %d %q reason=%q", w.Code, w.Body.String(), w.Header().Get("X-Namespaces-Empty-Reason"))
	}
}
