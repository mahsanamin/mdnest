package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
)

// create writes to a note named in the request body, past the path-based route
// guard, so it must re-check write access on that real target. A user with a
// grant on one note must not be able to aim create at another.
func TestCreateTask_DeniesUnauthorizedBodyNote(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team", "allowed.md", "- [ ] Seed\n")
	stg, _ := storage.NewLocalStorage(root)
	// Authorized only for allowed.md; the request body targets restricted.md.
	canWrite := func(_ *http.Request, _, path string) bool { return path == "allowed.md" }
	h := NewTaskHandler(stg, func(_ *http.Request, n []string) []string { return n }, canWrite)

	body := `{"note":"restricted.md","title":"Sneak in"}`
	r := httptest.NewRequest(http.MethodPost, "/api/tasks?ns=team", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h.HandleTasks(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", w.Code, w.Body.String())
	}
	if _, err := stg.ReadFile(r.Context(), "team", "restricted.md"); err == nil {
		t.Fatalf("restricted.md was created despite denial")
	}
}

func TestCreateTask_AllowsAuthorizedBodyNote(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team", "allowed.md", "- [ ] Seed\n")
	stg, _ := storage.NewLocalStorage(root)
	canWrite := func(_ *http.Request, _, path string) bool { return path == "allowed.md" }
	h := NewTaskHandler(stg, func(_ *http.Request, n []string) []string { return n }, canWrite)

	body := `{"note":"allowed.md","title":"Legit task"}`
	r := httptest.NewRequest(http.MethodPost, "/api/tasks?ns=team", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h.HandleTasks(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body = %s", w.Code, w.Body.String())
	}
	data, err := stg.ReadFile(r.Context(), "team", "allowed.md")
	if err != nil || !bytes.Contains(data, []byte("Legit task")) {
		t.Fatalf("task not appended to allowed.md: err=%v data=%s", err, data)
	}
}

// A nil checker must fail closed rather than allow the write.
func TestCreateTask_NilCheckerFailsClosed(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team", "allowed.md", "- [ ] Seed\n")
	stg, _ := storage.NewLocalStorage(root)
	h := NewTaskHandler(stg, func(_ *http.Request, n []string) []string { return n }, nil)

	body := `{"note":"allowed.md","title":"Nope"}`
	r := httptest.NewRequest(http.MethodPost, "/api/tasks?ns=team", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h.HandleTasks(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (fail closed); body = %s", w.Code, w.Body.String())
	}
}
