package main

// Agent approvals, second round: answering AskUserQuestion, "allow for this
// session", notices, the agent's chat name, and readable Write/Edit details.
// Through the real route table and auth middleware, like
// routes_approvals_test.go.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const questionInput = `{"session_id":"q-1","cwd":"/w","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[` +
	`{"question":"Which colors do you like?","header":"Colors","options":[{"label":"Red","description":"r"},{"label":"Green","description":"g"},{"label":"Blue","description":"b"}],"multiSelect":true},` +
	`{"question":"Which size?","header":"Size","options":[{"label":"Small","description":"s"},{"label":"Large","description":"l"}],"multiSelect":false}]}}`

func decodeHookOutput(t *testing.T, out string) map[string]any {
	t.Helper()
	var v struct {
		HookSpecificOutput struct {
			Decision map[string]any `json:"decision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("hook output %q: %v", out, err)
	}
	return v.HookSpecificOutput.Decision
}

func TestApprovals_QuestionAnswers(t *testing.T) {
	ts := newTestServer(t, false)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	browser := jwtFor(t, 1, "", nil)
	id := ts.createApproval(t, tok, "", questionInput)

	_, view := ts.get(tok, "/api/approvals/"+id)
	var v struct {
		Questions []struct {
			Question    string
			MultiSelect bool
			Options     []struct{ Label string }
		}
		Command string
	}
	json.Unmarshal([]byte(view), &v)
	if len(v.Questions) != 2 || !v.Questions[0].MultiSelect || v.Questions[1].Options[1].Label != "Large" {
		t.Fatalf("questions not served: %s", view)
	}

	for name, body := range map[string]string{
		"plain allow":                 `{"decision":"allow"}`,
		"allow for the session":       `{"decision":"allow_session"}`,
		"a missing answer":            `{"decision":"answer","answers":[{"selected":[0]}]}`,
		"two picks, single":           `{"decision":"answer","answers":[{"selected":[0]},{"selected":[0,1]}]}`,
		"a pick and typed, single":    `{"decision":"answer","answers":[{"selected":[0]},{"selected":[1],"other":"Medium"}]}`,
		"an option that is not there": `{"decision":"answer","answers":[{"selected":[7]},{"selected":[0]}]}`,
		"nothing picked":              `{"decision":"answer","answers":[{"selected":[]},{"selected":[0]}]}`,
	} {
		if code, out := ts.decide(browser, id, body); code != 400 {
			t.Errorf("%s: %d %s, want 400", name, code, out)
		}
	}
	answer := `{"decision":"answer","answers":[{"selected":[2,0],"other":"Purple"},{"selected":[],"other":"Medium"}]}`
	if code, _ := ts.decide(tok, id, answer); code != 403 {
		t.Fatalf("an API token answered a question: %d", code)
	}
	if code, out := ts.decide(browser, id, answer); code != 200 {
		t.Fatalf("answer: %d %s", code, out)
	}
	_, out := ts.get(tok, "/api/approvals/"+id+"/wait")
	d := decodeHookOutput(t, out)
	if d["behavior"] != "allow" {
		t.Fatalf("behavior: %v", d)
	}
	in, _ := d["updatedInput"].(map[string]any)
	answers, _ := in["answers"].(map[string]any)
	// The same text Claude Code produces when a person answers in the
	// terminal: ticked labels in option order, ", ", the typed text last.
	if answers["Which colors do you like?"] != "Red, Blue, Purple" || answers["Which size?"] != "Medium" {
		t.Fatalf("answers: %v", answers)
	}
	if _, ok := in["annotations"]; !ok || in["questions"] == nil {
		t.Fatalf("updatedInput must keep the questions and add annotations: %v", in)
	}
	_, view = ts.get(tok, "/api/approvals/"+id)
	if !strings.Contains(view, `Which size? Medium`) {
		t.Fatalf("decided card does not show the answer: %s", view)
	}
}

func TestApprovals_QuestionWithDuplicateKeysRefused(t *testing.T) {
	ts := newTestServer(t, false)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	bad := `{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"q","options":[{"label":"a","label":"b"}]}]}}`
	if code, _ := ts.do(tok, "POST", "/api/approvals?cli=4.8.5", strings.NewReader(bad), ""); code != 400 {
		t.Fatalf("duplicate label key: %d, want 400", code)
	}
}

func TestApprovals_AllowForSession(t *testing.T) {
	ts := newTestServer(t, false)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	browser := jwtFor(t, 1, "", nil)
	withRule := `{"session_id":"s","tool_name":"Bash","tool_input":{"command":"python3 -c 'print(7)'"},` +
		`"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"python3 -c 'print(7)'"}],"behavior":"allow","destination":"localSettings"},` +
		`{"type":"setMode","mode":"bypassPermissions","destination":"session"}]}`
	id := ts.createApproval(t, tok, "", withRule)
	_, view := ts.get(tok, "/api/approvals/"+id)
	if !strings.Contains(view, `"sessionScope":["Bash(python3 -c 'print(7)')"]`) {
		t.Fatalf("scope: %s", view)
	}
	if code, out := ts.decide(browser, id, `{"decision":"allow_session"}`); code != 200 {
		t.Fatalf("allow_session: %d %s", code, out)
	}
	_, out := ts.get(tok, "/api/approvals/"+id+"/wait")
	d := decodeHookOutput(t, out)
	perms, _ := d["updatedPermissions"].([]any)
	if len(perms) != 1 {
		t.Fatalf("only the tested kinds may pass (a setMode must not): %v", d)
	}
	p := perms[0].(map[string]any)
	if p["destination"] != "session" || p["type"] != "addRules" {
		t.Fatalf("permission must be forced to this session: %v", p)
	}

	// Nothing offered: the button is refused.
	plain := ts.createApproval(t, tok, "", approvalHookInput)
	if code, _ := ts.decide(browser, plain, `{"decision":"allow_session"}`); code != 400 {
		t.Fatalf("allow_session with no suggestions: %d, want 400", code)
	}
	// Codex was not tested with it, so it is not offered there.
	cx := ts.createApproval(t, tok, "&agent=codex", withRule)
	if _, v := ts.get(tok, "/api/approvals/"+cx); strings.Contains(v, "sessionScope") {
		t.Fatalf("codex request offers allow for the session: %s", v)
	}
}

func TestApprovals_NameAndDetails(t *testing.T) {
	ts := newTestServer(t, true)
	room := filepath.Join(ts.root, "alpha", "Shared", "agents.md")
	os.WriteFile(room, []byte("---\nmdnest-chat: true\ntitle: agents\n---\n"), 0o644)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", uidPat, "pat", "collaborator")
	write := `{"session_id":"w","cwd":"/Users/pat/repo","tool_name":"Write","tool_input":{"file_path":"/Users/pat/repo/a.txt","content":"one\ntwo\n"}}`
	id := ts.createApproval(t, tok, "&as=Builder&machine=mini&chat=alpha/Shared/agents.md", write)
	note := ts.readFile("alpha/Shared/agents.md")
	if !strings.Contains(note, "Builder (via pat)") || !strings.Contains(note, "Builder (Claude Code on mini) is waiting for approval.") {
		t.Fatalf("card not under the agent's chat name:\n%s", note)
	}
	if strings.Contains(note, "a.txt") || strings.Contains(note, "one") {
		t.Fatalf("the chat note carries the tool input:\n%s", note)
	}
	_, view := ts.get(tok, "/api/approvals/"+id)
	var v struct {
		Label   string
		Details struct{ Kind, Path, Content string }
	}
	json.Unmarshal([]byte(view), &v)
	if v.Label != "Builder (Claude Code on mini)" || v.Details.Kind != "write" || v.Details.Path != "/Users/pat/repo/a.txt" || v.Details.Content != "one\ntwo\n" {
		t.Fatalf("view: %s", view)
	}
	edit := `{"tool_name":"Edit","tool_input":{"file_path":"/r/x.go","old_string":"a","new_string":"b"}}`
	eid := ts.createApproval(t, tok, "", edit)
	if _, ev := ts.get(tok, "/api/approvals/"+eid); !strings.Contains(ev, `"kind":"edit"`) || !strings.Contains(ev, `"oldString":"a"`) {
		t.Fatalf("edit details: %s", ev)
	}
}

func TestApprovals_Notices(t *testing.T) {
	ts := newTestServer(t, true)
	room := filepath.Join(ts.root, "alpha", "Shared", "agents.md")
	os.WriteFile(room, []byte("---\nmdnest-chat: true\ntitle: agents\n---\n"), 0o644)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", uidPat, "pat", "collaborator")
	pat := jwtFor(t, uidPat, "collaborator", nil)
	notify := func(body, q string) (int, string) {
		return ts.do(tok, "POST", "/api/approvals/notices?cli=4.8.5&as=Builder&machine=mini&chat=alpha/Shared/agents.md"+q, strings.NewReader(body), "")
	}
	perm := `{"session_id":"s-1","hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt"}`

	// An open card for the session: the notice would only repeat it.
	ts.createApproval(t, tok, "", strings.Replace(approvalHookInput, "sess-1", "s-1", 1))
	if code, out := notify(perm, ""); code != 200 || !strings.Contains(out, "skipped") {
		t.Fatalf("permission_prompt with an open card: %d %s", code, out)
	}
	// No card (the policy kept it local): the notice says so.
	other := strings.Replace(perm, "s-1", "s-2", 1)
	if code, out := notify(other, ""); code != 201 {
		t.Fatalf("notice: %d %s", code, out)
	}
	notify(other, "") // a repeat replaces it, and does not post again
	_, list := ts.get(pat, "/api/approvals")
	if strings.Count(list, "is waiting for permission in its terminal") != 1 ||
		!strings.Contains(list, "Builder (Claude Code on mini) is waiting for permission in its terminal") {
		t.Fatalf("list: %s", list)
	}
	note := ts.readFile("alpha/Shared/agents.md")
	if strings.Count(note, "Builder on mini is waiting.") != 1 {
		t.Fatalf("chat line missing or repeated:\n%s", note)
	}
	stop := `{"session_id":"s-3","hook_event_name":"Stop","last_assistant_message":"secret plan"}`
	notify(stop, "&type=stopped")
	_, list = ts.get(pat, "/api/approvals")
	if !strings.Contains(list, "Builder (Claude Code on mini) stopped") || strings.Contains(list, "secret plan") {
		t.Fatalf("stopped notice: %s", list)
	}
	if note := ts.readFile("alpha/Shared/agents.md"); !strings.Contains(note, "Builder on mini stopped.") {
		t.Fatalf("no stopped line in chat:\n%s", note)
	}

	// Another account cannot see or dismiss them.
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	if _, l := ts.get(owen, "/api/approvals"); strings.Contains(l, "Builder") {
		t.Fatalf("another account sees the notices: %s", l)
	}
	var parsed struct{ Notices []struct{ ID, Type string } }
	json.Unmarshal([]byte(list), &parsed)
	var stoppedID string
	for _, n := range parsed.Notices {
		if n.Type == "stopped" {
			stoppedID = n.ID
		}
	}
	if code, _ := ts.do(owen, "DELETE", "/api/approvals/notices/"+stoppedID, nil, ""); code != 404 {
		t.Fatalf("another account dismissed a notice: %d", code)
	}
	if code, _ := ts.do(pat, "DELETE", "/api/approvals/notices/"+stoppedID, nil, ""); code != 200 {
		t.Fatalf("dismiss: %d", code)
	}
	// The agent carrying on (approval done) clears its session's notices.
	ts.do(tok, "POST", "/api/approvals/close?session=s-2", strings.NewReader(`{"session_id":"s-2","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}`), "")
	if _, l := ts.get(pat, "/api/approvals"); strings.Contains(l, `"notices":[{`) {
		t.Fatalf("notices left after the agent carried on: %s", l)
	}
	if code, _ := ts.do(tok, "POST", "/api/approvals/notices?cli=4.8.4", strings.NewReader(perm), ""); code != 426 {
		t.Fatalf("old CLI: %d, want 426", code)
	}
}
