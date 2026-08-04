package handlers

import (
	"strings"
	"testing"
)

func TestParseTagsList(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"[design, ui]", []string{"design", "ui"}},
		{"a, b, c", []string{"a", "b", "c"}},
		{`\[ui]`, []string{"ui"}}, // markdown-escaped bracket from the editor
		{`\[design, ui\]`, []string{"design", "ui"}},
		{"[[ui, code]]", []string{"ui", "code"}}, // doubled brackets
		{"", nil},
		{"[]", nil},
	}
	for _, c := range cases {
		got := parseTagsList(c.in)
		if len(got) != len(c.want) {
			t.Errorf("parseTagsList(%q) = %v, want %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("parseTagsList(%q) = %v, want %v", c.in, got, c.want)
				break
			}
		}
	}
}

func TestParseTaskLine(t *testing.T) {
	cases := []struct {
		line        string
		wantOK      bool
		wantChecked bool
		wantRest    string
	}{
		{"- [ ] buy milk", true, false, "buy milk"},
		{"- [x] shipped", true, true, "shipped"},
		{"- [X] shipped upper", true, true, "shipped upper"},
		{"  * [ ] nested star", true, false, "nested star"},
		{"\t+ [ ] tabbed plus", true, false, "tabbed plus"},
		{"- [ ]", true, false, ""},
		{"- not a task", false, false, ""},
		{"just text", false, false, ""},
		{"<!-- mdnest:abc -->", false, false, ""},
	}
	for _, c := range cases {
		checked, rest, ok := parseTaskLine(c.line)
		if ok != c.wantOK || checked != c.wantChecked || rest != c.wantRest {
			t.Errorf("parseTaskLine(%q) = (%v,%q,%v), want (%v,%q,%v)",
				c.line, checked, rest, ok, c.wantChecked, c.wantRest, c.wantOK)
		}
	}
}

func TestHasStatusTag(t *testing.T) {
	if !hasStatusTag("do it #doing", "doing") {
		t.Error("expected #doing to be detected")
	}
	if hasStatusTag("code #doingfast", "doing") {
		t.Error("substring should not match a whole-token tag")
	}
	if hasStatusTag("no tag here", "doing") {
		t.Error("unexpected match")
	}
	if !hasStatusTag("#todo first", "todo") {
		t.Error("tag at start of line should match")
	}
}

func TestStripStatusTags(t *testing.T) {
	b := defaultBoard()
	cases := []struct{ in, want string }{
		{"buy milk #doing", "buy milk"},
		{"#todo urgent", "urgent"},
		{"plain #project note", "plain #project note"}, // unrelated hashtag preserved
		{"do #doing and #done", "do and"},
	}
	for _, c := range cases {
		if got := stripStatusTags(b, c.in); got != c.want {
			t.Errorf("stripStatusTags(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestResolveColumn(t *testing.T) {
	b := defaultBoard()
	cases := []struct {
		checked bool
		rest    string
		want    string
	}{
		{false, "no tag", "todo"},        // default first non-done column
		{false, "work #doing", "doing"},  // explicit tag
		{false, "planned #todo", "todo"}, // explicit todo tag
		{true, "anything", "done"},       // checked always maps to done column
		{true, "checked #doing", "done"}, // checked wins over stale tag
	}
	for _, c := range cases {
		if got := resolveColumn(b, c.checked, c.rest); got != c.want {
			t.Errorf("resolveColumn(%v,%q) = %q, want %q", c.checked, c.rest, got, c.want)
		}
	}
}

func TestApplyColumnRich(t *testing.T) {
	b := defaultBoard()

	// Simple task moved to a non-done column: materialise a status field.
	out, ok := applyColumnRich([]string{"- [ ] ship it"}, 0, b, "doing")
	if !ok || len(out) != 2 || out[0] != "- [ ] ship it" || out[1] != "  - status: doing" {
		t.Fatalf("apply doing = %#v ok=%v", out, ok)
	}

	// Moved to the done column: check the box and drop a stale status field.
	out, ok = applyColumnRich([]string{"- [ ] ship it", "  - status: doing"}, 0, b, "done")
	if !ok || len(out) != 1 || out[0] != "- [x] ship it" {
		t.Fatalf("apply done = %#v ok=%v", out, ok)
	}

	// Existing status field is updated in place, keeping the block.
	out, ok = applyColumnRich([]string{"- [ ] task", "  - status: todo"}, 0, b, "doing")
	if !ok || len(out) != 2 || out[1] != "  - status: doing" {
		t.Fatalf("apply update = %#v ok=%v", out, ok)
	}

	// Unknown column and non-task line are rejected.
	if _, ok := applyColumnRich([]string{"- [ ] x"}, 0, b, "missing"); ok {
		t.Error("unknown column should fail")
	}
	if _, ok := applyColumnRich([]string{"plain"}, 0, b, "todo"); ok {
		t.Error("non-task should fail")
	}
}

func TestParseNoteTasks(t *testing.T) {
	b := defaultBoard()
	note := strings.Join([]string{
		"# Notes",
		"- [ ] Design UI",
		"  - status: doing",
		"  - due: 2024-01-15",
		"  - priority: high",
		"  - assignee: alice",
		"  - tags: [design, ui]",
		"  - steps:",
		"    - [x] Wireframes",
		"    - [ ] Visual design",
		"  - notes: |",
		"    Login & registration",
		"    - responsive",
		"- [ ] Simple task",
		"```",
		"- [ ] not a task (fenced)",
		"```",
	}, "\n")
	tasks := parseNoteTasks("plan.md", []byte(note), b)
	if len(tasks) != 2 {
		t.Fatalf("want 2 cards, got %d: %+v", len(tasks), tasks)
	}
	d := tasks[0]
	if d.Text != "Design UI" || d.Status != "doing" || d.Column != "doing" {
		t.Errorf("card0 meta wrong: %+v", d)
	}
	if d.Due != "2024-01-15" || d.Priority != "high" || len(d.Tags) != 2 {
		t.Errorf("card0 fields wrong: %+v", d)
	}
	if d.Assignee != "alice" {
		t.Errorf("card0 assignee wrong: %q", d.Assignee)
	}
	if len(d.Steps) != 2 || !d.Steps[0].Checked || d.Steps[1].Checked {
		t.Errorf("steps wrong: %+v", d.Steps)
	}
	if !strings.Contains(d.Notes, "Login & registration") || !strings.Contains(d.Notes, "- responsive") {
		t.Errorf("notes wrong: %q", d.Notes)
	}
	if tasks[1].Text != "Simple task" || len(tasks[1].Steps) != 0 {
		t.Errorf("card1 wrong: %+v", tasks[1])
	}
}

func TestParseNoteTasksFencedDescription(t *testing.T) {
	b := defaultBoard()
	note := strings.Join([]string{
		"- [ ] With fenced notes",
		"  ```md",
		"  Some description",
		"  - a bullet",
		"  ```",
	}, "\n")
	tasks := parseNoteTasks("n.md", []byte(note), b)
	if len(tasks) != 1 {
		t.Fatalf("want 1 card, got %d", len(tasks))
	}
	if !strings.Contains(tasks[0].Notes, "Some description") || len(tasks[0].Steps) != 0 {
		t.Errorf("fenced notes wrong: notes=%q steps=%+v", tasks[0].Notes, tasks[0].Steps)
	}
}

func TestSetChecked(t *testing.T) {
	got, ok := setChecked("- [ ] task #doing", true)
	if !ok || got != "- [x] task #doing" {
		t.Errorf("setChecked true = (%q,%v)", got, ok)
	}
	got, ok = setChecked("- [x] task", false)
	if !ok || got != "- [ ] task" {
		t.Errorf("setChecked false = (%q,%v)", got, ok)
	}
	if _, ok := setChecked("not a task", true); ok {
		t.Error("expected non-task to fail")
	}
}

func TestApplyField(t *testing.T) {
	// Insert a field on a simple task: materialise a detail block.
	out, ok := applyField([]string{"- [ ] task"}, 0, "priority", "high")
	if !ok || len(out) != 2 || out[1] != "  - priority: high" {
		t.Fatalf("insert = %#v ok=%v", out, ok)
	}

	// Update an existing field in place.
	out, ok = applyField([]string{"- [ ] task", "  - due: 2024-01-01"}, 0, "due", "2024-02-02")
	if !ok || out[1] != "  - due: 2024-02-02" {
		t.Fatalf("update = %#v ok=%v", out, ok)
	}

	// Tags are wrapped in brackets when a bare list is supplied.
	out, ok = applyField([]string{"- [ ] task"}, 0, "tags", "a, b")
	if !ok || out[1] != "  - tags: [a, b]" {
		t.Fatalf("tags = %#v ok=%v", out, ok)
	}

	// An empty value removes the field.
	out, ok = applyField([]string{"- [ ] task", "  - priority: high"}, 0, "priority", "")
	if !ok || len(out) != 1 {
		t.Fatalf("remove = %#v ok=%v", out, ok)
	}

	// Non-editable field and non-task line are rejected.
	if _, ok := applyField([]string{"- [ ] task"}, 0, "evil", "x"); ok {
		t.Error("non-editable field should fail")
	}
	if _, ok := applyField([]string{"plain"}, 0, "due", "x"); ok {
		t.Error("non-task line should fail")
	}
}

func TestApplyText(t *testing.T) {
	got, ok := applyText("- [ ] old title", "new title")
	if !ok || got != "- [ ] new title" {
		t.Fatalf("rename = (%q,%v)", got, ok)
	}
	// Checkbox state and indent/bullet are preserved.
	got, ok = applyText("  * [x] done", "still done")
	if !ok || got != "  * [x] still done" {
		t.Fatalf("preserve = (%q,%v)", got, ok)
	}
	if _, ok := applyText("plain", "x"); ok {
		t.Error("non-task should fail")
	}
}

func TestRenderTaskBlock(t *testing.T) {
	b := defaultBoard()
	s := taskSpec{
		Title: "Design UI", Column: "doing", Due: "2024-01-15",
		Priority: "high", Workload: "hard", Assignee: "alice", Tags: []string{"design", "ui"},
		DefaultExpanded: true,
		Steps:           []stepSpec{{Text: "Wireframes", Checked: true}, {Text: "Visual", Checked: false}},
		Notes:           "line1\nline2",
	}
	got := strings.Join(renderTaskBlock(b, s), "\n")
	want := strings.Join([]string{
		"- [ ] Design UI",
		"  - status: doing",
		"  - due: 2024-01-15",
		"  - priority: high",
		"  - workload: hard",
		"  - assignee: alice",
		"  - tags: [design, ui]",
		"  - defaultExpanded: true",
		"  - steps:",
		"    - [x] Wireframes",
		"    - [ ] Visual",
		"  - notes: |",
		"    line1",
		"    line2",
	}, "\n")
	if got != want {
		t.Fatalf("render mismatch:\n got=%q\nwant=%q", got, want)
	}
	// Round-trip: parse it back.
	tasks := parseNoteTasks("n.md", []byte(got+"\n"), b)
	if len(tasks) != 1 || tasks[0].Status != "doing" || len(tasks[0].Steps) != 2 || tasks[0].Priority != "high" {
		t.Fatalf("round-trip failed: %+v", tasks)
	}
	if tasks[0].Assignee != "alice" {
		t.Fatalf("round-trip assignee lost: %+v", tasks[0])
	}
	// Done column: checkbox, no status.
	if g := strings.Join(renderTaskBlock(b, taskSpec{Title: "x", Column: "done"}), "\n"); g != "- [x] x" {
		t.Fatalf("done render = %q", g)
	}
}

func TestReplaceTaskBlock(t *testing.T) {
	b := defaultBoard()
	lines := []string{
		"# Notes",
		"- [ ] Old",
		"  - status: doing",
		"  - due: 2020-01-01",
		"- [ ] Keep me",
	}
	out, ok := replaceTaskBlock(lines, 1, b, taskSpec{Title: "New", Column: "todo", Priority: "low"})
	if !ok {
		t.Fatal("replace failed")
	}
	joined := strings.Join(out, "\n")
	if !strings.Contains(joined, "- [ ] New") || !strings.Contains(joined, "  - priority: low") {
		t.Fatalf("new block missing: %q", joined)
	}
	if strings.Contains(joined, "2020-01-01") {
		t.Fatalf("old block not removed: %q", joined)
	}
	if !strings.Contains(joined, "- [ ] Keep me") {
		t.Fatalf("following task lost: %q", joined)
	}
}

func TestValidBoard(t *testing.T) {
	if validBoard(BoardConfig{}) {
		t.Error("empty board should be invalid")
	}
	if validBoard(BoardConfig{Columns: []BoardColumn{{ID: "", Title: "x"}}}) {
		t.Error("empty id should be invalid")
	}
	if validBoard(BoardConfig{Columns: []BoardColumn{{ID: "a", Title: "A"}, {ID: "a", Title: "B"}}}) {
		t.Error("duplicate id should be invalid")
	}
	if !validBoard(defaultBoard()) {
		t.Error("default board should be valid")
	}
}

func TestTaskRelations(t *testing.T) {
	b := defaultBoard()
	s := taskSpec{
		Title: "Ship release", Column: "todo",
		DependsOn: []string{"Write changelog", "Cut tag"},
		BlockedBy: []string{"Security review"},
		RelatedTo: []string{"Update docs"},
	}
	got := strings.Join(renderTaskBlock(b, s), "\n")
	for _, want := range []string{
		"  - depends-on: [Write changelog, Cut tag]",
		"  - blocked-by: [Security review]",
		"  - related-to: [Update docs]",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("render missing %q in:\n%s", want, got)
		}
	}
	// Round-trip: hyphenated keys parse back into the relation lists.
	tasks := parseNoteTasks("n.md", []byte(got+"\n"), b)
	if len(tasks) != 1 {
		t.Fatalf("want 1 task, got %d", len(tasks))
	}
	tk := tasks[0]
	if len(tk.DependsOn) != 2 || tk.DependsOn[0] != "Write changelog" || tk.DependsOn[1] != "Cut tag" {
		t.Errorf("dependsOn round-trip wrong: %+v", tk.DependsOn)
	}
	if len(tk.BlockedBy) != 1 || tk.BlockedBy[0] != "Security review" {
		t.Errorf("blockedBy round-trip wrong: %+v", tk.BlockedBy)
	}
	if len(tk.RelatedTo) != 1 || tk.RelatedTo[0] != "Update docs" {
		t.Errorf("relatedTo round-trip wrong: %+v", tk.RelatedTo)
	}
}
