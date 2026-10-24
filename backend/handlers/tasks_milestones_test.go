package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

func milestoneHandler(t *testing.T, files map[string]string) (*TaskHandler, storage.Storage) {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		writeNs(t, root, "team", name, content)
	}
	stg, _ := storage.NewLocalStorage(root)
	allow := func(_ *http.Request, _, _ string) bool { return true }
	return NewTaskHandler(stg, func(_ *http.Request, n []string) []string { return n }, allow), stg
}

func doTask(h *TaskHandler, method, url, body, user string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, url, bytes.NewBufferString(body))
	if user != "" {
		r = middleware.WithUser(r, &middleware.UserContext{ID: 1, Username: user, Role: "collaborator"})
	}
	w := httptest.NewRecorder()
	if strings.HasPrefix(url, "/api/board") {
		h.HandleBoard(w, r)
	} else {
		h.HandleTasks(w, r)
	}
	return w
}

func TestCreateTask_StampsCreatorAndTime(t *testing.T) {
	h, stg := milestoneHandler(t, map[string]string{"tasks.md": ""})
	defer func(prev func() time.Time) { taskNow = prev }(taskNow)
	taskNow = func() time.Time { return time.Date(2026, 10, 23, 14, 5, 12, 0, time.FixedZone("CEST", 7200)) }

	// The client cannot choose who created the task, nor when.
	body := `{"note":"tasks.md","title":"Ship it","milestone":"m1","createdBy":"mallory","created":"2001-01-01T00:00:00Z"}`
	w := doTask(h, http.MethodPost, "/api/tasks?ns=team", body, "alice")
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
	}
	var tk Task
	_ = json.Unmarshal(w.Body.Bytes(), &tk)
	if tk.CreatedBy != "alice" || tk.Created != "2026-10-23T12:05:12Z" || tk.Milestone != "m1" {
		t.Fatalf("task = %+v, want createdBy alice, created 2026-10-23T12:05:12Z (UTC), milestone m1", tk)
	}
	data, _ := stg.ReadFile(t.Context(), "team", "tasks.md")
	for _, want := range []string{"  - milestone: m1\n", "  - created-by: alice\n", "  - created: 2026-10-23T12:05:12Z\n"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("note lacks %q:\n%s", want, data)
		}
	}
}

func TestCreateTask_SingleModeHasNoCreator(t *testing.T) {
	h, stg := milestoneHandler(t, map[string]string{"tasks.md": ""})
	if w := doTask(h, http.MethodPost, "/api/tasks?ns=team", `{"note":"tasks.md","title":"Solo"}`, ""); w.Code != http.StatusCreated {
		t.Fatalf("status = %d", w.Code)
	}
	data, _ := stg.ReadFile(t.Context(), "team", "tasks.md")
	if strings.Contains(string(data), "created-by") || !strings.Contains(string(data), "  - created: ") {
		t.Fatalf("want a created time and no creator without a user:\n%s", data)
	}
}

func TestEditTask_KeepsCreatorAndTime(t *testing.T) {
	note := "- [ ] Old title\n  - ref: TE-abc12\n  - created-by: alice\n  - created: 2026-10-01T08:00:00Z\n"
	h, stg := milestoneHandler(t, map[string]string{"tasks.md": note})
	body := `{"line":1,"raw":"- [ ] Old title","replace":{"title":"New title","column":"todo","milestone":"m2"}}`
	if w := doTask(h, http.MethodPatch, "/api/tasks?ns=team&path=tasks.md", body, "bob"); w.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
	}
	data, _ := stg.ReadFile(t.Context(), "team", "tasks.md")
	for _, want := range []string{"New title", "milestone: m2", "created-by: alice", "created: 2026-10-01T08:00:00Z", "ref: TE-abc12"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("edit lost %q:\n%s", want, data)
		}
	}
	if strings.Contains(string(data), "bob") {
		t.Errorf("the editor must not become the creator:\n%s", data)
	}
}

func TestSetField_MilestoneOnlyNotProvenance(t *testing.T) {
	h, stg := milestoneHandler(t, map[string]string{"tasks.md": "- [ ] Task\n  - created-by: alice\n"})
	ok := `{"line":1,"raw":"- [ ] Task","setField":{"key":"milestone","value":"m1"}}`
	if w := doTask(h, http.MethodPatch, "/api/tasks?ns=team&path=tasks.md", ok, "bob"); w.Code != http.StatusOK {
		t.Fatalf("milestone: status = %d; body = %s", w.Code, w.Body.String())
	}
	for _, key := range []string{"created-by", "created"} {
		body := `{"line":1,"raw":"- [ ] Task","setField":{"key":"` + key + `","value":"bob"}}`
		if w := doTask(h, http.MethodPatch, "/api/tasks?ns=team&path=tasks.md", body, "bob"); w.Code != http.StatusBadRequest {
			t.Errorf("%s must not be editable: status = %d", key, w.Code)
		}
	}
	data, _ := stg.ReadFile(t.Context(), "team", "tasks.md")
	if !strings.Contains(string(data), "milestone: m1") || !strings.Contains(string(data), "created-by: alice") {
		t.Fatalf("note = %s", data)
	}
}

func TestBoard_MilestonesSavedValidatedAndKept(t *testing.T) {
	h, _ := milestoneHandler(t, map[string]string{"tasks.md": ""})
	cols := `"columns":[{"id":"todo","title":"To Do"},{"id":"done","title":"Done","done":true}]`
	ms := `"milestones":[{"id":"m1","title":"Reset","due":"2026-11-01"},{"id":"m2","title":"CI","closed":true}]`
	if w := doTask(h, http.MethodPut, "/api/board?ns=team", `{`+cols+`,`+ms+`}`, "alice"); w.Code != http.StatusOK {
		t.Fatalf("save: status = %d; body = %s", w.Code, w.Body.String())
	}
	// A client that only knows columns keeps the milestones.
	if w := doTask(h, http.MethodPut, "/api/board?ns=team", `{`+cols+`}`, "alice"); w.Code != http.StatusOK {
		t.Fatalf("columns only: status = %d", w.Code)
	}
	var b BoardConfig
	_ = json.Unmarshal(doTask(h, http.MethodGet, "/api/board?ns=team", "", "alice").Body.Bytes(), &b)
	if len(b.Milestones) != 2 || b.Milestones[0].Due != "2026-11-01" || !b.Milestones[1].Closed {
		t.Fatalf("milestones = %+v", b.Milestones)
	}
	// An explicit empty list removes them.
	_ = doTask(h, http.MethodPut, "/api/board?ns=team", `{`+cols+`,"milestones":[]}`, "alice")
	var cleared BoardConfig
	_ = json.Unmarshal(doTask(h, http.MethodGet, "/api/board?ns=team", "", "alice").Body.Bytes(), &cleared)
	if len(cleared.Milestones) != 0 {
		t.Fatalf("milestones after clearing = %+v", cleared.Milestones)
	}

	bad := map[string]string{
		"bad id":    `[{"id":"has space","title":"x"}]`,
		"duplicate": `[{"id":"m1","title":"a"},{"id":"m1","title":"b"}]`,
		"no title":  `[{"id":"m1","title":" "}]`,
		"bad due":   `[{"id":"m1","title":"a","due":"01/11/2026"}]`,
	}
	for name, list := range bad {
		if w := doTask(h, http.MethodPut, "/api/board?ns=team", `{`+cols+`,"milestones":`+list+`}`, "alice"); w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, w.Code)
		}
	}
}

func TestUnionBoards_MergesMilestones(t *testing.T) {
	a := BoardConfig{Milestones: []Milestone{{ID: "m1", Title: "A"}}}
	b := BoardConfig{Milestones: []Milestone{{ID: "m1", Title: "B"}, {ID: "m2", Title: "C"}}}
	got := unionBoards([]BoardConfig{a, b}).Milestones
	if len(got) != 2 || got[0].Title != "A" || got[1].ID != "m2" {
		t.Fatalf("union = %+v", got)
	}
}

func TestParseCard_ReadsMilestoneAndProvenance(t *testing.T) {
	note := "- [ ] Task\n  - milestone: m1\n  - created-by: alice\n  - created: 2026-10-01T08:00:00Z\n"
	tasks := parseNoteTasks("tasks.md", []byte(note), defaultBoard())
	if len(tasks) != 1 || tasks[0].Milestone != "m1" || tasks[0].CreatedBy != "alice" || tasks[0].Created != "2026-10-01T08:00:00Z" {
		t.Fatalf("tasks = %+v", tasks)
	}
}

func TestCompleted_StampedOnCloseRemovedOnReopenKeptByEdit(t *testing.T) {
	h, stg := milestoneHandler(t, map[string]string{"tasks.md": "- [ ] Task\n  - steps:\n    - [ ] step\n"})
	defer func(prev func() time.Time) { taskNow = prev }(taskNow)
	taskNow = func() time.Time { return time.Date(2026, 10, 24, 9, 0, 0, 0, time.UTC) }
	read := func() string { d, _ := stg.ReadFile(t.Context(), "team", "tasks.md"); return string(d) }
	patch := func(body string) int {
		return doTask(h, http.MethodPatch, "/api/tasks?ns=team&path=tasks.md", body, "bob").Code
	}

	// A step closing is not the task closing.
	if c := patch(`{"line":3,"raw":"    - [ ] step","checked":true}`); c != http.StatusOK || strings.Contains(read(), "completed") {
		t.Fatalf("step toggle: status %d, note:\n%s", c, read())
	}
	if c := patch(`{"line":1,"raw":"- [ ] Task","toColumn":"done"}`); c != http.StatusOK || !strings.Contains(read(), "  - completed: 2026-10-24T09:00:00Z\n") {
		t.Fatalf("close: status %d, note:\n%s", c, read())
	}
	// An edit that keeps it done keeps the time; reopening removes it.
	taskNow = func() time.Time { return time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC) }
	if c := patch(`{"line":1,"raw":"- [x] Task","replace":{"title":"Task","column":"done","steps":[{"text":"step","checked":true}]}}`); c != http.StatusOK || !strings.Contains(read(), "completed: 2026-10-24T09:00:00Z") {
		t.Fatalf("edit while done: status %d, note:\n%s", c, read())
	}
	if c := patch(`{"line":1,"raw":"- [x] Task","checked":false}`); c != http.StatusOK || strings.Contains(read(), "completed") {
		t.Fatalf("reopen: status %d, note:\n%s", c, read())
	}
	for _, key := range []string{"completed"} {
		if c := patch(`{"line":1,"raw":"- [ ] Task","setField":{"key":"` + key + `","value":"x"}}`); c != http.StatusBadRequest {
			t.Errorf("%s must not be editable: status %d", key, c)
		}
	}
}

func TestCreateTask_InDoneColumnIsCompleted(t *testing.T) {
	h, stg := milestoneHandler(t, map[string]string{"tasks.md": ""})
	if w := doTask(h, http.MethodPost, "/api/tasks?ns=team", `{"note":"tasks.md","title":"Already done","column":"done"}`, "alice"); w.Code != http.StatusCreated {
		t.Fatalf("status = %d", w.Code)
	}
	data, _ := stg.ReadFile(t.Context(), "team", "tasks.md")
	if !strings.Contains(string(data), "  - completed: ") {
		t.Fatalf("a task created done must carry its completion time:\n%s", data)
	}
}

func TestBoard_MilestoneStartValidated(t *testing.T) {
	h, _ := milestoneHandler(t, map[string]string{"tasks.md": ""})
	cols := `"columns":[{"id":"todo","title":"To Do"},{"id":"done","title":"Done","done":true}]`
	cases := map[string]int{
		`[{"id":"m1","title":"a","start":"2026-11-01","due":"2026-11-30"}]`: http.StatusOK,
		`[{"id":"m1","title":"a","start":"2026-12-01","due":"2026-11-30"}]`: http.StatusBadRequest,
		`[{"id":"m1","title":"a","start":"1 Nov"}]`:                         http.StatusBadRequest,
	}
	for list, want := range cases {
		if w := doTask(h, http.MethodPut, "/api/board?ns=team", `{`+cols+`,"milestones":`+list+`}`, "alice"); w.Code != want {
			t.Errorf("%s: status = %d, want %d", list, w.Code, want)
		}
	}
}
