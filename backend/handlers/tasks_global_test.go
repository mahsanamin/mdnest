package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
)

func writeNs(t *testing.T, root, ns, file, content string) {
	t.Helper()
	dir := filepath.Join(root, ns)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHandleGlobalTasks(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team-a", "plan.md", "- [ ] Alpha task\n  - assignee: alice\n")
	writeNs(t, root, "team-b", "todo.md", "- [x] Beta done\n- [ ] Beta open\n")
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	// Single-mode wiring: an explicit all-access pass-through.
	h := NewTaskHandler(stg, func(_ *http.Request, names []string) []string { return names })

	r := httptest.NewRequest(http.MethodGet, "/api/tasks/all", nil)
	w := httptest.NewRecorder()
	h.HandleGlobalTasks(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp TasksResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Tasks) != 3 {
		t.Fatalf("want 3 tasks across namespaces, got %d: %+v", len(resp.Tasks), resp.Tasks)
	}
	// Every task must carry its owning namespace, and be sorted by it.
	byNs := map[string]int{}
	for _, tk := range resp.Tasks {
		if tk.Namespace == "" {
			t.Fatalf("task missing namespace: %+v", tk)
		}
		byNs[tk.Namespace]++
	}
	if byNs["team-a"] != 1 || byNs["team-b"] != 2 {
		t.Fatalf("per-namespace counts wrong: %v", byNs)
	}
	if resp.Tasks[0].Namespace != "team-a" {
		t.Errorf("tasks not sorted by namespace: %+v", resp.Tasks[0])
	}
}

func TestHandleGlobalTasks_FilterEnforced(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team-a", "plan.md", "- [ ] Alpha\n")
	writeNs(t, root, "secret", "s.md", "- [ ] Hidden\n")
	stg, _ := storage.NewLocalStorage(root)
	// Only team-a is accessible.
	h := NewTaskHandler(stg, func(_ *http.Request, names []string) []string {
		var out []string
		for _, n := range names {
			if n == "team-a" {
				out = append(out, n)
			}
		}
		return out
	})

	r := httptest.NewRequest(http.MethodGet, "/api/tasks/all", nil)
	w := httptest.NewRecorder()
	h.HandleGlobalTasks(w, r)

	var resp TasksResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, tk := range resp.Tasks {
		if tk.Namespace == "secret" {
			t.Fatalf("inaccessible namespace leaked into global view: %+v", tk)
		}
	}
	if len(resp.Tasks) != 1 {
		t.Fatalf("want only team-a's task, got %d", len(resp.Tasks))
	}
}

// A handler built without an access filter must serve nothing rather than
// leak every namespace — the global view fails closed.
func TestHandleGlobalTasks_NilFilterServesNothing(t *testing.T) {
	root := t.TempDir()
	writeNs(t, root, "team-a", "plan.md", "- [ ] Alpha\n")
	writeNs(t, root, "secret", "s.md", "- [ ] Hidden\n")
	stg, _ := storage.NewLocalStorage(root)
	h := NewTaskHandler(stg, nil)

	r := httptest.NewRequest(http.MethodGet, "/api/tasks/all", nil)
	w := httptest.NewRecorder()
	h.HandleGlobalTasks(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp TasksResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Tasks) != 0 {
		t.Fatalf("nil filter must serve no tasks, got %d: %+v", len(resp.Tasks), resp.Tasks)
	}
}

func TestUnionBoards(t *testing.T) {
	def := defaultBoard()
	custom := BoardConfig{Version: 1, Columns: []BoardColumn{
		{ID: "todo", Title: "To Do"},            // dup id, ignored
		{ID: "review", Title: "Review"},         // new
		{ID: "done", Title: "Done", Done: true}, // dup id
	}}
	u := unionBoards([]BoardConfig{def, custom})
	ids := map[string]bool{}
	for _, c := range u.Columns {
		ids[c.ID] = true
	}
	if !ids["todo"] || !ids["doing"] || !ids["done"] || !ids["review"] {
		t.Fatalf("union missing columns: %+v", u.Columns)
	}
	// Default columns keep their leading order.
	if u.Columns[0].ID != "todo" {
		t.Fatalf("default columns should lead: %+v", u.Columns)
	}
}
