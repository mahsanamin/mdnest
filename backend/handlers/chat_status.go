package handlers

import (
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// A poster's "working on it" line, shown quietly under a chat so people can
// see that an agent is busy (like Slack's typing indicator) without it adding
// a message to the conversation.
//
// It lives in memory only: it is presence, not content, so nothing about it is
// written to the note or survives a restart. Each status expires after
// chatStatusTTL unless the poster sets it again, so an agent that crashes
// mid-task does not leave "working…" up forever. Posting a message clears the
// poster's status, since the work it described has produced its answer.
//
// Per process, like the note lock: chat is not offered on the multi-replica
// app tier (ChatEnabled), so one process sees every status for its chats.

const (
	chatStatusTTL     = 2 * time.Minute
	maxChatStatusText = 120 // characters, after trimming to one line
)

// ChatStatus is one poster's current status as the chat view shows it.
type ChatStatus struct {
	Author string    `json:"author"`
	Via    string    `json:"via,omitempty"`
	Text   string    `json:"text"`
	Since  time.Time `json:"since"`
}

type chatStatusEntry struct {
	ChatStatus
	until time.Time
}

type chatStatusStore struct {
	mu sync.Mutex
	m  map[string]map[string]chatStatusEntry // "ns\x00path" -> author -> entry
}

func newChatStatusStore() *chatStatusStore {
	return &chatStatusStore{m: map[string]map[string]chatStatusEntry{}}
}

func chatStatusKey(ns, relPath string) string { return ns + "\x00" + relPath }

func (s *chatStatusStore) set(ns, relPath string, st ChatStatus, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := chatStatusKey(ns, relPath)
	if s.m[k] == nil {
		s.m[k] = map[string]chatStatusEntry{}
	}
	// Refreshing the same text keeps its original start time, so "for 3 min"
	// means the task, not the last refresh.
	if old, ok := s.m[k][st.Author]; ok && old.Text == st.Text && now.Before(old.until) {
		st.Since = old.Since
	}
	s.m[k][st.Author] = chatStatusEntry{ChatStatus: st, until: now.Add(chatStatusTTL)}
}

func (s *chatStatusStore) clear(ns, relPath, author string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := chatStatusKey(ns, relPath)
	delete(s.m[k], author)
	if len(s.m[k]) == 0 {
		delete(s.m, k)
	}
}

// list returns the live statuses for a chat, oldest first, pruning expired ones.
func (s *chatStatusStore) list(ns, relPath string, now time.Time) []ChatStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := chatStatusKey(ns, relPath)
	out := []ChatStatus{}
	for author, e := range s.m[k] {
		if !now.Before(e.until) {
			delete(s.m[k], author)
			continue
		}
		out = append(out, e.ChatStatus)
	}
	if len(s.m[k]) == 0 {
		delete(s.m, k)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Since.Equal(out[j].Since) {
			return out[i].Since.Before(out[j].Since)
		}
		return out[i].Author < out[j].Author
	})
	return out
}

// statusText reduces a body to one short, terminal-safe line.
func statusText(raw string) string {
	t := strings.Join(strings.Fields(terminalSafe(raw)), " ")
	if r := []rune(t); len(r) > maxChatStatusText {
		t = string(r[:maxChatStatusText-1]) + "…"
	}
	return t
}

// HandleStatus: POST /api/chat/status?ns=&path=&as= with the status as the
// body. An empty body clears the caller's status. Guarded like posting: you
// may set a status only where you may post.
func (h *ChatHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, relPath, ok := h.chatTarget(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		chatJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	if !h.headIsChat(r.Context(), ns, relPath) {
		chatJSONError(w, http.StatusNotFound, "no chat at this path")
		return
	}
	label, via, ok := h.author(r)
	if !ok {
		chatJSONError(w, http.StatusForbidden, "cannot attribute this status to a user")
		return
	}
	text := statusText(string(body))
	now := h.now()
	if text == "" {
		h.status.clear(ns, relPath, label)
	} else {
		h.status.set(ns, relPath, ChatStatus{Author: label, Via: via, Text: text, Since: now}, now)
	}
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, `{"status":"ok"}`)
}
