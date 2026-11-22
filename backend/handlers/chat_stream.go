package handlers

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/mdnest/mdnest/backend/storage"
)

// Notifications are hints, not state. A reader subscribes before its initial
// snapshot and always re-reads the note under the write lock. The periodic
// catch-up also sees git-sync and direct filesystem writes.
type chatSubscription struct {
	ns, path, account string
	wake              chan struct{}
}
type chatEvents struct {
	sync.Mutex
	subscribers map[*chatSubscription]bool
}

func (h *ChatHandler) WakeNamespace(ns string) {
	h.events.Lock()
	defer h.events.Unlock()
	for s := range h.events.subscribers {
		if s.ns == ns {
			select {
			case s.wake <- struct{}{}:
			default:
			}
		}
	}
}

func (h *ChatHandler) HandleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		chatJSONError(w, 405, "method not allowed")
		return
	}
	ns, p, ok := h.coordinationTarget(w, r)
	if !ok {
		return
	}
	if h.canRead == nil || !h.canRead(r, ns, p) {
		chatJSONError(w, 403, "access denied")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		chatJSONError(w, 500, "streaming unavailable")
		return
	}
	s := &chatSubscription{ns: ns, path: p, account: coordinationIdentity(r, ""), wake: make(chan struct{}, 1)}
	h.events.Lock()
	if h.events.subscribers == nil {
		h.events.subscribers = map[*chatSubscription]bool{}
	}
	count := 0
	for other := range h.events.subscribers {
		if other.account == s.account {
			count++
		}
	}
	if count >= 8 || len(h.events.subscribers) >= 128 {
		h.events.Unlock()
		chatJSONError(w, 429, "too many chat streams")
		return
	}
	h.events.subscribers[s] = true
	h.events.Unlock()
	defer func() { h.events.Lock(); delete(h.events.subscribers, s); h.events.Unlock() }()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	write := func(event string, data any) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		encoded, _ := json.Marshal(data)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	var previous [32]byte
	first := true
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	end := time.NewTimer(55 * time.Second)
	defer end.Stop()
	for {
		// Grants are re-checked on every pass; the token itself is checked
		// once, when the stream opens, and the 55 s cap bounds the rest.
		if h.canRead == nil || !h.canRead(r, ns, p) {
			write("gone", map[string]any{"status": 403})
			return
		}
		unlock := lockNote(ns, p)
		data, err := h.store.ReadFile(r.Context(), ns, p)
		unlock()
		if err != nil {
			status := 500
			if errors.Is(err, storage.ErrNotExist) {
				status = 404
			}
			write("gone", map[string]any{"status": status})
			return
		}
		digest := sha256.Sum256(data)
		if first || digest != previous {
			doc := ParseChat(string(data))
			if !doc.IsChat {
				write("gone", map[string]any{"status": 404})
				return
			}
			if !write("change", map[string]any{"count": len(doc.Messages), "crew_status": readCoordination(string(data)).Status}) {
				return
			}
			previous, first = digest, false
		} else if !write("heartbeat", map[string]bool{"ok": true}) {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-end.C:
			return
		case <-tick.C:
		case <-s.wake:
		}
	}
}
