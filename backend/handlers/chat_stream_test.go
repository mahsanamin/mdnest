package handlers

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestChatStreamWakesWithoutCollabAndClosesOnRevocation(t *testing.T) {
	h, _ := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, "POST", "/api/chat/convert?ns=work&path=room.md", "", nil)
	var allowed atomic.Bool
	allowed.Store(true)
	h.canRead = func(*http.Request, string, string) bool { return allowed.Load() }
	finished := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { defer close(finished); h.HandleStream(w, r) }))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/chat/stream?ns=work&path=room.md", nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("X-Accel-Buffering") != "no" || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("missing SSE headers: %v", response.Header)
	}
	reader := bufio.NewReader(response.Body)
	readEvent := func() string {
		t.Helper()
		var event strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			event.WriteString(line)
			if line == "\n" {
				return event.String()
			}
		}
	}
	if event := readEvent(); !strings.HasPrefix(event, "event: change\n") {
		t.Fatal(event)
	}
	chatDo(t, h.Handle, "POST", "/api/chat?ns=work&path=room.md", "wake without collab", nil)
	if event := readEvent(); !strings.Contains(event, `"count":1`) {
		t.Fatal(event)
	}
	allowed.Store(false)
	h.WakeNamespace("work")
	if event := readEvent(); !strings.HasPrefix(event, "event: gone\n") || !strings.Contains(event, "403") {
		t.Fatal(event)
	}
	response.Body.Close()
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("stream handler did not return")
	}
	h.events.Lock()
	count := len(h.events.subscribers)
	h.events.Unlock()
	if count != 0 {
		t.Fatalf("subscription leaked: %d", count)
	}
}

func TestChatStreamPermissionAndSubscriptionLimit(t *testing.T) {
	h, _ := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, "POST", "/api/chat/convert?ns=work&path=room.md", "", nil)
	h.canRead = func(*http.Request, string, string) bool { return false }
	if w := chatDo(t, h.HandleStream, "GET", "/api/chat/stream?ns=work&path=room.md", "", nil); w.Code != 403 {
		t.Fatalf("denied read: %d", w.Code)
	}
	h.canRead = func(*http.Request, string, string) bool { return true }
	h.events.subscribers = map[*chatSubscription]bool{}
	for i := 0; i < 8; i++ {
		h.events.subscribers[&chatSubscription{account: ""}] = true
	}
	if w := chatDo(t, h.HandleStream, "GET", "/api/chat/stream?ns=work&path=room.md", "", nil); w.Code != 429 {
		t.Fatalf("limit: %d", w.Code)
	}
}
