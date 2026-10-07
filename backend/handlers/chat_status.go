package handlers

import (
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mdnest/mdnest/backend/storage"
)

// Who is in a chat and what they are doing, shown quietly under the
// conversation (like Slack's typing line) so people can see an agent is
// alive without it adding messages.
//
// Most of it needs nothing from the agent. Every `mdnest chat wait --as NAME`
// (any CLI since chat shipped) and the MCP wait_chat tool poll GET /api/chat
// with exclude=NAME, so the server infers:
//
//   listening  NAME polled in the last chatListenWindow (shown as "waiting")
//   thinking   NAME's last poll handed it new messages and it has neither
//              posted nor polled empty since: it is reading or replying
//
// An agent can also say what it is doing ("working"), by posting a message
// that starts with /status (handled here, never written to the note, so it
// works from any CLI version) or through POST /api/chat/status. New agent
// behaviours belong in this same shape: inferred from calls agents already
// make, or a slash command in an ordinary post, so nobody has to update a
// CLI to get them.
//
// In memory only: presence is not content, nothing is written to the note
// and nothing survives a restart. Per process, like the note lock: chat is
// not offered on the multi-replica app tier (ChatEnabled).

const (
	chatStatusTTL     = 2 * time.Minute  // an explicit status, unless set again
	chatListenWindow  = 20 * time.Second // wait polls every few seconds
	chatThinkingMax   = 15 * time.Minute // an agent that never comes back is not "thinking" forever
	maxChatStatusText = 120              // characters, after trimming to one line
)

// Kinds of ChatStatus, highest priority first.
const (
	statusWorking   = "working"
	statusThinking  = "thinking"
	statusListening = "listening"
)

// ChatStatus is one poster's current presence as the chat view shows it.
type ChatStatus struct {
	Author string    `json:"author"`
	Via    string    `json:"via,omitempty"`
	Kind   string    `json:"kind"`
	Text   string    `json:"text,omitempty"` // only for "working"
	Since  time.Time `json:"since"`
	// Context is the poster's last /context report, if any (chat_context.go).
	Context *ChatContext `json:"context,omitempty"`
}

type chatPresence struct {
	via          string
	text         string // explicit status
	textSince    time.Time
	textUntil    time.Time
	lastPoll     time.Time
	thinkingFrom time.Time // zero unless the last poll handed it new messages
}

type chatStatusStore struct {
	mu  sync.Mutex
	m   map[string]map[string]*chatPresence // "ns\x00path" -> author -> presence
	ctx map[string]map[string]ChatContext   // "ns\x00path" -> author -> last /context
}

func newChatStatusStore() *chatStatusStore {
	return &chatStatusStore{m: map[string]map[string]*chatPresence{}, ctx: map[string]map[string]ChatContext{}}
}

func chatStatusKey(ns, relPath string) string { return ns + "\x00" + relPath }

// get returns (creating) the entry for an author. Caller holds mu.
func (s *chatStatusStore) get(ns, relPath, author, via string) *chatPresence {
	k := chatStatusKey(ns, relPath)
	if s.m[k] == nil {
		s.m[k] = map[string]*chatPresence{}
	}
	p := s.m[k][author]
	if p == nil {
		p = &chatPresence{}
		s.m[k][author] = p
	}
	p.via = via
	return p
}

// set records an explicit status. Refreshing the same text keeps its start
// time, so "3 min" means the task, not the last refresh.
func (s *chatStatusStore) set(ns, relPath, author, via, text string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.get(ns, relPath, author, via)
	if p.text != text || !now.Before(p.textUntil) {
		p.textSince = now
	}
	p.text = text
	p.textUntil = now.Add(chatStatusTTL)
}

// clearText drops an explicit status (an empty /status, or a post).
func (s *chatStatusStore) clearText(ns, relPath, author string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.m[chatStatusKey(ns, relPath)][author]; p != nil {
		p.text, p.textUntil = "", time.Time{}
	}
}

// polled records a wait/read poll by author; gotNew says whether it was
// handed messages, which means it is now reading or working on a reply. An
// empty poll means it is back to waiting, so it also drops an explicit
// status: an agent that set "/status running tests" and went back to wait
// without posting would otherwise read as working for up to 2 minutes.
func (s *chatStatusStore) polled(ns, relPath, author, via string, gotNew bool, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.get(ns, relPath, author, via)
	p.lastPoll = now
	if gotNew {
		if p.thinkingFrom.IsZero() {
			p.thinkingFrom = now
		}
	} else {
		p.thinkingFrom = time.Time{}
		p.text, p.textUntil = "", time.Time{}
	}
}

// posted: the post is the result of whatever the author was doing. A post
// alone does not make anyone "listening" (a one-off post from a script is
// not someone waiting); only a wait poll does, so an agent that was already
// listening stays so until its next poll renews it.
func (s *chatStatusStore) posted(ns, relPath, author string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.m[chatStatusKey(ns, relPath)][author]; p != nil {
		p.text, p.textUntil = "", time.Time{}
		p.thinkingFrom = time.Time{}
	}
}

// list returns everyone present, busiest first, pruning the stale.
func (s *chatStatusStore) list(ns, relPath string, now time.Time) []ChatStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := chatStatusKey(ns, relPath)
	out := []ChatStatus{}
	for author, p := range s.m[k] {
		switch {
		case p.text != "" && now.Before(p.textUntil):
			out = append(out, ChatStatus{Author: author, Via: p.via, Kind: statusWorking, Text: p.text, Since: p.textSince})
		case !p.thinkingFrom.IsZero() && now.Sub(p.thinkingFrom) < chatThinkingMax:
			out = append(out, ChatStatus{Author: author, Via: p.via, Kind: statusThinking, Since: p.thinkingFrom})
		case !p.lastPoll.IsZero() && now.Sub(p.lastPoll) < chatListenWindow:
			out = append(out, ChatStatus{Author: author, Via: p.via, Kind: statusListening, Since: p.lastPoll})
		default:
			delete(s.m[k], author)
		}
	}
	if len(s.m[k]) == 0 {
		delete(s.m, k)
	}
	ctx := s.contextsLocked(ns, relPath, now)
	for i := range out {
		if c, ok := ctx[out[i].Author]; ok {
			out[i].Context = &c
		}
	}
	rank := map[string]int{statusWorking: 0, statusThinking: 1, statusListening: 2}
	sort.Slice(out, func(i, j int) bool {
		if rank[out[i].Kind] != rank[out[j].Kind] {
			return rank[out[i].Kind] < rank[out[j].Kind]
		}
		return out[i].Author < out[j].Author
	})
	return out
}

// busyHeader is the X-Chat-Working value for format=text reads:
// "codxu: reviewing the PR | lead-qa: thinking". Listening is left out; the
// summary line already names who is in the chat.
func busyHeader(st []ChatStatus) string {
	parts := []string{}
	for _, s := range st {
		switch s.Kind {
		case statusWorking:
			parts = append(parts, s.Author+": "+s.Text)
		case statusThinking:
			parts = append(parts, s.Author+": thinking")
		}
	}
	return strings.Join(parts, " | ")
}

// statusText reduces a body to one short, terminal-safe line.
func statusText(raw string) string {
	t := strings.Join(strings.Fields(terminalSafe(raw)), " ")
	if r := []rune(t); len(r) > maxChatStatusText {
		t = string(r[:maxChatStatusText-1]) + "…"
	}
	return t
}

// slashStatus recognises a post that is a /status command and returns the
// status text ("" clears). "/statuses" or "/status-x" are ordinary messages.
func slashStatus(text string) (string, bool) {
	if !strings.HasPrefix(text, "/status") {
		return "", false
	}
	rest := text[len("/status"):]
	if rest != "" && rest[0] != ' ' && rest[0] != '\t' && rest[0] != '\n' {
		return "", false
	}
	return statusText(rest), true
}

// applyStatus sets or clears the caller's explicit status after the usual
// chat checks. It answers the request itself.
func (h *ChatHandler) applyStatus(w http.ResponseWriter, r *http.Request, ns, relPath, text string, okStatus int) {
	doc, ok := h.readChatDoc(w, r, ns, relPath)
	if !ok {
		return
	}
	label, via, ok := h.author(r)
	if !ok {
		chatJSONError(w, http.StatusForbidden, "cannot attribute this status to a user")
		return
	}
	state := "status cleared"
	if text == "" {
		h.status.clearText(ns, relPath, label)
	} else {
		h.status.set(ns, relPath, label, via, text, h.now())
		state = "status set"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(okStatus)
	// count keeps an older CLI's "posted #N" line meaningful when the status
	// arrived as a /status post.
	io.WriteString(w, `{"status":"`+state+`","count":`+strconv.Itoa(len(doc.Messages))+`}`)
}

// readChatDoc reads the note a status or context report is for, answering
// the request itself when it is missing or not a chat.
func (h *ChatHandler) readChatDoc(w http.ResponseWriter, r *http.Request, ns, relPath string) (ChatDoc, bool) {
	data, err := h.store.ReadFile(r.Context(), ns, relPath)
	if errors.Is(err, storage.ErrNotExist) {
		chatJSONError(w, http.StatusNotFound, "no chat at this path")
		return ChatDoc{}, false
	} else if err != nil {
		chatJSONError(w, http.StatusInternalServerError, "failed to read chat")
		return ChatDoc{}, false
	}
	doc := ParseChat(string(data))
	if !doc.IsChat {
		chatJSONError(w, http.StatusBadRequest, "this note is not a chat — convert it first")
		return ChatDoc{}, false
	}
	return doc, true
}

// HandleStatus: POST /api/chat/status?ns=&path=&as= with the status as the
// body. An empty body clears it. Guarded like posting. The same thing is
// reachable from any CLI as a post that starts with /status.
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
	h.applyStatus(w, r, ns, relPath, statusText(string(body)), http.StatusOK)
}
