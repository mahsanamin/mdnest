package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
)

func chatWorking(t *testing.T, h *ChatHandler) []ChatStatus {
	t.Helper()
	w := chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=Chats/release.md", "", nil)
	var resp chatResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("read: %d %s", w.Code, w.Body)
	}
	return resp.Working
}

func newStatusTestChat(t *testing.T) *ChatHandler {
	t.Helper()
	h, _ := newChatTestHandler(t)
	if w := chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=Chats/release.md&title=Release", "", nil); w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	return h
}

func TestChatStatusShowsAndAPostClearsIt(t *testing.T) {
	h := newStatusTestChat(t)
	if w := chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "reviewing the API PR", nil); w.Code != 200 {
		t.Fatalf("set: %d %s", w.Code, w.Body)
	}
	got := chatWorking(t, h)
	if len(got) != 1 || got[0].Author != "codxu" || got[0].Text != "reviewing the API PR" {
		t.Fatalf("status not shown: %+v", got)
	}
	// Someone else posting does not clear it; codxu posting does.
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=Chats/release.md&as=ahsan", "any news?", nil)
	if len(chatWorking(t, h)) != 1 {
		t.Fatalf("another poster's message cleared codxu's status")
	}
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=Chats/release.md&as=codxu", "done: LGTM", nil)
	if got := chatWorking(t, h); len(got) != 0 {
		t.Fatalf("codxu's post should clear its status: %+v", got)
	}
}

func TestChatStatusEmptyBodyClearsIt(t *testing.T) {
	h := newStatusTestChat(t)
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "thinking", nil)
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "   ", nil)
	if got := chatWorking(t, h); len(got) != 0 {
		t.Fatalf("empty status should clear: %+v", got)
	}
}

func TestChatStatusExpires(t *testing.T) {
	h := newStatusTestChat(t)
	now := fixedChatTime
	h.now = func() time.Time { return now }
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "running the tests", nil)
	now = now.Add(chatStatusTTL - time.Second)
	if len(chatWorking(t, h)) != 1 {
		t.Fatalf("status gone before its TTL")
	}
	// A refresh with the same text keeps the original start time.
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "running the tests", nil)
	if got := chatWorking(t, h); len(got) != 1 || !got[0].Since.Equal(fixedChatTime) {
		t.Fatalf("refresh should keep since=%v: %+v", fixedChatTime, got)
	}
	now = now.Add(chatStatusTTL + time.Second)
	if got := chatWorking(t, h); len(got) != 0 {
		t.Fatalf("a status nobody refreshed must expire: %+v", got)
	}
}

func TestChatStatusIsOneShortSafeLine(t *testing.T) {
	h := newStatusTestChat(t)
	long := "line one\nline two\x1b[2J " + strings.Repeat("x", 300)
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", long, nil)
	got := chatWorking(t, h)
	if len(got) != 1 {
		t.Fatalf("no status: %+v", got)
	}
	s := got[0].Text
	if strings.ContainsAny(s, "\n\x1b") || len([]rune(s)) > maxChatStatusText || !strings.HasPrefix(s, "line one line two") {
		t.Fatalf("status not reduced to one safe short line: %q", s)
	}
}

func TestChatStatusNeedsAChat(t *testing.T) {
	h, root := newChatTestHandler(t)
	_ = root
	w := chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/none.md&as=codxu", "x", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status on a missing chat: %d %s", w.Code, w.Body)
	}
	w = chatDo(t, h.HandleStatus, http.MethodGet, "/api/chat/status?ns=work&path=Chats/none.md", "", nil)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", w.Code)
	}
}

func TestChatStatusInMultiModeIsLabelledLikeAPost(t *testing.T) {
	h := newStatusTestChat(t)
	h.multiMode = true
	uc := &middleware.UserContext{ID: 7, Username: "ahsan"}
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "busy", uc)
	w := chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=Chats/release.md", "", uc)
	var resp chatResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Working) != 1 || resp.Working[0].Author != "codxu" || resp.Working[0].Via != "ahsan" {
		t.Fatalf("a label that is not the account must carry via: %+v", resp.Working)
	}
	// A token that maps to no user cannot set one (it could pick any label).
	if w := chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=boss", "x", nil); w.Code != http.StatusForbidden {
		t.Fatalf("status without a user in multi mode: %d", w.Code)
	}
}

func TestChatStatusInTheTextReadHeader(t *testing.T) {
	h := newStatusTestChat(t)
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "reviewing the PR", nil)
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=claude-b", "running tests", nil)
	w := chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=Chats/release.md&format=text", "", nil)
	got := w.Header().Get("X-Chat-Working")
	if got != "claude-b: running tests | codxu: reviewing the PR" {
		t.Fatalf("X-Chat-Working = %q", got)
	}
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=codxu", "", nil)
	chatDo(t, h.HandleStatus, http.MethodPost, "/api/chat/status?ns=work&path=Chats/release.md&as=claude-b", "", nil)
	w = chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=Chats/release.md&format=text", "", nil)
	if _, ok := w.Header()["X-Chat-Working"]; ok {
		t.Fatalf("no statuses should mean no header")
	}
}
