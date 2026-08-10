package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/mdnest/mdnest/backend/storage"
)

// TaskHandler aggregates GitHub-flavoured task-list items ("- [ ] ...") across
// every note in a namespace and exposes them as a flat list (for a task view)
// or grouped into board columns (for a kanban view). The markdown notes remain
// the single source of truth.
//
// A task may be enriched by an indented detail block directly under its checkbox
// line — metadata bullets ("- status:", "- due:", "- priority:", "- workload:",
// "- tags: [a, b]", "- defaultExpanded:"), nested step checkboxes (any indented
// checkbox is a step of the task above it), and a description ("- notes: |" block
// or a fenced code block). A task's column is derived from its checkbox state
// (checked → the Done column) and its "status:" field, falling back to a legacy
// inline "#tag". Moving a card writes the target column's status into the note,
// materialising a minimal detail block for a previously-simple task.
//
// Column definitions live in a per-namespace sidecar (.mdnest/board.json),
// mirroring the .mdnest/comments convention. When the sidecar is absent a
// default To Do / Doing / Done board is used.
type TaskHandler struct {
	store storage.Storage
	// nsFilter narrows a list of namespaces to those the request's user may
	// read. Supplied at construction (multi mode: perms.FilterNamespaces;
	// single mode: an explicit all-access pass-through). The global
	// (cross-namespace) task view enforces access solely through it, and
	// treats a nil filter as deny-all so access can never be left unwired.
	nsFilter func(r *http.Request, namespaces []string) []string
	// canWrite reports whether the request's user may write the given
	// namespace/path. create writes to a note named in the request body, which
	// the path-based route middleware cannot see, so it re-checks the real
	// target here. Supplied at construction (multi mode: perms.CheckWrite;
	// single mode: pass-through). A nil checker fails closed.
	canWrite func(r *http.Request, ns, path string) bool
}

// NewTaskHandler creates a task/board handler backed by the given storage.
// nsFilter is the per-request namespace access filter for the global
// (cross-namespace) task view and must be supplied by the caller: multi mode
// passes perms.FilterNamespaces; single mode passes an explicit pass-through
// (the single user owns every namespace). A nil filter makes the global view
// serve nothing rather than leak every namespace.
func NewTaskHandler(store storage.Storage, nsFilter func(r *http.Request, namespaces []string) []string, canWrite func(r *http.Request, ns, path string) bool) *TaskHandler {
	return &TaskHandler{store: store, nsFilter: nsFilter, canWrite: canWrite}
}

// BoardColumn is a single kanban column. Status is the value written to a task's
// `status:` field for this column (falling back to the legacy Tag, then the id).
// Tag is still read so inline "#tag" status markers keep working. Done marks the
// column that holds checked items ("- [x] ...").
type BoardColumn struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status,omitempty"`
	Tag    string `json:"tag,omitempty"`
	Done   bool   `json:"done,omitempty"`
}

// statusValue is the value written to a task's `status:` field for this column.
func (c BoardColumn) statusValue() string {
	if c.Status != "" {
		return c.Status
	}
	if c.Tag != "" {
		return c.Tag
	}
	return c.ID
}

// BoardConfig is the per-namespace column layout stored in .mdnest/board.json.
type BoardConfig struct {
	Version int           `json:"version"`
	Columns []BoardColumn `json:"columns"`
	// DefaultNote is the note new tasks are appended to when the caller does not
	// pick one (namespace-relative path, e.g. "tasks.md").
	DefaultNote string `json:"defaultNote,omitempty"`
}

// Step is a sub-task: a checkbox nested in a task's indented detail block.
type Step struct {
	Text    string `json:"text"`
	Checked bool   `json:"checked"`
	Line    int    `json:"line"` // 1-based line within the note
	Raw     string `json:"raw"`  // exact source line, for optimistic mutation
}

// Task is one aggregated task-list item, optionally enriched by an indented
// detail block (metadata bullets, nested step checkboxes and a description).
type Task struct {
	ID              string   `json:"id"`                  // content-stable id (path + title)
	Ref             string   `json:"ref,omitempty"`       // stable human id (namespace acronym + suffix), persisted in the note
	Namespace       string   `json:"namespace,omitempty"` // owning namespace (set in the global view)
	Path            string   `json:"path"`                // note that owns the item
	Line            int      `json:"line"`                // 1-based line of the checkbox
	Raw             string   `json:"raw"`                 // exact source line, for optimistic mutation
	Text            string   `json:"text"`                // title without checkbox or status tag
	Checked         bool     `json:"checked"`
	Column          string   `json:"column"` // resolved column id
	Status          string   `json:"status,omitempty"`
	Due             string   `json:"due,omitempty"`
	Priority        string   `json:"priority,omitempty"`
	Workload        string   `json:"workload,omitempty"`
	Assignee        string   `json:"assignee,omitempty"` // who is responsible for the task
	Tags            []string `json:"tags,omitempty"`
	DependsOn       []string `json:"dependsOn,omitempty"` // refs of tasks this one depends on (legacy notes may hold titles)
	BlockedBy       []string `json:"blockedBy,omitempty"` // refs of tasks blocking this one
	RelatedTo       []string `json:"relatedTo,omitempty"` // refs of loosely related tasks
	DefaultExpanded bool     `json:"defaultExpanded,omitempty"`
	Steps           []Step   `json:"steps,omitempty"`
	Notes           string   `json:"notes,omitempty"`
}

// TasksResponse is the payload of GET /api/tasks.
type TasksResponse struct {
	Board BoardConfig `json:"board"`
	Tasks []Task      `json:"tasks"`
}

// taskMutation is the body of PATCH /api/tasks. Exactly one of ToColumn or
// Checked must be set. Path is taken from the query string (for per-file
// authorization); Line + Raw pin the exact source line optimistically.
type taskMutation struct {
	Line     int    `json:"line"`
	Raw      string `json:"raw"`
	ToColumn string `json:"toColumn,omitempty"`
	Checked  *bool  `json:"checked,omitempty"`
	// Text rewrites the task/step title (checkbox state preserved).
	Text *string `json:"text,omitempty"`
	// SetField edits a single metadata bullet in the card's detail block
	// (due/priority/tags/workload/status); an empty value removes the field.
	SetField *struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	} `json:"setField,omitempty"`
	// Replace rewrites the whole task (checkbox line + detail block) from a spec.
	Replace *taskSpec `json:"replace,omitempty"`
}

// taskSpec is a full task definition used to create or replace a task and its
// detail block (the board editor's payload). Column drives the checkbox + status.
type taskSpec struct {
	Title           string     `json:"title"`
	Ref             string     `json:"ref"` // preserved on edit; generated when empty
	Column          string     `json:"column"`
	Due             string     `json:"due"`
	Priority        string     `json:"priority"`
	Workload        string     `json:"workload"`
	Assignee        string     `json:"assignee"`
	Tags            []string   `json:"tags"`
	DependsOn       []string   `json:"dependsOn"`
	BlockedBy       []string   `json:"blockedBy"`
	RelatedTo       []string   `json:"relatedTo"`
	DefaultExpanded bool       `json:"defaultExpanded"`
	Steps           []stepSpec `json:"steps"`
	Notes           string     `json:"notes"`
}

type stepSpec struct {
	Text    string `json:"text"`
	Checked bool   `json:"checked"`
}

// taskLineRe matches a GFM task-list item: indent, bullet, checkbox, rest.
var taskLineRe = regexp.MustCompile(`^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$`)

func defaultBoard() BoardConfig {
	return BoardConfig{
		Version: 1,
		Columns: []BoardColumn{
			{ID: "todo", Title: "To Do", Tag: "todo"},
			{ID: "doing", Title: "Doing", Tag: "doing"},
			{ID: "done", Title: "Done", Tag: "done", Done: true},
		},
	}
}

func (h *TaskHandler) boardFile() string {
	return path.Join(".mdnest", "board.json")
}

func (h *TaskHandler) loadBoard(ctx context.Context, ns string) BoardConfig {
	data, err := h.store.ReadFile(ctx, ns, h.boardFile())
	if err != nil {
		return defaultBoard()
	}
	var b BoardConfig
	if json.Unmarshal(data, &b) != nil || len(b.Columns) == 0 {
		return defaultBoard()
	}
	return b
}

func (h *TaskHandler) saveBoard(ctx context.Context, ns string, b BoardConfig) error {
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	return h.store.WriteFile(ctx, ns, h.boardFile(), append(data, '\n'))
}

// parseTaskLine reports whether line is a task-list item and returns its
// checkbox state and the text following the checkbox.
func (h *TaskHandler) HandleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.aggregate(w, r)
	case http.MethodPost:
		h.create(w, r)
	case http.MethodPatch:
		h.mutate(w, r)
	case http.MethodDelete:
		h.remove(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// remove deletes a task (its checkbox line and detail block) from a note. The
// target is pinned by Line + Raw so a stale client can't delete the wrong task.
func (h *TaskHandler) remove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	relPath, ok := SafeRelPath(r.URL.Query().Get("path"))
	if !ok {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	var body struct {
		Line int    `json:"line"`
		Raw  string `json:"raw"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}
	data, err := h.store.ReadFile(ctx, ns, relPath)
	if err != nil {
		http.Error(w, `{"error":"note not found"}`, http.StatusNotFound)
		return
	}
	lines := strings.Split(string(data), "\n")
	if body.Line < 1 || body.Line > len(lines) || lines[body.Line-1] != body.Raw {
		http.Error(w, `{"error":"task line is stale; refresh"}`, http.StatusConflict)
		return
	}
	if taskLineRe.FindStringSubmatch(lines[body.Line-1]) == nil {
		http.Error(w, `{"error":"not a task"}`, http.StatusBadRequest)
		return
	}
	_, end := detailBlockRange(lines, body.Line-1)
	lines = append(lines[:body.Line-1], lines[end:]...)
	newData := []byte(strings.Join(lines, "\n"))
	if err := h.store.WriteFile(ctx, ns, relPath, newData); err != nil {
		http.Error(w, `{"error":"failed to write note"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// create appends a new task line to a note (the request's note, else the board's
// DefaultNote), optionally placing it in a column, and returns the created task.
func (h *TaskHandler) create(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	var req struct {
		Note string `json:"note"`
		taskSpec
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		http.Error(w, `{"error":"task title is required"}`, http.StatusBadRequest)
		return
	}
	board := h.loadBoard(ctx, ns)
	note := strings.TrimSpace(req.Note)
	if note == "" {
		note = strings.TrimSpace(board.DefaultNote)
	}
	if note == "" {
		http.Error(w, `{"error":"no target note: pass note or set a default in board settings"}`, http.StatusBadRequest)
		return
	}
	relPath, ok := SafeRelPath(note)
	if !ok {
		http.Error(w, `{"error":"invalid note path"}`, http.StatusBadRequest)
		return
	}
	// The route middleware authorized the query path, but the note target comes
	// from the body — re-check write access on the actual note we're about to
	// touch so a partial-write grant can't be aimed at another note.
	if h.canWrite == nil || !h.canWrite(r, ns, relPath) {
		http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
		return
	}
	// Append the rendered task, creating the note if it does not exist yet.
	data, _ := h.store.ReadFile(ctx, ns, relPath)
	var lines []string
	if len(strings.TrimRight(string(data), "\n")) > 0 {
		lines = strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	}
	cardIdx := len(lines)
	// New tasks get a stable human ref (namespace acronym + unique suffix).
	if strings.TrimSpace(req.taskSpec.Ref) == "" {
		req.taskSpec.Ref = generateTaskRef(ns, collectNoteRefs(lines))
	}
	lines = append(lines, renderTaskBlock(board, req.taskSpec)...)
	newData := []byte(strings.Join(lines, "\n") + "\n")
	if err := h.store.WriteFile(ctx, ns, relPath, newData); err != nil {
		http.Error(w, `{"error":"failed to write note"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	for _, tk := range parseNoteTasks(relPath, newData, board) {
		if tk.Line == cardIdx+1 {
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(tk)
			return
		}
	}
	w.WriteHeader(http.StatusCreated)
}

func (h *TaskHandler) aggregate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	board := h.loadBoard(ctx, ns)

	var files []string
	if p := strings.TrimSpace(r.URL.Query().Get("path")); p != "" {
		// Scope to a single note (the "this note" board view).
		if rel, ok := SafeRelPath(p); ok {
			files = []string{rel}
		}
	} else {
		files = h.namespaceMdFiles(ctx, ns)
	}

	tasks := h.collectTasks(ctx, ns, files, board)
	sort.SliceStable(tasks, func(i, j int) bool {
		if tasks[i].Path != tasks[j].Path {
			return tasks[i].Path < tasks[j].Path
		}
		return tasks[i].Line < tasks[j].Line
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TasksResponse{Board: board, Tasks: tasks})
}

// namespaceMdFiles lists every .md file in a namespace (skipping dot-dirs).
func (h *TaskHandler) namespaceMdFiles(ctx context.Context, ns string) []string {
	var files []string
	h.store.Walk(ctx, ns, "", func(relPath string, info storage.FileInfo) error {
		if info.IsDir {
			if relPath != "" && strings.HasPrefix(info.Name, ".") {
				return storage.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(strings.ToLower(info.Name), ".md") {
			files = append(files, relPath)
		}
		return nil
	})
	return files
}

// collectTasks reads and parses the given files of a namespace in parallel,
// stamping each task with its owning namespace.
func (h *TaskHandler) collectTasks(ctx context.Context, ns string, files []string, board BoardConfig) []Task {
	var (
		mu    sync.Mutex
		tasks []Task
		wg    sync.WaitGroup
		sem   = make(chan struct{}, 8)
	)
	for _, f := range files {
		wg.Add(1)
		sem <- struct{}{}
		go func(fp string) {
			defer wg.Done()
			defer func() { <-sem }()

			data, err := h.store.ReadFile(ctx, ns, fp)
			if err != nil {
				return
			}
			local := parseNoteTasks(fp, data, board)
			for i := range local {
				local[i].Namespace = ns
			}
			if len(local) > 0 {
				mu.Lock()
				tasks = append(tasks, local...)
				mu.Unlock()
			}
		}(f)
	}
	wg.Wait()
	return tasks
}

// HandleGlobalTasks aggregates tasks across every namespace the caller can read
// (GET /api/tasks/all). It self-enforces access via the namespace filter, so it
// is not wrapped in RequireNsAccess (which is single-namespace). The response
// board is the union of the per-namespace column layouts.
func (h *TaskHandler) HandleGlobalTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	ctx := r.Context()
	names, err := h.store.ListNamespaces(ctx)
	if err != nil {
		http.Error(w, `{"error":"failed to read namespaces"}`, http.StatusInternalServerError)
		return
	}
	// Access to the global view is controlled entirely by nsFilter, so fail
	// closed: a nil filter serves nothing instead of leaking every namespace.
	// Normal wiring always supplies one (see NewTaskHandler).
	if h.nsFilter == nil {
		names = nil
	} else {
		names = h.nsFilter(r, names)
	}

	var (
		mu       sync.Mutex
		allTasks []Task
		boards   []BoardConfig
		wg       sync.WaitGroup
		sem      = make(chan struct{}, 4)
	)
	for _, ns := range names {
		wg.Add(1)
		sem <- struct{}{}
		go func(ns string) {
			defer wg.Done()
			defer func() { <-sem }()
			board := h.loadBoard(ctx, ns)
			ts := h.collectTasks(ctx, ns, h.namespaceMdFiles(ctx, ns), board)
			mu.Lock()
			allTasks = append(allTasks, ts...)
			boards = append(boards, board)
			mu.Unlock()
		}(ns)
	}
	wg.Wait()

	sort.SliceStable(allTasks, func(i, j int) bool {
		if allTasks[i].Namespace != allTasks[j].Namespace {
			return allTasks[i].Namespace < allTasks[j].Namespace
		}
		if allTasks[i].Path != allTasks[j].Path {
			return allTasks[i].Path < allTasks[j].Path
		}
		return allTasks[i].Line < allTasks[j].Line
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(TasksResponse{Board: unionBoards(boards), Tasks: allTasks})
}

// unionBoards merges per-namespace column layouts into one: the default columns
// first, then any extra columns (by id) contributed by a namespace's board.
func unionBoards(boards []BoardConfig) BoardConfig {
	out := defaultBoard()
	seen := map[string]bool{}
	for _, c := range out.Columns {
		seen[c.ID] = true
	}
	for _, b := range boards {
		for _, c := range b.Columns {
			if !seen[c.ID] {
				out.Columns = append(out.Columns, c)
				seen[c.ID] = true
			}
		}
	}
	return out
}

func (h *TaskHandler) mutate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	relPath, ok := SafeRelPath(r.URL.Query().Get("path"))
	if !ok {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	var mut taskMutation
	if err := json.NewDecoder(r.Body).Decode(&mut); err != nil {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}
	if mut.ToColumn == "" && mut.Checked == nil && mut.SetField == nil && mut.Text == nil && mut.Replace == nil {
		http.Error(w, `{"error":"toColumn, checked, text, setField or replace is required"}`, http.StatusBadRequest)
		return
	}

	data, err := h.store.ReadFile(ctx, ns, relPath)
	if err != nil {
		http.Error(w, `{"error":"note not found"}`, http.StatusNotFound)
		return
	}
	lines := strings.Split(string(data), "\n")
	if mut.Line < 1 || mut.Line > len(lines) || lines[mut.Line-1] != mut.Raw {
		// The note changed under us; the client must refetch.
		http.Error(w, `{"error":"task line is stale; refresh"}`, http.StatusConflict)
		return
	}

	board := h.loadBoard(ctx, ns)
	// Block closing a task while it still has unresolved sub-tasks. Closing is
	// checking it done, moving it to a Done column (drag), or saving an edit
	// into a Done column. An editor save carries its own (possibly changed)
	// step set, so it is checked against the incoming spec rather than the note.
	isDoneCol := func(id string) bool {
		for _, c := range board.Columns {
			if c.ID == id && c.Done {
				return true
			}
		}
		return false
	}
	blocked := false
	if mut.Replace != nil {
		if isDoneCol(mut.Replace.Column) {
			for _, st := range mut.Replace.Steps {
				if !st.Checked {
					blocked = true
					break
				}
			}
		}
	} else {
		closing := (mut.Checked != nil && *mut.Checked) || (mut.ToColumn != "" && isDoneCol(mut.ToColumn))
		blocked = closing && hasUnresolvedSteps(lines, mut.Line-1)
	}
	if blocked {
		http.Error(w, `{"error":"resolve all sub-tasks before closing this task"}`, http.StatusUnprocessableEntity)
		return
	}
	if mut.Replace != nil {
		// Preserve the task's stable ref across an edit, backfilling one for
		// tasks created before refs existed.
		if strings.TrimSpace(mut.Replace.Ref) == "" {
			if ex := cardRef(lines, mut.Line-1); ex != "" {
				mut.Replace.Ref = ex
			} else {
				mut.Replace.Ref = generateTaskRef(ns, collectNoteRefs(lines))
			}
		}
		var ok2 bool
		lines, ok2 = replaceTaskBlock(lines, mut.Line-1, board, *mut.Replace)
		if !ok2 {
			http.Error(w, `{"error":"not a task"}`, http.StatusBadRequest)
			return
		}
	} else if mut.ToColumn != "" {
		var ok2 bool
		lines, ok2 = applyColumnRich(lines, mut.Line-1, board, mut.ToColumn)
		if !ok2 {
			http.Error(w, `{"error":"unknown column or not a task"}`, http.StatusBadRequest)
			return
		}
	} else if mut.SetField != nil {
		var ok2 bool
		lines, ok2 = applyField(lines, mut.Line-1, mut.SetField.Key, mut.SetField.Value)
		if !ok2 {
			http.Error(w, `{"error":"not a task or field not editable"}`, http.StatusBadRequest)
			return
		}
	} else if mut.Text != nil {
		newLine, ok2 := applyText(lines[mut.Line-1], *mut.Text)
		if !ok2 {
			http.Error(w, `{"error":"not a task"}`, http.StatusBadRequest)
			return
		}
		lines[mut.Line-1] = newLine
	} else {
		newLine, ok2 := setChecked(lines[mut.Line-1], *mut.Checked)
		if !ok2 {
			http.Error(w, `{"error":"not a task"}`, http.StatusBadRequest)
			return
		}
		lines[mut.Line-1] = newLine
	}
	newData := []byte(strings.Join(lines, "\n"))
	if err := h.store.WriteFile(ctx, ns, relPath, newData); err != nil {
		http.Error(w, `{"error":"failed to write note"}`, http.StatusInternalServerError)
		return
	}

	// Return the updated card (rich) when the mutated line is a top-level task;
	// for a step toggle, return the updated line so the client can reconcile.
	w.Header().Set("Content-Type", "application/json")
	for _, tk := range parseNoteTasks(relPath, newData, board) {
		if tk.Line == mut.Line {
			json.NewEncoder(w).Encode(tk)
			return
		}
	}
	checked, rest, _ := parseTaskLine(lines[mut.Line-1])
	json.NewEncoder(w).Encode(map[string]any{
		"path":    relPath,
		"line":    mut.Line,
		"raw":     lines[mut.Line-1],
		"checked": checked,
		"text":    strings.TrimSpace(stripStatusTags(board, rest)),
		"step":    true,
	})
}

// HandleBoard serves GET (column layout) and PUT (replace column layout).
func (h *TaskHandler) HandleBoard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(h.loadBoard(ctx, ns))
	case http.MethodPut:
		var b BoardConfig
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
			return
		}
		if !validBoard(b) {
			http.Error(w, `{"error":"board must have columns with unique non-empty ids"}`, http.StatusBadRequest)
			return
		}
		if b.Version == 0 {
			b.Version = 1
		}
		if err := h.saveBoard(ctx, ns, b); err != nil {
			http.Error(w, `{"error":"failed to save board"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(b)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func validBoard(b BoardConfig) bool {
	if len(b.Columns) == 0 {
		return false
	}
	seen := make(map[string]bool, len(b.Columns))
	for _, c := range b.Columns {
		if c.ID == "" || c.Title == "" || seen[c.ID] {
			return false
		}
		seen[c.ID] = true
	}
	return true
}
