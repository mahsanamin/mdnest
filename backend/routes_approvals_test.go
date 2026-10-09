package main

// Agent approvals through the REAL route table and the REAL auth middleware.
// The decide check is the one that matters most: the agent runs on its
// owner's API token, so a token that could decide would let an agent approve
// its own command. Every token refusal below fails if that check is removed.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const approvalHookInput = `{"session_id":"sess-1","cwd":"/work/repo","hook_event_name":"PermissionRequest","permission_mode":"default",` +
	`"tool_name":"Bash","tool_input":{"command":"git push origin feat/x","description":"Push the branch"}}`

const allowOutput = `{"hookSpecificOutput":{"decision":{"behavior":"allow"},"hookEventName":"PermissionRequest"}}` + "\n"

func (ts *testServer) createApproval(t *testing.T, token, query, body string) string {
	t.Helper()
	code, out := ts.do(token, "POST", "/api/approvals?cli=4.8.5-dev"+query, strings.NewReader(body), "application/json")
	if code != 201 {
		t.Fatalf("create: %d %s", code, out)
	}
	var r struct{ ID string }
	json.Unmarshal([]byte(out), &r)
	if len(r.ID) != 32 {
		t.Fatalf("create: id %q is not 128 bits of hex", r.ID)
	}
	return r.ID
}

func (ts *testServer) decide(token, id, body string) (int, string) {
	return ts.do(token, "POST", "/api/approvals/"+id+"/decide", strings.NewReader(body), "application/json")
}

func approvalState(t *testing.T, ts *testServer, token, id string) string {
	t.Helper()
	code, out := ts.get(token, "/api/approvals/"+id)
	if code != 200 {
		t.Fatalf("get %s: %d %s", id, code, out)
	}
	var v struct{ State string }
	json.Unmarshal([]byte(out), &v)
	return v.State
}

// THE test. Single mode has no UserContext, so it is the case a check based on
// the user alone would miss.
func TestApprovals_DecideRefusesAPIToken_Single(t *testing.T) {
	ts := newTestServer(t, false)
	ts.approvals.SetTiming(nil, 50*time.Millisecond)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	browser := jwtFor(t, 1, "", nil)
	id := ts.createApproval(t, tok, "&agent=claude-code&machine=laptop", approvalHookInput)

	if code, out := ts.decide(tok, id, `{"decision":"allow"}`); code != 403 {
		t.Fatalf("decide with an API token: %d %s, want 403", code, out)
	}
	// ?token= is another way in for the same token.
	if code, out := ts.do("", "POST", "/api/approvals/"+id+"/decide?token="+tok, strings.NewReader(`{"decision":"allow"}`), "application/json"); code != 403 {
		t.Fatalf("decide with an API token in ?token=: %d %s, want 403", code, out)
	}
	if s := approvalState(t, ts, tok, id); s != "pending" {
		t.Fatalf("after token decide attempts state = %s, want pending", s)
	}
	if code, _ := ts.get(tok, "/api/approvals/"+id+"/wait"); code != 204 {
		t.Fatalf("wait while pending: %d, want 204", code)
	}

	if code, out := ts.decide(browser, id, `{"decision":"allow"}`); code != 200 {
		t.Fatalf("decide from a browser login: %d %s", code, out)
	}
	code, out := ts.get(tok, "/api/approvals/"+id+"/wait")
	if code != 200 || out != allowOutput {
		t.Fatalf("wait after allow: %d %q, want 200 %q", code, out, allowOutput)
	}
	if code, _ := ts.decide(browser, id, `{"decision":"deny"}`); code != 409 {
		t.Fatalf("second decision: %d, want 409", code)
	}
}

func TestApprovals_DecideRefusesAPIToken_Multi(t *testing.T) {
	ts := newTestServer(t, true)
	ts.approvals.SetTiming(nil, 50*time.Millisecond)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", uidPat, "pat", "collaborator")
	id := ts.createApproval(t, tok, "&agent=codex", approvalHookInput)

	if code, out := ts.decide(tok, id, `{"decision":"allow"}`); code != 403 {
		t.Fatalf("decide with the owner's API token: %d %s, want 403", code, out)
	}
	if s := approvalState(t, ts, tok, id); s != "pending" {
		t.Fatalf("state = %s, want pending", s)
	}
	pat := jwtFor(t, uidPat, "collaborator", nil)
	if code, out := ts.decide(pat, id, `{"decision":"deny","reason":"not on Fridays"}`); code != 200 {
		t.Fatalf("decide from the owner's browser: %d %s", code, out)
	}
	_, out := ts.get(tok, "/api/approvals/"+id+"/wait")
	want := `{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"not on Fridays"},"hookEventName":"PermissionRequest"}}` + "\n"
	if out != want {
		t.Fatalf("deny output %q, want %q", out, want)
	}
}

func TestApprovals_OtherAccountsSeeNothing(t *testing.T) {
	ts := newTestServer(t, true)
	ts.approvals.SetTiming(nil, 50*time.Millisecond)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", uidPat, "pat", "collaborator")
	id := ts.createApproval(t, tok, "", approvalHookInput)
	for _, other := range []string{
		jwtFor(t, uidOwen, "collaborator", nil),
		jwtFor(t, 99, "superadmin", nil), // a superadmin has no say over someone's agent either
	} {
		if code, _ := ts.get(other, "/api/approvals/"+id); code != 404 {
			t.Errorf("another account read it: %d", code)
		}
		if code, _ := ts.get(other, "/api/approvals/"+id+"/wait"); code != 410 {
			t.Errorf("another account waited on it: %d", code)
		}
		if code, _ := ts.decide(other, id, `{"decision":"allow"}`); code != 404 {
			t.Errorf("another account decided it: %d", code)
		}
		if _, out := ts.get(other, "/api/approvals"); strings.Contains(out, id) {
			t.Errorf("another account's list shows it: %s", out)
		}
		ts.do(other, "POST", "/api/approvals/close?session=sess-1", nil, "")
	}
	if s := approvalState(t, ts, tok, id); s != "pending" {
		t.Fatalf("state = %s after other accounts tried, want pending", s)
	}
	if _, out := ts.get(jwtFor(t, uidPat, "collaborator", nil), "/api/approvals"); !strings.Contains(out, id) || !strings.Contains(out, "git push origin feat/x") {
		t.Fatalf("owner's list: %s", out)
	}
	if code, _ := ts.get("", "/api/approvals"); code != 401 {
		t.Fatalf("no login: %d, want 401", code)
	}
}

func TestApprovals_CLIVersion(t *testing.T) {
	ts := newTestServer(t, false)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	for v, want := range map[string]int{"": 426, "4.8.4": 426, "4.8.5-dev": 201, "4.8.5": 201, "4.9.0": 201, "junk": 426} {
		code, out := ts.do(tok, "POST", "/api/approvals?cli="+v, strings.NewReader(approvalHookInput), "")
		if code != want {
			t.Errorf("cli=%q: %d %s, want %d", v, code, out, want)
		}
	}
}

func TestApprovals_Caps(t *testing.T) {
	ts := newTestServer(t, false)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	big := `{"tool_name":"Bash","tool_input":{"command":"` + strings.Repeat("x", 64<<10) + `"}}`
	if code, _ := ts.do(tok, "POST", "/api/approvals?cli=4.8.5", strings.NewReader(big), ""); code != 413 {
		t.Fatalf("65KB body: %d, want 413", code)
	}
	for i := 0; i < 20; i++ {
		ts.createApproval(t, tok, "", approvalHookInput)
	}
	if code, _ := ts.do(tok, "POST", "/api/approvals?cli=4.8.5", strings.NewReader(approvalHookInput), ""); code != 429 {
		t.Fatalf("21st pending: %d, want 429", code)
	}
	if code, _ := ts.do(tok, "POST", "/api/approvals?cli=4.8.5&agent=other", strings.NewReader(approvalHookInput), ""); code != 400 {
		t.Fatalf("unknown agent: %d, want 400", code)
	}
}

func TestApprovals_Expiry(t *testing.T) {
	ts := newTestServer(t, false)
	var mu sync.Mutex
	now := time.Now()
	ts.approvals.SetTiming(func() time.Time { mu.Lock(); defer mu.Unlock(); return now }, 50*time.Millisecond)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	id := ts.createApproval(t, tok, "&ttl=99999", approvalHookInput) // clamped to 60 minutes
	mu.Lock()
	now = now.Add(59 * time.Minute)
	mu.Unlock()
	if s := approvalState(t, ts, tok, id); s != "pending" {
		t.Fatalf("at 59 min: %s", s)
	}
	mu.Lock()
	now = now.Add(2 * time.Minute)
	mu.Unlock()
	if s := approvalState(t, ts, tok, id); s != "expired" {
		t.Fatalf("at 61 min: %s, want expired (ttl must cap at 60 min)", s)
	}
	if code, _ := ts.get(tok, "/api/approvals/"+id+"/wait"); code != 410 {
		t.Fatalf("wait once expired: %d, want 410", code)
	}
	if code, _ := ts.decide(jwtFor(t, 1, "", nil), id, `{"decision":"allow"}`); code != 409 {
		t.Fatalf("decide once expired: %d, want 409", code)
	}
}

func TestApprovals_WaitWakesOnDecision(t *testing.T) {
	ts := newTestServer(t, false)
	ts.approvals.SetTiming(nil, 5*time.Second)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	id := ts.createApproval(t, tok, "", approvalHookInput)
	go func() {
		time.Sleep(100 * time.Millisecond)
		ts.decide(jwtFor(t, 1, "", nil), id, `{"decision":"allow"}`)
	}()
	start := time.Now()
	code, out := ts.get(tok, "/api/approvals/"+id+"/wait")
	if code != 200 || out != allowOutput || time.Since(start) > 3*time.Second {
		t.Fatalf("long poll: %d %q after %v", code, out, time.Since(start))
	}
}

func TestApprovals_CloseBySession(t *testing.T) {
	ts := newTestServer(t, false)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	other := `{"session_id":"sess-1","tool_name":"Bash","tool_input":{"command":"make test"}}`
	push := ts.createApproval(t, tok, "", approvalHookInput)
	test := ts.createApproval(t, tok, "", other)
	elsewhere := ts.createApproval(t, tok, "", strings.Replace(approvalHookInput, "sess-1", "sess-2", 1))

	// PostToolUse for the push closes the push only: a parallel call that is
	// still waiting keeps its card.
	post := `{"session_id":"sess-1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"git push origin feat/x"},"tool_response":{}}`
	code, out := ts.do(tok, "POST", "/api/approvals/close?session=sess-1", strings.NewReader(post), "")
	if code != 200 || !strings.Contains(out, `"closed":1`) {
		t.Fatalf("close after PostToolUse: %d %s", code, out)
	}
	if s := approvalState(t, ts, tok, push); s != "closed" {
		t.Fatalf("push: %s, want closed", s)
	}
	if s := approvalState(t, ts, tok, test); s != "pending" {
		t.Fatalf("parallel call: %s, want pending", s)
	}
	if code, _ := ts.get(tok, "/api/approvals/"+push+"/wait"); code != 410 {
		t.Fatalf("wait on a closed request: %d, want 410", code)
	}
	// Stop closes everything left in the session, and nothing in another.
	stop := `{"session_id":"sess-1","hook_event_name":"Stop"}`
	ts.do(tok, "POST", "/api/approvals/close?session=sess-1", strings.NewReader(stop), "")
	if s := approvalState(t, ts, tok, test); s != "closed" {
		t.Fatalf("after Stop: %s, want closed", s)
	}
	if s := approvalState(t, ts, tok, elsewhere); s != "pending" {
		t.Fatalf("another session: %s, want pending", s)
	}
	if code, _ := ts.decide(jwtFor(t, 1, "", nil), push, `{"decision":"allow"}`); code != 409 {
		t.Fatalf("decide a closed request: %d, want 409", code)
	}
}

func TestApprovals_ChatCardCarriesNoCommand(t *testing.T) {
	ts := newTestServer(t, true)
	room := filepath.Join(ts.root, "alpha", "Shared", "agents.md")
	os.WriteFile(room, []byte("---\nmdnest-chat: true\ntitle: agents\n---\n"), 0o644)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", uidPat, "pat", "collaborator")

	id := ts.createApproval(t, tok, "&agent=claude-code&machine=build-box&chat=alpha/Shared/agents.md", approvalHookInput)
	note := ts.readFile("alpha/Shared/agents.md")
	if !strings.Contains(note, "![approval](approval:"+id+")") {
		t.Fatalf("chat has no card marker:\n%s", note)
	}
	if !strings.Contains(note, "Claude Code on build-box is waiting for approval.") {
		t.Fatalf("chat has no readable line:\n%s", note)
	}
	if !strings.Contains(note, "claude-code (via pat)") {
		t.Fatalf("card not attributed to the account:\n%s", note)
	}
	for _, leak := range []string{"git push", "Push the branch", "/work/repo"} {
		if strings.Contains(note, leak) {
			t.Fatalf("chat note carries %q; the command must only come from the owner-only API:\n%s", leak, note)
		}
	}

	// A chat the account cannot write gets no card, and the request still works.
	before := ts.readFile("alpha/Private/room.md")
	ts.createApproval(t, tok, "&chat=alpha/Private/room.md", approvalHookInput)
	if after := ts.readFile("alpha/Private/room.md"); after != before {
		t.Fatalf("a card was posted in a chat the account cannot write:\n%s", after)
	}
	if code, _ := ts.do(tok, "POST", "/api/approvals?cli=4.8.5&chat=alpha/Shared/../Private/room.md", strings.NewReader(approvalHookInput), ""); code != 400 {
		t.Fatalf("non-canonical chat path: %d, want 400", code)
	}
}

func TestApprovals_CommandIsFromToolInputNotDescription(t *testing.T) {
	ts := newTestServer(t, false)
	tok, _, _ := ts.tokens.CreateAPIToken("agent", 0, "admin", "")
	id := ts.createApproval(t, tok, "", `{"tool_name":"Bash","tool_input":{"command":"rm -rf build","description":"list files"}}`)
	_, out := ts.get(tok, "/api/approvals/"+id)
	var v struct{ Command, Description string }
	json.Unmarshal([]byte(out), &v)
	if v.Command != "rm -rf build" || v.Description != "list files" {
		t.Fatalf("got %+v", v)
	}
}
