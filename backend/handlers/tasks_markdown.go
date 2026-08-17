package handlers

import (
	"crypto/sha1"
	"encoding/hex"
	"math/rand/v2"
	"regexp"
	"strings"
	"unicode"
)

// This file holds the pure markdown helpers for the task board: parsing task
// lines and their detail blocks, deriving columns, generating stable task refs,
// and rendering a task spec back to markdown. The HTTP handlers live in
// tasks.go; the notes remain the single source of truth.

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

// refSegRe splits a namespace into alphanumeric segments for the acronym.
var refSegRe = regexp.MustCompile(`[^A-Za-z0-9]+`)

// namespaceAcronym derives a short uppercase code from a namespace name: the
// initial of each alphanumeric segment (e.g. "mon-workspace-client" -> "MWC",
// "olivier.gintrand@forterro.com" -> "OGFC", capped at 4). A single-segment
// name falls back to its first three letters ("brain" -> "BRA").
func namespaceAcronym(ns string) string {
	segs := refSegRe.Split(ns, -1)
	var initials []rune
	var first string
	for _, s := range segs {
		if s == "" {
			continue
		}
		if first == "" {
			first = s
		}
		initials = append(initials, unicode.ToUpper([]rune(s)[0]))
	}
	switch {
	case len(initials) >= 2:
		if len(initials) > 4 {
			initials = initials[:4]
		}
		return string(initials)
	case len(initials) == 1:
		r := []rune(strings.ToUpper(first))
		if len(r) > 3 {
			r = r[:3]
		}
		return string(r)
	default:
		return "TSK"
	}
}

// refSuffix returns an n-char lowercase base36 random string.
func refSuffix(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = alphabet[rand.IntN(len(alphabet))]
	}
	return string(b)
}

// generateTaskRef builds a stable human id "<ACRONYM>-<suffix>" unique against
// the supplied set of already-used refs (best-effort: the caller passes the
// refs in the target note; the random suffix keeps it practically unique
// beyond that).
func generateTaskRef(ns string, taken map[string]bool) string {
	prefix := namespaceAcronym(ns)
	for i := 0; i < 20; i++ {
		id := prefix + "-" + refSuffix(5)
		if !taken[id] {
			return id
		}
	}
	return prefix + "-" + refSuffix(8)
}

// collectNoteRefs gathers the "- ref:" values already present in a note's lines,
// so a freshly generated ref doesn't collide within the same note.
func collectNoteRefs(lines []string) map[string]bool {
	refs := map[string]bool{}
	for _, l := range lines {
		if m := metaLineRe.FindStringSubmatch(l); m != nil && strings.EqualFold(m[1], "ref") {
			if v := strings.TrimSpace(m[2]); v != "" {
				refs[v] = true
			}
		}
	}
	return refs
}

// cardRef returns the "- ref:" value in a task's detail block, or "".
func cardRef(lines []string, cardIdx int) string {
	start, end := detailBlockRange(lines, cardIdx)
	for j := start; j < end; j++ {
		if m := metaLineRe.FindStringSubmatch(lines[j]); m != nil && strings.EqualFold(m[1], "ref") {
			return strings.TrimSpace(m[2])
		}
	}
	return ""
}

// --- rich task parsing ------------------------------------------------------
//
// A task can carry an indented "detail block" directly under its checkbox line:
// metadata bullets ("- due: ...", "- status: ...", "- tags: [a, b]"), nested
// step checkboxes, and a description (a "notes: |" block scalar or a fenced code
// block). The markdown stays the source of truth and renders natively.

var (
	fenceRe    = regexp.MustCompile("^([`~]{3,})")
	metaLineRe = regexp.MustCompile(`^\s*[-*+]\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s?(.*)$`)
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
// writes when tags are typed there, and honors double-quoted segments so a
// value containing a comma (e.g. a task title referenced by a relation) is kept
// whole instead of being split into several.
func parseTagsList(val string) []string {
	val = strings.TrimSpace(val)
	val = strings.ReplaceAll(val, "\\[", "[")
	val = strings.ReplaceAll(val, "\\]", "]")
	val = strings.TrimPrefix(val, "[")
	val = strings.TrimSuffix(val, "]")
	return splitList(val)
}

// splitList splits a comma-separated list, keeping double-quoted segments intact
// (so a value with a comma survives) and unescaping \" inside quotes.
func splitList(s string) []string {
	var out []string
	var buf strings.Builder
	inQuote, escaped := false, false
	flush := func() {
		v := strings.TrimSpace(buf.String())
		v = strings.TrimSpace(strings.Trim(v, "[]"))
		if v != "" {
			out = append(out, v)
		}
		buf.Reset()
	}
	for _, r := range s {
		switch {
		case escaped:
			buf.WriteRune(r)
			escaped = false
		case inQuote && r == '\\':
			escaped = true
		case r == '"':
			inQuote = !inQuote
		case r == ',' && !inQuote:
			flush()
		default:
			buf.WriteRune(r)
		}
	}
	flush()
	return out
}

// quoteListValue wraps a value in double quotes when it contains a comma or a
// quote, so a comma inside (e.g. a task title) can't be read as a separator.
func quoteListValue(v string) string {
	if strings.ContainsAny(v, ",\"") {
		return `"` + strings.ReplaceAll(v, `"`, `\"`) + `"`
	}
	return v
}

// joinListValues renders values as a comma-separated list, quoting as needed.
func joinListValues(vals []string) string {
	parts := make([]string, 0, len(vals))
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			parts = append(parts, quoteListValue(v))
		}
	}
	return strings.Join(parts, ", ")
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

// hasUnresolvedSteps reports whether the task at cardIdx has at least one
// unchecked nested step in its detail block. Used to block closing a task while
// its sub-tasks are still open.
func hasUnresolvedSteps(lines []string, cardIdx int) bool {
	start, end := detailBlockRange(lines, cardIdx)
	for j := start; j < end; j++ {
		if checked, _, ok := parseTaskLine(lines[j]); ok && !checked {
			return true
		}
	}
	return false
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
		case "ref":
			t.Ref = val
		case "tags":
			t.Tags = parseTagsList(val)
		case "depends-on":
			t.DependsOn = parseTagsList(val)
		case "blocked-by":
			t.BlockedBy = parseTagsList(val)
		case "related-to":
			t.RelatedTo = parseTagsList(val)
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
	case "due", "priority", "workload", "assignee", "tags", "status", "depends-on", "blocked-by", "related-to":
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
	add("ref", s.Ref)
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
		lines = append(lines, "  - tags: ["+joinListValues(tags)+"]")
	}
	addList := func(k string, vals []string) {
		if joined := joinListValues(vals); joined != "" {
			lines = append(lines, "  - "+k+": ["+joined+"]")
		}
	}
	addList("depends-on", s.DependsOn)
	addList("blocked-by", s.BlockedBy)
	addList("related-to", s.RelatedTo)
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
