package handlers

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
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
	// read. Set in multi mode (perms.FilterNamespaces); nil in single mode,
	// where every namespace is accessible. Used by the global (cross-namespace)
	// task view to enforce access.
	nsFilter func(r *http.Request, namespaces []string) []string
}

// NewTaskHandler creates a task/board handler backed by the given storage.
func NewTaskHandler(store storage.Storage) *TaskHandler {
	return &TaskHandler{store: store}
}

// SetNamespaceFilter installs the per-request namespace access filter used by
// the global task view. Multi mode only; single mode leaves it nil (all
// namespaces are the caller's).
func (h *TaskHandler) SetNamespaceFilter(f func(r *http.Request, namespaces []string) []string) {
	h.nsFilter = f
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
	Column          string     `json:"column"`
	Due             string     `json:"due"`
	Priority        string     `json:"priority"`
	Workload        string     `json:"workload"`
	Assignee        string     `json:"assignee"`
	Tags            []string   `json:"tags"`
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
func parseTaskLine(line string) (checked bool, rest string, ok bool) {
	m := taskLineRe.FindStringSubmatch(line)
	if m == nil {
		return false, "", false
	}
	return m[3] == "x" || m[3] == "X", m[4], true
}

// hasStatusTag reports whether rest carries the "#tag" status marker as a
// standalone token (so it will not match arbitrary "#hashtags" in prose).
func hasStatusTag(rest, tag string) bool {
	if tag == "" {
		return false
	}
	re := regexp.MustCompile(`(?i)(^|\s)#` + regexp.QuoteMeta(tag) + `(\s|$)`)
	return re.MatchString(rest)
}

// stripStatusTags removes every "#tag" token whose tag matches a board column,
// leaving unrelated hashtags untouched.
func stripStatusTags(b BoardConfig, rest string) string {
	out := rest
	for _, c := range b.Columns {
		if c.Tag == "" {
			continue
		}
		re := regexp.MustCompile(`(?i)\s*#` + regexp.QuoteMeta(c.Tag) + `(\s|$)`)
		out = re.ReplaceAllString(out, "$1")
	}
	return strings.TrimSpace(out)
}

// columnFor resolves a task's board column from its checkbox state, an explicit
// status field, and (legacy) an inline "#tag" in its title. Precedence: a
// checked box is always the Done column; otherwise the status field, then an
// inline tag, then the first non-done column.
func columnFor(b BoardConfig, checked bool, status, titleRest string) string {
	if checked {
		for _, c := range b.Columns {
			if c.Done {
				return c.ID
			}
		}
		if n := len(b.Columns); n > 0 {
			return b.Columns[n-1].ID
		}
		return ""
	}
	if status != "" {
		for _, c := range b.Columns {
			if !c.Done && strings.EqualFold(c.statusValue(), status) {
				return c.ID
			}
		}
	}
	for _, c := range b.Columns {
		if !c.Done && hasStatusTag(titleRest, c.Tag) {
			return c.ID
		}
	}
	for _, c := range b.Columns {
		if !c.Done {
			return c.ID
		}
	}
	if len(b.Columns) > 0 {
		return b.Columns[0].ID
	}
	return ""
}

// resolveColumn maps a task's checkbox + inline status tag to a board column id.
func resolveColumn(b BoardConfig, checked bool, rest string) string {
	return columnFor(b, checked, "", rest)
}

func taskID(relPath, text string) string {
	sum := sha1.Sum([]byte(relPath + "\x00" + text))
	return hex.EncodeToString(sum[:])[:12]
}

// --- rich task parsing ------------------------------------------------------
//
// A task can carry an indented "detail block" directly under its checkbox line:
// metadata bullets ("- due: ...", "- status: ...", "- tags: [a, b]"), nested
// step checkboxes, and a description (a "notes: |" block scalar or a fenced code
// block). The markdown stays the source of truth and renders natively.

var (
	fenceRe    = regexp.MustCompile("^([`~]{3,})")
	metaLineRe = regexp.MustCompile(`^\s*[-*+]\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s?(.*)$`)
)

// fenceMarker returns the opening fence run ("```" / "~~~...") of a trimmed line,
// or "" when the line does not open a fenced code block.
func fenceMarker(trimmed string) string { return fenceRe.FindString(trimmed) }

// indentWidth returns a line's visual indent, tabs expanded to 4 columns.
func indentWidth(line string) int {
	w := 0
	for _, r := range line {
		switch r {
		case ' ':
			w++
		case '\t':
			w += 4
		default:
			return w
		}
	}
	return w
}

// stripIndent removes up to n columns of leading whitespace from line.
func stripIndent(line string, n int) string {
	i, removed := 0, 0
	for i < len(line) && removed < n {
		switch line[i] {
		case ' ':
			removed++
		case '\t':
			removed += 4
		default:
			return line[i:]
		}
		i++
	}
	return line[i:]
}

// parseTagsList parses `[a, b, c]` (or a bare comma list) into trimmed tags.
// It tolerates markdown-escaped brackets (`\[a, b\]`), which the WYSIWYG editor
// writes when tags are typed there, and strips any stray brackets left on an
// individual tag by malformed input — so a value never surfaces as "\[ui".
func parseTagsList(val string) []string {
	val = strings.TrimSpace(val)
	val = strings.ReplaceAll(val, "\\[", "[")
	val = strings.ReplaceAll(val, "\\]", "]")
	val = strings.TrimPrefix(val, "[")
	val = strings.TrimSuffix(val, "]")
	var out []string
	for _, p := range strings.Split(val, ",") {
		s := strings.TrimSpace(p)
		s = strings.TrimSpace(strings.Trim(s, "[]"))
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// detailBlockRange returns [start,end) line indices of the indented detail block
// under the card at cardIdx: contiguous lines more indented than the card, with
// fenced code blocks kept whole even when their content dedents.
func detailBlockRange(lines []string, cardIdx int) (int, int) {
	cardIndent := indentWidth(lines[cardIdx])
	start := cardIdx + 1
	j := start
	inFence := false
	marker := ""
	for j < len(lines) {
		trimmed := strings.TrimSpace(lines[j])
		if inFence {
			if trimmed == marker {
				inFence = false
			}
			j++
			continue
		}
		if trimmed == "" {
			k := j + 1
			for k < len(lines) && strings.TrimSpace(lines[k]) == "" {
				k++
			}
			if k >= len(lines) || indentWidth(lines[k]) <= cardIndent {
				break
			}
			j++
			continue
		}
		if indentWidth(lines[j]) <= cardIndent {
			break
		}
		if fm := fenceMarker(trimmed); fm != "" {
			inFence, marker = true, fm
		}
		j++
	}
	return start, j
}

// parseNoteTasks aggregates the task-list items of one note. A checkbox that is
// not nested in another task's detail block is a card; any checkbox inside a
// detail block is a step of that card. Fenced code blocks are opaque (their
// "- [ ]" lines are not tasks).
func parseNoteTasks(fp string, data []byte, board BoardConfig) []Task {
	lines := strings.Split(string(data), "\n")
	var tasks []Task
	i := 0
	inFence := false
	marker := ""
	for i < len(lines) {
		trimmed := strings.TrimSpace(lines[i])
		if inFence {
			if trimmed == marker {
				inFence = false
			}
			i++
			continue
		}
		if fm := fenceMarker(trimmed); fm != "" {
			inFence, marker = true, fm
			i++
			continue
		}
		checked, rest, ok := parseTaskLine(lines[i])
		if !ok {
			i++
			continue
		}
		start, end := detailBlockRange(lines, i)
		tasks = append(tasks, parseCard(fp, lines, i, checked, rest, start, end, board))
		i = end
	}
	return tasks
}

// parseCard builds one Task from its checkbox line and its detail block.
func parseCard(fp string, lines []string, cardIdx int, checked bool, rest string, start, end int, board BoardConfig) Task {
	t := Task{Path: fp, Line: cardIdx + 1, Raw: lines[cardIdx], Checked: checked}
	var fenceNotes []string
	inFence := false
	marker := ""
	fenceIndent := 0
	for j := start; j < end; j++ {
		bl := lines[j]
		trimmed := strings.TrimSpace(bl)
		if inFence {
			if trimmed == marker {
				inFence = false
			} else {
				fenceNotes = append(fenceNotes, stripIndent(bl, fenceIndent))
			}
			continue
		}
		if fm := fenceMarker(trimmed); fm != "" {
			inFence, marker, fenceIndent = true, fm, indentWidth(bl)
			continue
		}
		if sc, srest, isTask := parseTaskLine(bl); isTask {
			t.Steps = append(t.Steps, Step{Text: strings.TrimSpace(srest), Checked: sc, Line: j + 1, Raw: bl})
			continue
		}
		m := metaLineRe.FindStringSubmatch(bl)
		if m == nil {
			continue
		}
		key, val := strings.ToLower(m[1]), strings.TrimSpace(m[2])
		switch key {
		case "status":
			t.Status = val
		case "due":
			t.Due = val
		case "priority":
			t.Priority = val
		case "workload":
			t.Workload = val
		case "assignee":
			t.Assignee = val
		case "tags":
			t.Tags = parseTagsList(val)
		case "defaultexpanded":
			t.DefaultExpanded = val == "true" || val == "yes"
		case "notes":
			if val == "|" || val == "" {
				ni := indentWidth(bl)
				var nl []string
				for j+1 < end {
					if strings.TrimSpace(lines[j+1]) == "" {
						nl = append(nl, "")
						j++
						continue
					}
					if indentWidth(lines[j+1]) <= ni {
						break
					}
					nl = append(nl, stripIndent(lines[j+1], ni+2))
					j++
				}
				t.Notes = strings.TrimSpace(strings.Join(nl, "\n"))
			} else {
				t.Notes = val
			}
		}
	}
	if t.Notes == "" && len(fenceNotes) > 0 {
		t.Notes = strings.TrimRight(strings.Join(fenceNotes, "\n"), "\n")
	}
	t.Text = strings.TrimSpace(stripStatusTags(board, rest))
	t.ID = taskID(fp, t.Text)
	t.Column = columnFor(board, checked, t.Status, rest)
	return t
}

// statusFieldLine returns the index of a "- status:" line within [start,end),
// or -1 when the detail block has none.
func statusFieldLine(lines []string, start, end int) int {
	for j := start; j < end; j++ {
		if m := metaLineRe.FindStringSubmatch(lines[j]); m != nil && strings.EqualFold(m[1], "status") {
			return j
		}
	}
	return -1
}

// applyColumnRich moves the card at cardIdx into a column by rewriting its
// checkbox (checked iff the column is Done) and its `status:` field: for a
// non-done column the field is updated or inserted at the top of the detail
// block (materialising one for a simple task); for the Done column a now-stale
// status field is removed. It returns the updated lines and ok=false when the
// line is not a task or the column is unknown.
func applyColumnRich(lines []string, cardIdx int, b BoardConfig, colID string) ([]string, bool) {
	m := taskLineRe.FindStringSubmatch(lines[cardIdx])
	if m == nil {
		return lines, false
	}
	var target *BoardColumn
	for i := range b.Columns {
		if b.Columns[i].ID == colID {
			target = &b.Columns[i]
			break
		}
	}
	if target == nil {
		return lines, false
	}
	indent, bullet, rest := m[1], m[2], m[4]
	box := " "
	if target.Done {
		box = "x"
	}
	lines[cardIdx] = indent + bullet + " [" + box + "] " + stripStatusTags(b, rest)

	start, end := detailBlockRange(lines, cardIdx)
	sl := statusFieldLine(lines, start, end)
	if target.Done {
		if sl >= 0 {
			lines = append(lines[:sl], lines[sl+1:]...)
		}
		return lines, true
	}
	value := target.statusValue()
	if sl >= 0 {
		lead := lines[sl][:len(lines[sl])-len(strings.TrimLeft(lines[sl], " \t"))]
		lines[sl] = lead + "- status: " + value
		return lines, true
	}
	child := strings.Repeat(" ", indentWidth(lines[cardIdx])+2) + "- status: " + value
	at := cardIdx + 1
	lines = append(lines[:at], append([]string{child}, lines[at:]...)...)
	return lines, true
}

// editableField reports whether key is a metadata field the API may set inline.
func editableField(key string) bool {
	switch key {
	case "due", "priority", "workload", "assignee", "tags", "status":
		return true
	}
	return false
}

// applyField sets, updates or removes a "- key: value" metadata bullet in the
// card's detail block (an empty value removes it, materialising or pruning the
// block as needed). Only whitelisted fields are editable. Returns ok=false when
// the line is not a task or the field is not editable.
func applyField(lines []string, cardIdx int, key, value string) ([]string, bool) {
	if taskLineRe.FindStringSubmatch(lines[cardIdx]) == nil {
		return lines, false
	}
	key = strings.ToLower(strings.TrimSpace(key))
	if !editableField(key) {
		return lines, false
	}
	value = strings.TrimSpace(value)
	if key == "tags" && value != "" && !strings.HasPrefix(value, "[") {
		value = "[" + value + "]"
	}
	start, end := detailBlockRange(lines, cardIdx)
	idx := -1
	for j := start; j < end; j++ {
		if m := metaLineRe.FindStringSubmatch(lines[j]); m != nil && strings.EqualFold(m[1], key) {
			idx = j
			break
		}
	}
	if value == "" {
		if idx >= 0 {
			lines = append(lines[:idx], lines[idx+1:]...)
		}
		return lines, true
	}
	if idx >= 0 {
		lead := lines[idx][:len(lines[idx])-len(strings.TrimLeft(lines[idx], " \t"))]
		lines[idx] = lead + "- " + key + ": " + value
		return lines, true
	}
	child := strings.Repeat(" ", indentWidth(lines[cardIdx])+2) + "- " + key + ": " + value
	at := cardIdx + 1
	lines = append(lines[:at], append([]string{child}, lines[at:]...)...)
	return lines, true
}

// applyText rewrites a task or step line's title, preserving its indent, bullet
// and checkbox state. ok=false when the line is not a task.
func applyText(line, text string) (string, bool) {
	m := taskLineRe.FindStringSubmatch(line)
	if m == nil {
		return line, false
	}
	box := " "
	if m[3] == "x" || m[3] == "X" {
		box = "x"
	}
	return m[1] + m[2] + " [" + box + "] " + strings.TrimSpace(text), true
}

// renderTaskBlock renders a task and its detail block as markdown lines (base
// indent 0). The column sets the checkbox (Done -> [x]) and, when not Done, the
// status field; only non-empty fields are emitted.
func renderTaskBlock(b BoardConfig, s taskSpec) []string {
	var col *BoardColumn
	for i := range b.Columns {
		if b.Columns[i].ID == s.Column {
			col = &b.Columns[i]
			break
		}
	}
	box, status := " ", ""
	if col != nil {
		if col.Done {
			box = "x"
		} else {
			status = col.statusValue()
		}
	}
	lines := []string{"- [" + box + "] " + strings.TrimSpace(s.Title)}
	add := func(k, v string) {
		if strings.TrimSpace(v) != "" {
			lines = append(lines, "  - "+k+": "+strings.TrimSpace(v))
		}
	}
	add("status", status)
	add("due", s.Due)
	add("priority", s.Priority)
	add("workload", s.Workload)
	add("assignee", s.Assignee)
	var tags []string
	for _, t := range s.Tags {
		if t = strings.TrimSpace(t); t != "" {
			tags = append(tags, t)
		}
	}
	if len(tags) > 0 {
		lines = append(lines, "  - tags: ["+strings.Join(tags, ", ")+"]")
	}
	if s.DefaultExpanded {
		lines = append(lines, "  - defaultExpanded: true")
	}
	var steps []stepSpec
	for _, st := range s.Steps {
		if strings.TrimSpace(st.Text) != "" {
			steps = append(steps, st)
		}
	}
	if len(steps) > 0 {
		lines = append(lines, "  - steps:")
		for _, st := range steps {
			sb := " "
			if st.Checked {
				sb = "x"
			}
			lines = append(lines, "    - ["+sb+"] "+strings.TrimSpace(st.Text))
		}
	}
	if strings.TrimSpace(s.Notes) != "" {
		lines = append(lines, "  - notes: |")
		for _, nl := range strings.Split(strings.TrimRight(s.Notes, "\n"), "\n") {
			lines = append(lines, "    "+nl)
		}
	}
	return lines
}

// replaceTaskBlock swaps the whole task at cardIdx (checkbox line + detail
// block) for a freshly-rendered block from spec, preserving the card's indent.
func replaceTaskBlock(lines []string, cardIdx int, b BoardConfig, s taskSpec) ([]string, bool) {
	if taskLineRe.FindStringSubmatch(lines[cardIdx]) == nil {
		return lines, false
	}
	_, end := detailBlockRange(lines, cardIdx)
	block := renderTaskBlock(b, s)
	if pad := indentWidth(lines[cardIdx]); pad > 0 {
		prefix := strings.Repeat(" ", pad)
		for i := range block {
			block[i] = prefix + block[i]
		}
	}
	out := append([]string{}, lines[:cardIdx]...)
	out = append(out, block...)
	out = append(out, lines[end:]...)
	return out, true
}

// setChecked flips the checkbox on a task line.
func setChecked(line string, checked bool) (string, bool) {
	m := taskLineRe.FindStringSubmatch(line)
	if m == nil {
		return line, false
	}
	box := " "
	if checked {
		box = "x"
	}
	return m[1] + m[2] + " [" + box + "] " + m[4], true
}

// HandleTasks serves GET (aggregate) and PATCH (mutate a single task).
func (h *TaskHandler) HandleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.aggregate(w, r)
	case http.MethodPost:
		h.create(w, r)
	case http.MethodPatch:
		h.mutate(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
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
	// Append the rendered task, creating the note if it does not exist yet.
	data, _ := h.store.ReadFile(ctx, ns, relPath)
	var lines []string
	if len(strings.TrimRight(string(data), "\n")) > 0 {
		lines = strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	}
	cardIdx := len(lines)
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
	if h.nsFilter != nil {
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
	if mut.Replace != nil {
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
