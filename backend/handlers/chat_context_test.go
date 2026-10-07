package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestParseChatContext(t *testing.T) {
	cases := []struct {
		in               string
		used, total, pct int
	}{
		{"42%", 0, 0, 42},
		{"42", 0, 0, 42},
		{"41.6 %", 0, 0, 42},
		{"87k/200k", 87000, 200000, 44},
		{"87,000 / 200,000 tokens", 87000, 200000, 44},
		{"87k of 200k", 87000, 200000, 44},
		{"1.2M/2m", 1200000, 2000000, 60},
		{"87k", 87000, 0, -1},
		{"150000 tokens used", 150000, 0, -1},
	}
	for _, c := range cases {
		got, ok := parseChatContext(c.in)
		if !ok || got.Used != c.used || got.Total != c.total || got.Pct != c.pct {
			t.Errorf("%q: got %+v ok=%v, want used=%d total=%d pct=%d", c.in, got, ok, c.used, c.total, c.pct)
		}
	}
	for _, bad := range []string{"lots", "120%", "-5%", "300k/200k", "5/0", "87k/", "about half"} {
		if got, ok := parseChatContext(bad); ok {
			t.Errorf("%q should be refused, got %+v", bad, got)
		}
	}
}

func TestSlashContextOnlyMatchesTheCommand(t *testing.T) {
	for _, s := range []string{"/contexts", "/context-size 4", "see /context 4"} {
		if _, ok := slashContext(s); ok {
			t.Errorf("%q is an ordinary message", s)
		}
	}
	if v, ok := slashContext("/context  42% "); !ok || v != "42%" {
		t.Errorf("got %q %v", v, ok)
	}
}

func chatContextsOf(t *testing.T, h *ChatHandler) chatResponse {
	t.Helper()
	w := chatDo(t, h.Handle, http.MethodGet, statusChatURL, "", nil)
	var resp chatResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("read: %d %s", w.Code, w.Body)
	}
	return resp
}

// The whole feature: a /context post is shown by the poster's name and never
// becomes a message.
func TestContextPostIsShownByNameNotAdded(t *testing.T) {
	h, now := newStatusTestChat(t)
	w := chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/context 87k/200k", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"context set"`) {
		t.Fatalf("/context post: %d %s", w.Code, w.Body)
	}
	resp := chatContextsOf(t, h)
	if resp.Count != 0 {
		t.Fatalf("/context must not become a message: count=%d", resp.Count)
	}
	if c := resp.Contexts["codxu"]; c.Pct != 44 || c.Used != 87000 || c.Total != 200000 {
		t.Fatalf("context not recorded: %+v", resp.Contexts)
	}
	// It rides along on the presence entry too.
	chatDo(t, h.Handle, http.MethodGet, statusChatURL+"&after=0&exclude=codxu&format=text", "", nil)
	resp = chatContextsOf(t, h)
	if len(resp.Working) != 1 || resp.Working[0].Context == nil || resp.Working[0].Context.Pct != 44 {
		t.Fatalf("presence should carry the context: %+v", resp.Working)
	}
	// An unreadable report is refused with the format, so the agent can fix it.
	w = chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/context about half", nil)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "/context 42%") {
		t.Fatalf("bad report: %d %s", w.Code, w.Body)
	}
	// A post does not clear it (it is not a status); an empty /context does.
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "done", nil)
	if _, ok := chatContextsOf(t, h).Contexts["codxu"]; !ok {
		t.Fatalf("a post should keep the context report")
	}
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/context", nil)
	if _, ok := chatContextsOf(t, h).Contexts["codxu"]; ok {
		t.Fatalf("empty /context should clear it")
	}
	// Reports expire.
	chatDo(t, h.Handle, http.MethodPost, statusChatURL+"&as=codxu", "/context 10%", nil)
	*now = now.Add(chatContextTTL + time.Second)
	if _, ok := chatContextsOf(t, h).Contexts["codxu"]; ok {
		t.Fatalf("an old report must expire")
	}
}
