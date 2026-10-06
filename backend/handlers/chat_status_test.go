package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
)

const statusChatURL = "/api/chat?ns=work&path=Chats/release.md"

func chatPresenceOf(t *testing.T, h *ChatHandler) []ChatStatus {
	t.Helper()
	w := chatDo(t, h.Handle, http.MethodGet, statusChatURL, "", nil)
	var resp chatResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("read: %d %s", w.Code, w.Body)
	}
	return resp.Working
}

func presenceKind(st []ChatStatus, author string) string {
	for _, s := range st {
		if s.Author == author {
			return s.Kind
		}
	}
	return ""
}

func newStatusTestChat(t *testing.T) (*ChatHandler, *time.Time) {
	t.Helper()
	h, _ := newChatTestHandler(t)
	now := fixedChatTime
	h.now = func() time.Time { return now }
	if w := chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=Chats/release.md&title=Release", "", nil); w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	return h, &now
}

// The whole point: presence comes from the polls a waiting agent already
// makes (exclude=NAME), so it works with every CLI version.
func TestPresenceIsInferredFromWaitPolls(t *testing.T) {
	h, now := newStatusTestChat(t)
	// codxu waits: an empty poll means listening.
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=codxu&format=text", "", nil)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k != statusListening {
		t.Fatalf("after an empty poll codxu should be listening, got %q", k)
	}
	// Someone posts; codxu's next poll hands it the message: thinking.
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=ahsan", "can you check the PR?", nil)
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=codxu&format=text", "", nil)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k != statusThinking {
		t.Fatalf("a poll that delivered messages should mean thinking, got %q", k)
	}
	// It replies: back to listening (it was polling, and will wait again).
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "on it", nil)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k != statusListening {
		t.Fatalf("after posting codxu should be listening, got %q", k)
	}
	// It stops polling: gone after the listen window.
	*now = now.Add(chatListenWindow + time.Second)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k != "" {
		t.Fatalf("an agent that stopped polling should drop out, got %q", k)
	}
}

func TestPresenceNeedsANamedPoll(t *testing.T) {
	h, _ := newStatusTestChat(t)
	// A post by itself is not presence: a script that posts once is not waiting.
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=script", "build finished", nil)
	// The web UI and a plain read send no exclude: nobody is marked present.
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0", "", nil)
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=~", "", nil)
	if got := chatPresenceOf(t, h); len(got) != 0 {
		t.Fatalf("no presence without a named poll: %+v", got)
	}
}

func TestThinkingDoesNotLastForever(t *testing.T) {
	h, now := newStatusTestChat(t)
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=ahsan", "hello", nil)
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=codxu", "", nil)
	*now = now.Add(chatThinkingMax + time.Second)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k != "" {
		t.Fatalf("an agent that never came back should not stay 'thinking', got %q", k)
	}
}

// /status in an ordinary post: works from any CLI or MCP post_chat, and is
// never written into the conversation.
func TestSlashStatusPostSetsStatusWithoutAMessage(t *testing.T) {
	h, now := newStatusTestChat(t)
	w := chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/status reviewing the API PR", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"count":0`) {
		t.Fatalf("/status post: %d %s", w.Code, w.Body)
	}
	got := chatPresenceOf(t, h)
	if len(got) != 1 || got[0].Kind != statusWorking || got[0].Text != "reviewing the API PR" {
		t.Fatalf("status not set: %+v", got)
	}
	w = chatDo(t, h.Handle, http.MethodGet, statusChatURL, "", nil)
	var resp chatResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Count != 0 {
		t.Fatalf("/status must not become a message: count=%d", resp.Count)
	}
	// Working outranks thinking: a poll that delivers messages keeps the status.
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=ahsan", "how is it going?", nil)
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=codxu", "", nil)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k != statusWorking {
		t.Fatalf("explicit status should outrank thinking, got %q", k)
	}
	// An empty /status clears it.
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/status", nil)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k == statusWorking {
		t.Fatalf("empty /status should clear it")
	}
	// Expiry.
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/status running tests", nil)
	*now = now.Add(chatStatusTTL + time.Second)
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k == statusWorking {
		t.Fatalf("a status nobody refreshed must expire")
	}
}

func TestSlashStatusOnlyMatchesTheCommand(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
		ok   bool
	}{
		{"/status busy", "busy", true},
		{"/status", "", true},
		{"/status\nline two", "line two", true},
		{"/statuses are great", "", false},
		{"/status-page is down", "", false},
		{"talking about /status here", "", false},
	} {
		got, ok := slashStatus(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("slashStatus(%q) = %q,%v want %q,%v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestStatusEndpointStillWorks(t *testing.T) {
	h, _ := newStatusTestChat(t)
	if w := chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "busy", nil); w.Code != 200 {
		t.Fatalf("endpoint: %d %s", w.Code, w.Body)
	}
	if k := presenceKind(chatPresenceOf(t, h), "codxu"); k != statusWorking {
		t.Fatalf("got %q", k)
	}
	if w := chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/none.md&as=codxu", "x", nil); w.Code != http.StatusNotFound {
		t.Fatalf("missing chat: %d", w.Code)
	}
	if w := chatDo(t, h.HandleStatus, http.MethodGet, "/api/chat/status?ns=work&path=Chats/release.md", "", nil); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", w.Code)
	}
}

func TestStatusIsOneShortSafeLine(t *testing.T) {
	h, _ := newStatusTestChat(t)
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/status line one\nline two\x1b[2J "+strings.Repeat("x", 300), nil)
	got := chatPresenceOf(t, h)
	if len(got) != 1 {
		t.Fatalf("no status: %+v", got)
	}
	if s := got[0].Text; strings.ContainsAny(s, "\n\x1b") || len([]rune(s)) > maxChatStatusText || !strings.HasPrefix(s, "line one line two") {
		t.Fatalf("not one safe short line: %q", s)
	}
}

func TestPresenceInMultiModeIsLabelledLikeAPost(t *testing.T) {
	h, _ := newStatusTestChat(t)
	h.multiMode = true
	uc := &middleware.UserContext{ID: 7, Username: "ahsan"}
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=codxu", "", uc)
	w := chatDo(t, h.Handle, http.MethodGet, statusChatURL, "", uc)
	var resp chatResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Working) != 1 || resp.Working[0].Author != "codxu" || resp.Working[0].Via != "ahsan" {
		t.Fatalf("a label that is not the account carries via: %+v", resp.Working)
	}
	// A token with no user cannot appear as anyone.
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=boss", "", nil)
	if w := chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=boss", "/status x", nil); w.Code != http.StatusForbidden {
		t.Fatalf("/status without a user in multi mode: %d", w.Code)
	}
	w = chatDo(t, h.Handle, http.MethodGet, statusChatURL, "", uc)
	json.Unmarshal(w.Body.Bytes(), &resp)
	for _, s := range resp.Working {
		if s.Author == "boss" {
			t.Fatalf("a userless poll created presence: %+v", resp.Working)
		}
	}
}

func TestBusyHeaderForTextReads(t *testing.T) {
	h, _ := newStatusTestChat(t)
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/status reviewing the PR", nil)
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=ahsan", "ping", nil)
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=lead-qa", "", nil) // thinking
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=9&exclude=listener", "", nil) // listening
	w := chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&format=text", "", nil)
	if got := w.Header().Get("X-Chat-Working"); got != "codxu: reviewing the PR | lead-qa: thinking" {
		t.Fatalf("X-Chat-Working = %q", got)
	}
}
