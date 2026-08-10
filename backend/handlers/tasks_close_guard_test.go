package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
)

func newRWTaskHandler(stg storage.Storage) *TaskHandler {
	return NewTaskHandler(stg,
		func(_ *http.Request, n []string) []string { return n },
		func(_ *http.Request, _, _ string) bool { return true },
	)
}

// A task with an open sub-task cannot be checked done nor moved to a Done
// column until every sub-task is resolved.
func TestMutate_BlocksClosingWithOpenSubtasks(t *testing.T) {
	note := "- [ ] Parent\n  - steps:\n    - [x] one\n    - [ ] two\n"
	root := t.TempDir()
	writeNs(t, root, "team", "n.md", note)
	stg, _ := storage.NewLocalStorage(root)
	h := newRWTaskHandler(stg)

	// Check the parent (line 1) done -> rejected.
	body := `{"line":1,"raw":"- [ ] Parent","checked":true}`
	r := httptest.NewRequest(http.MethodPatch, "/api/tasks?ns=team&path=n.md", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h.HandleTasks(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("checked close: status = %d, want 422; body = %s", w.Code, w.Body.String())
	}
	if data, _ := stg.ReadFile(r.Context(), "team", "n.md"); !bytes.Contains(data, []byte("- [ ] Parent")) {
		t.Fatalf("parent was closed despite open sub-task: %s", data)
	}

	// Move the parent to the Done column -> also rejected.
	body = `{"line":1,"raw":"- [ ] Parent","toColumn":"done"}`
	r = httptest.NewRequest(http.MethodPatch, "/api/tasks?ns=team&path=n.md", bytes.NewBufferString(body))
	w = httptest.NewRecorder()
	h.HandleTasks(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("move-to-done: status = %d, want 422; body = %s", w.Code, w.Body.String())
	}
}

// Checking a sub-task itself is never blocked, and a parent whose sub-tasks are
// all resolved can be closed.
func TestMutate_AllowsClosingWhenSubtasksResolved(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team", "n.md", "- [ ] Parent\n  - steps:\n    - [ ] only\n")
	stg, _ := storage.NewLocalStorage(root)
	h := newRWTaskHandler(stg)

	// Resolve the sub-task (line 3) — allowed.
	body := `{"line":3,"raw":"    - [ ] only","checked":true}`
	r := httptest.NewRequest(http.MethodPatch, "/api/tasks?ns=team&path=n.md", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h.HandleTasks(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("check sub-task: status = %d, want 200; body = %s", w.Code, w.Body.String())
	}

	// Now the parent has no open sub-tasks — closing succeeds.
	data, _ := stg.ReadFile(r.Context(), "team", "n.md")
	lines := strings.Split(string(data), "\n")
	body = `{"line":1,"raw":"` + lines[0] + `","checked":true}`
	r = httptest.NewRequest(http.MethodPatch, "/api/tasks?ns=team&path=n.md", bytes.NewBufferString(body))
	w = httptest.NewRecorder()
	h.HandleTasks(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("close parent: status = %d, want 200; body = %s", w.Code, w.Body.String())
	}
}

// Saving an edit (Replace) that lands the task in a Done column is blocked while
// the incoming step set still has an open sub-task.
func TestMutate_BlocksClosingViaEditorSave(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team", "n.md", "- [ ] Parent\n  - steps:\n    - [ ] one\n")
	stg, _ := storage.NewLocalStorage(root)
	h := newRWTaskHandler(stg)

	// Editor save into the Done column with one step still open -> rejected.
	body := `{"line":1,"raw":"- [ ] Parent","replace":{"title":"Parent","column":"done","steps":[{"text":"one","checked":false}]}}`
	r := httptest.NewRequest(http.MethodPatch, "/api/tasks?ns=team&path=n.md", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	h.HandleTasks(w, r)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("editor close: status = %d, want 422; body = %s", w.Code, w.Body.String())
	}

	// Same save with the step resolved -> allowed.
	body = `{"line":1,"raw":"- [ ] Parent","replace":{"title":"Parent","column":"done","steps":[{"text":"one","checked":true}]}}`
	r = httptest.NewRequest(http.MethodPatch, "/api/tasks?ns=team&path=n.md", bytes.NewBufferString(body))
	w = httptest.NewRecorder()
	h.HandleTasks(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("editor close resolved: status = %d, want 200; body = %s", w.Code, w.Body.String())
	}
}
