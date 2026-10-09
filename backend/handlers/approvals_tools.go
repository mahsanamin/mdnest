package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// The per-tool half of agent approvals: what a card shows for each tool, the
// answers to an AskUserQuestion, and "allow for this session". Pure functions
// over the hook input, which has already been through strictObject.
//
// Formats verified on 2026-10-09 against an interactive Claude Code 2.1.295
// session (driven through a pty):
//   - A person who ticks Red and Blue and types "Purple" in "Type something"
//     on a multiSelect question produces "Red, Blue, Purple": the ticked
//     labels in option order, joined with ", ", the typed text last. On a
//     single-select question the answer is the label, or the typed text
//     alone. Claude Code also adds "annotations": {} to the tool input.
//   - A hook that answers allow with updatedInput = tool_input plus
//     "answers" is passed to the agent word for word.
//   - Returning permission_suggestions as decision.updatedPermissions, with
//     destination "session", stops the SAME command asking again in that
//     session (an addRules suggestion is the exact command). Nothing is
//     written to the agent's settings files.

const (
	approvalMaxQuestions = 8
	approvalMaxOptions   = 12
	approvalMaxOther     = 500 // characters of a typed answer
	questionTool         = "AskUserQuestion"
)

// ApprovalOption and ApprovalQuestion are an AskUserQuestion as the card
// shows it. Text is passed through visibleText.
type ApprovalOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type ApprovalQuestion struct {
	Question    string           `json:"question"`
	Header      string           `json:"header,omitempty"`
	Options     []ApprovalOption `json:"options"`
	MultiSelect bool             `json:"multiSelect"`
}

// rawQuestion keeps the agent's own text, which is what goes back to it.
type rawQuestion struct {
	question string
	labels   []string
	multi    bool
}

// QuestionAnswer is one answer from the card: option indexes and an
// optional typed answer ("Other").
type QuestionAnswer struct {
	Selected []int  `json:"selected"`
	Other    string `json:"other"`
}

// ApprovalDetails is a readable form of a known tool's input. The card shows
// it instead of the raw JSON; Command still holds the full value.
type ApprovalDetails struct {
	Kind       string `json:"kind"` // "write" or "edit"
	Path       string `json:"path"`
	Content    string `json:"content,omitempty"`
	OldString  string `json:"oldString,omitempty"`
	NewString  string `json:"newString,omitempty"`
	ReplaceAll bool   `json:"replaceAll,omitempty"`
}

// parseQuestions reads AskUserQuestion's tool_input, strictly.
func parseQuestions(toolInput json.RawMessage) ([]ApprovalQuestion, []rawQuestion, error) {
	fields, err := strictObject(toolInput)
	if err != nil {
		return nil, nil, err
	}
	var items []json.RawMessage
	if err := json.Unmarshal(fields["questions"], &items); err != nil || len(items) == 0 {
		return nil, nil, errors.New("questions must be a non-empty list")
	}
	if len(items) > approvalMaxQuestions {
		return nil, nil, errors.New("too many questions")
	}
	view := make([]ApprovalQuestion, 0, len(items))
	raw := make([]rawQuestion, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		q, err := strictObject(item)
		if err != nil {
			return nil, nil, errors.New("question: " + err.Error())
		}
		text := jsonString(q["question"])
		if strings.TrimSpace(text) == "" || seen[text] {
			return nil, nil, errors.New("each question needs its own text")
		}
		seen[text] = true
		var multi bool
		if m, ok := q["multiSelect"]; ok {
			if err := json.Unmarshal(m, &multi); err != nil {
				return nil, nil, errors.New("multiSelect must be true or false")
			}
		}
		var opts []json.RawMessage
		if err := json.Unmarshal(q["options"], &opts); err != nil || len(opts) == 0 || len(opts) > approvalMaxOptions {
			return nil, nil, errors.New("each question needs between 1 and 12 options")
		}
		vq := ApprovalQuestion{Question: visibleText(text), Header: visibleText(jsonString(q["header"])), MultiSelect: multi}
		rq := rawQuestion{question: text, multi: multi}
		for _, o := range opts {
			of, err := strictObject(o)
			if err != nil {
				return nil, nil, errors.New("option: " + err.Error())
			}
			label := jsonString(of["label"])
			if strings.TrimSpace(label) == "" {
				return nil, nil, errors.New("every option needs a label")
			}
			vq.Options = append(vq.Options, ApprovalOption{Label: visibleText(label), Description: visibleText(jsonString(of["description"]))})
			rq.labels = append(rq.labels, label)
		}
		view = append(view, vq)
		raw = append(raw, rq)
	}
	return view, raw, nil
}

// answerText builds the answer the agent receives, in the same form Claude
// Code produces when a person answers in the terminal.
func answerText(q rawQuestion, a QuestionAnswer) (string, error) {
	other := strings.TrimSpace(a.Other)
	if len([]rune(other)) > approvalMaxOther {
		return "", errors.New("a typed answer is limited to 500 characters")
	}
	picked := map[int]bool{}
	for _, i := range a.Selected {
		if i < 0 || i >= len(q.labels) {
			return "", errors.New("an answer names an option that does not exist")
		}
		picked[i] = true
	}
	var parts []string
	for i, l := range q.labels { // option order, as the terminal does
		if picked[i] {
			parts = append(parts, l)
		}
	}
	if !q.multi && len(parts)+boolInt(other != "") > 1 {
		return "", errors.New("this question takes one answer")
	}
	if other != "" {
		parts = append(parts, other)
	}
	if len(parts) == 0 {
		return "", errors.New("every question needs an answer")
	}
	return strings.Join(parts, ", "), nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// withAnswers returns tool_input with "answers" set (and "annotations", as
// the terminal adds it), for decision.updatedInput.
func withAnswers(toolInput json.RawMessage, raw []rawQuestion, answers []QuestionAnswer) (json.RawMessage, error) {
	if len(answers) != len(raw) {
		return nil, errors.New("answer every question")
	}
	out := map[string]string{}
	for i, q := range raw {
		text, err := answerText(q, answers[i])
		if err != nil {
			return nil, errors.New(visibleText(q.question) + ": " + err.Error())
		}
		out[q.question] = text
	}
	fields, err := strictObject(toolInput)
	if err != nil {
		return nil, err
	}
	merged := map[string]any{}
	for k, v := range fields {
		merged[k] = v
	}
	merged["answers"] = out
	if _, ok := merged["annotations"]; !ok {
		merged["annotations"] = map[string]any{}
	}
	b, err := json.Marshal(merged)
	return b, err
}

// sessionPermissions turns permission_suggestions into the updatedPermissions
// of an "allow for this session" answer: only the two kinds that were tested
// (addRules, addDirectories), each forced to destination "session" so nothing
// is written to the agent's settings files. scope says, in words, what the
// person allows.
func sessionPermissions(raw json.RawMessage) (perms []map[string]json.RawMessage, scope []string) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil, nil
	}
	session, _ := json.Marshal("session")
	for _, item := range items {
		f, err := strictObject(item)
		if err != nil {
			continue
		}
		switch jsonString(f["type"]) {
		case "addRules":
			var rules []json.RawMessage
			if json.Unmarshal(f["rules"], &rules) != nil || len(rules) == 0 || jsonString(f["behavior"]) != "allow" {
				continue
			}
			ok := true
			var words []string
			for _, r := range rules {
				rf, err := strictObject(r)
				if err != nil || jsonString(rf["toolName"]) == "" {
					ok = false
					break
				}
				w := jsonString(rf["toolName"])
				if c := jsonString(rf["ruleContent"]); c != "" {
					w += "(" + c + ")"
				}
				words = append(words, visibleText(w))
			}
			if !ok {
				continue
			}
			scope = append(scope, words...)
		case "addDirectories":
			var dirs []string
			if json.Unmarshal(f["directories"], &dirs) != nil || len(dirs) == 0 {
				continue
			}
			for _, d := range dirs {
				scope = append(scope, "the folder "+visibleText(d))
			}
		default:
			continue
		}
		f["destination"] = session
		perms = append(perms, f)
	}
	return perms, scope
}

// displayCommand is what the person approves and what `close` compares: the
// Bash command; for a question, the question text (so the PostToolUse input,
// which carries the answers too, still matches); else tool_input as JSON.
func displayCommand(toolName string, toolInput json.RawMessage) (command, description string) {
	if toolName == questionTool {
		if qs, _, err := parseQuestions(toolInput); err == nil {
			var lines []string
			for _, q := range qs {
				lines = append(lines, q.Question)
			}
			return strings.Join(lines, "\n"), ""
		}
	}
	command, description = commandOf(toolInput)
	return visibleText(command), visibleText(description)
}

// toolDetails gives Write and Edit a readable form. Other tools keep the
// indented JSON in Command.
func toolDetails(toolName string, toolInput json.RawMessage) *ApprovalDetails {
	f, err := strictObject(toolInput)
	if err != nil {
		return nil
	}
	path := jsonString(f["file_path"])
	if path == "" {
		return nil
	}
	switch toolName {
	case "Write":
		return &ApprovalDetails{Kind: "write", Path: visibleText(path), Content: visibleText(jsonString(f["content"]))}
	case "Edit":
		var all bool
		json.Unmarshal(f["replace_all"], &all)
		return &ApprovalDetails{Kind: "edit", Path: visibleText(path),
			OldString: visibleText(jsonString(f["old_string"])), NewString: visibleText(jsonString(f["new_string"])), ReplaceAll: all}
	}
	return nil
}
