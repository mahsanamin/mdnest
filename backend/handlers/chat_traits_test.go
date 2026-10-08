package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const traitChatURL = "/api/chat?ns=work&path=Chats/release.md"

func chatAgentsOf(t *testing.T, h *ChatHandler) map[string]string {
	t.Helper()
	w := chatDo(t, h.Handle, http.MethodGet, traitChatURL, "", nil)
	var resp chatResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("read: %d %s", w.Code, w.Body)
	}
	return resp.Agents
}

// The point of the feature: a waiting agent handed new messages is told its
// role again, after the messages, every time.
func TestWaitRepeatsTheAgentsRole(t *testing.T) {
	h, _ := newStatusTestChat(t)
	if w := chatDo(t, h.HandleAgents, http.MethodPost, "/api/chat/agents?ns=work&path=Chats/release.md&name=codxu", "Review the API pull requests.\nFlag anything touching auth.", nil); w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	chatDo(t, h.Handle, http.MethodPost, traitChatURL+"&as=ahsan", "@codxu can you look at #12?", nil)

	w := chatDo(t, h.Handle, http.MethodGet, traitChatURL+"&after=0&exclude=codxu&format=text", "", nil)
	body := w.Body.String()
	msg := strings.Index(body, "can you look at #12?")
	rem := strings.Index(body, "(reminder for codxu) Your role in this chat: Review the API pull requests. Flag anything touching auth.")
	if msg < 0 || rem < msg {
		t.Fatalf("wait should print the messages, then the role:\n%s", body)
	}
	// Another agent waiting gets no reminder (it has no role), and neither
	// does a plain read or an empty poll.
	if b := chatDo(t, h.Handle, http.MethodGet, traitChatURL+"&after=0&exclude=qa-1&format=text", "", nil).Body.String(); strings.Contains(b, "reminder") {
		t.Fatalf("qa-1 has no role, got:\n%s", b)
	}
	if b := chatDo(t, h.Handle, http.MethodGet, traitChatURL+"&after=0&format=text", "", nil).Body.String(); strings.Contains(b, "reminder") {
		t.Fatalf("a read with no name should not carry a reminder:\n%s", b)
	}
	if b := chatDo(t, h.Handle, http.MethodGet, traitChatURL+"&after=99&exclude=codxu&format=text", "", nil).Body.String(); b != "" {
		t.Fatalf("an empty poll must stay empty, or the CLI thinks there is news: %q", b)
	}
	// Names match like mentions do.
	if b := chatDo(t, h.Handle, http.MethodGet, traitChatURL+"&after=0&exclude=Codxu&format=text", "", nil).Body.String(); !strings.Contains(b, "Your role in this chat") {
		t.Fatalf("the name should match case-insensitively:\n%s", b)
	}
	if got := chatAgentsOf(t, h)["codxu"]; got != "Review the API pull requests. Flag anything touching auth." {
		t.Fatalf("JSON read should list the role, got %q", got)
	}
}

// The role lives in the note, so it outlives a server restart and shows in
// any viewer; saving it must not disturb the messages or other keys.
func TestRoleIsKeptInTheNoteFrontMatter(t *testing.T) {
	h, root := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=Chats/release.md&title=Release", "", nil)
	chatDo(t, h.Handle, http.MethodPost, traitChatURL+"&as=ahsan", "first", nil)
	chatDo(t, h.HandleAgents, http.MethodPost, "/api/chat/agents?ns=work&path=Chats/release.md&name=lead-qa", `Plan the tests: "smoke" first`, nil)
	chatDo(t, h.HandleAgents, http.MethodPost, "/api/chat/agents?ns=work&path=Chats/release.md&name=codxu", "Review PRs", nil)
	chatDo(t, h.HandleAgents, http.MethodPost, "/api/chat/agents?ns=work&path=Chats/release.md&name=CODXU", "Review PRs and docs", nil)

	data := readTestFile(t, root, "work/Chats/release.md")
	want := "---\nmdnest-chat: true\ntitle: Release\nagents:\n  lead-qa: \"Plan the tests: \\\"smoke\\\" first\"\n  CODXU: \"Review PRs and docs\"\n---\n"
	if !strings.HasPrefix(data, want) {
		t.Fatalf("front matter:\n%s\nwant prefix:\n%s", data, want)
	}
	doc := ParseChat(data)
	if !doc.IsChat || doc.Title != "Release" || len(doc.Messages) != 1 || doc.Messages[0].Text != "first" {
		t.Fatalf("saving a role broke the chat: %+v", doc)
	}
	if doc.Agents["lead-qa"] != `Plan the tests: "smoke" first` {
		t.Fatalf("quotes should round-trip, got %q", doc.Agents["lead-qa"])
	}
	// Removing the last role drops the block.
	chatDo(t, h.HandleAgents, http.MethodPost, "/api/chat/agents?ns=work&path=Chats/release.md&name=lead-qa", "", nil)
	chatDo(t, h.HandleAgents, http.MethodPost, "/api/chat/agents?ns=work&path=Chats/release.md&name=codxu", " ", nil)
	if data := readTestFile(t, root, "work/Chats/release.md"); strings.Contains(data, "agents:") {
		t.Fatalf("an empty agents block should be removed:\n%s", data)
	}
}

// "/role ..." is the agent's own way to save it, from any CLI or MCP.
func TestSlashRoleSavesThePostersRole(t *testing.T) {
	h, _ := newStatusTestChat(t)
	w := chatDo(t, h.Handle, http.MethodPost, traitChatURL+"&as=qa-1", "/role Test the login page only.", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"saved"`) {
		t.Fatalf("/role: %d %s", w.Code, w.Body)
	}
	if got := chatAgentsOf(t, h)["qa-1"]; got != "Test the login page only." {
		t.Fatalf("role = %q", got)
	}
	resp := chatDo(t, h.Handle, http.MethodGet, traitChatURL, "", nil)
	var doc chatResponse
	json.Unmarshal(resp.Body.Bytes(), &doc)
	if doc.Count != 0 {
		t.Fatalf("/role must not become a message, got %d", doc.Count)
	}
	// Only the command itself: "/roles" is an ordinary message.
	chatDo(t, h.Handle, http.MethodPost, traitChatURL+"&as=qa-1", "/roles are listed in the panel", nil)
	json.Unmarshal(chatDo(t, h.Handle, http.MethodGet, traitChatURL, "", nil).Body.Bytes(), &doc)
	if doc.Count != 1 {
		t.Fatalf("/roles should be a message, count %d", doc.Count)
	}
	// A label that cannot be a YAML key is refused, not written.
	if w := chatDo(t, h.Handle, http.MethodPost, traitChatURL+"&as=two%20words", "/role x", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("a name with a space: %d %s", w.Code, w.Body)
	}
}

func TestRoleIsOneShortSafeLine(t *testing.T) {
	long := strings.Repeat("word ", 200)
	got := cleanChatTrait("a\x1b[31m red‮ line\n\nsecond   line " + long)
	if strings.ContainsAny(got, "\x1b\n‮") {
		t.Fatalf("control characters left: %q", got)
	}
	if n := len([]rune(got)); n > maxChatTrait || !strings.HasSuffix(got, "…") {
		t.Fatalf("not cut to %d: %d %q", maxChatTrait, n, got)
	}
	// A front matter edited by hand keeps working, and a bad line is skipped.
	fm := "mdnest-chat: true\nagents:\n  ok: plain text\n  q: 'it''s fine'\n  bad name: nope\ntitle: T\n"
	got2 := ChatTraits(fm)
	if got2["ok"] != "plain text" || got2["q"] != "it's fine" || len(got2) != 2 {
		t.Fatalf("hand-written block: %v", got2)
	}
	out, err := SetChatTrait("---\n"+fm+"---\nbody\n", "new", "role")
	if err != nil || !strings.Contains(out, "title: T\n---\nbody\n") || !strings.Contains(out, "  new: \"role\"\n") {
		t.Fatalf("other keys and the body must survive: %v\n%s", err, out)
	}
}

func readTestFile(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
