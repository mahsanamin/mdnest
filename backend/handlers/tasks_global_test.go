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
	h := NewTaskHandler(stg, func(_ *http.Request, names []string) []string { return names }, func(_ *http.Request, _, _ string) bool { return true })

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

// The merged board keeps one milestone per id; each namespace's own milestones
// (same id, different titles) still come back apart, and never for a namespace
// the caller cannot see.
func TestHandleGlobalTasks_BoardsPerNamespace(t *testing.T) {
	root := t.TempDir()
	board := func(title string) string {
		return `{"version":1,"columns":[{"id":"todo","title":"To Do"},{"id":"done","title":"Done","done":true}],"milestones":[{"id":"v1","title":"` + title + `"}]}`
	}
	writeNs(t, root, "team-a", "plan.md", "- [ ] Alpha\n  - milestone: v1\n")
	writeNs(t, root, "team-a/.mdnest", "board.json", board("Alpha launch"))
	writeNs(t, root, "team-b", "todo.md", "- [ ] Beta\n  - milestone: v1\n")
	writeNs(t, root, "team-b/.mdnest", "board.json", board("Beta launch"))
	writeNs(t, root, "secret", "s.md", "- [ ] Hidden\n")
	writeNs(t, root, "secret/.mdnest", "board.json", board("Secret launch"))
	stg, _ := storage.NewLocalStorage(root)
	h := NewTaskHandler(stg, func(_ *http.Request, names []string) []string {
		var out []string
		for _, n := range names {
			if n != "secret" {
				out = append(out, n)
			}
		}
		return out
	}, func(_ *http.Request, _, _ string) bool { return true })

	w := httptest.NewRecorder()
	h.HandleGlobalTasks(w, httptest.NewRequest(http.MethodGet, "/api/tasks/all", nil))
	var resp TasksResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Board.Milestones) != 1 {
		t.Fatalf("merged board milestones = %+v", resp.Board.Milestones)
	}
	if len(resp.Boards) != 2 {
		t.Fatalf("want the boards of team-a and team-b only, got %v", resp.Boards)
	}
	for ns, title := range map[string]string{"team-a": "Alpha launch", "team-b": "Beta launch"} {
		ms := resp.Boards[ns].Milestones
		if len(ms) != 1 || ms[0].Title != title {
			t.Errorf("%s milestones = %+v, want %q", ns, ms, title)
		}
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
	}, func(_ *http.Request, _, _ string) bool { return true })

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
	h := NewTaskHandler(stg, nil, func(_ *http.Request, _, _ string) bool { return true })

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
