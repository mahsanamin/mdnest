package handlers

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// How much of its context window an agent has used, shown by its name in the
// chat so a person can see which agent is close to full and needs a fresh
// start. The agent reports it itself with a post that starts with /context
// ("/context 42%", "/context 87k/200k"): an agent is the only one that knows,
// and a slash command in an ordinary post works from any CLI version and from
// MCP post_chat, the same rule as /status (chat_status.go).
//
// Like presence it is in memory only and never written to the note. It
// outlives presence (an agent that stopped polling still shows its last
// figure) but not forever: chatContextTTL.

const chatContextTTL = time.Hour

// ChatContext is one poster's last report. Pct is -1 when only a token count
// was given.
type ChatContext struct {
	Used  int       `json:"used,omitempty"`  // tokens, when given
	Total int       `json:"total,omitempty"` // tokens, when given
	Pct   int       `json:"pct"`
	At    time.Time `json:"at"`
}

// errContextFormat is the answer to a /context the server cannot read, worded
// for the agent that sent it.
const errContextFormat = `could not read that: use "/context 42%" or "/context 87k/200k"`

// slashContext recognises a post that is a /context command and returns its
// text ("" clears). "/contexts" or "/context-x" are ordinary messages.
func slashContext(text string) (string, bool) {
	if !strings.HasPrefix(text, "/context") {
		return "", false
	}
	rest := text[len("/context"):]
	if rest != "" && rest[0] != ' ' && rest[0] != '\t' && rest[0] != '\n' {
		return "", false
	}
	return strings.TrimSpace(rest), true
}

// parseChatContext reads "42%", "42", "87k/200k", "87,000 / 200,000 tokens",
// "87k of 200k" or a bare "87k" (used only, no percentage).
func parseChatContext(raw string) (ChatContext, bool) {
	s := strings.ToLower(strings.Join(strings.Fields(raw), " "))
	for _, suffix := range []string{" tokens used", " tokens", " used"} {
		s = strings.TrimSuffix(s, suffix)
	}
	s = strings.TrimSpace(s)
	if strings.HasSuffix(s, "%") {
		pct, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, "%")), 64)
		if err != nil || pct < 0 || pct > 100 {
			return ChatContext{}, false
		}
		return ChatContext{Pct: int(math.Round(pct))}, true
	}
	sep := ""
	for _, cand := range []string{"/", " of "} {
		if strings.Contains(s, cand) {
			sep = cand
			break
		}
	}
	if sep == "" {
		// A plain number up to 100 is a percentage; anything with a unit or
		// above 100 is a token count.
		if v, err := strconv.ParseFloat(s, 64); err == nil && v >= 0 && v <= 100 {
			return ChatContext{Pct: int(math.Round(v))}, true
		}
		used, ok := parseTokenCount(s)
		if !ok {
			return ChatContext{}, false
		}
		return ChatContext{Used: used, Pct: -1}, true
	}
	parts := strings.SplitN(s, sep, 2)
	used, ok1 := parseTokenCount(parts[0])
	total, ok2 := parseTokenCount(parts[1])
	if !ok1 || !ok2 || total <= 0 || used > total {
		return ChatContext{}, false
	}
	return ChatContext{Used: used, Total: total, Pct: int(math.Round(float64(used) * 100 / float64(total)))}, true
}

// parseTokenCount reads "87k", "87.5k", "1.2m", "87000" or "87,000".
func parseTokenCount(s string) (int, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), ",", "")
	mult := 1.0
	switch {
	case strings.HasSuffix(s, "k"):
		mult, s = 1e3, strings.TrimSuffix(s, "k")
	case strings.HasSuffix(s, "m"):
		mult, s = 1e6, strings.TrimSuffix(s, "m")
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || v < 0 || v*mult > 1e9 {
		return 0, false
	}
	return int(math.Round(v * mult)), true
}

// setContext records a report; clear drops it.
func (s *chatStatusStore) setContext(ns, relPath, author string, c ChatContext) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := chatStatusKey(ns, relPath)
	if s.ctx[k] == nil {
		s.ctx[k] = map[string]ChatContext{}
	}
	s.ctx[k][author] = c
}

func (s *chatStatusStore) clearContext(ns, relPath, author string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.ctx[chatStatusKey(ns, relPath)], author)
}

// contexts returns every current report for the chat, pruning old ones.
func (s *chatStatusStore) contexts(ns, relPath string, now time.Time) map[string]ChatContext {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contextsLocked(ns, relPath, now)
}

func (s *chatStatusStore) contextsLocked(ns, relPath string, now time.Time) map[string]ChatContext {
	k := chatStatusKey(ns, relPath)
	out := map[string]ChatContext{}
	for author, c := range s.ctx[k] {
		if now.Sub(c.At) >= chatContextTTL {
			delete(s.ctx[k], author)
			continue
		}
		out[author] = c
	}
	if len(s.ctx[k]) == 0 {
		delete(s.ctx, k)
	}
	return out
}

// applyContext sets or clears the caller's context report after the usual
// chat checks. It answers the request itself.
func (h *ChatHandler) applyContext(w http.ResponseWriter, r *http.Request, ns, relPath, text string) {
	doc, ok := h.readChatDoc(w, r, ns, relPath)
	if !ok {
		return
	}
	label, _, ok := h.author(r)
	if !ok {
		chatJSONError(w, http.StatusForbidden, "cannot attribute this report to a user")
		return
	}
	state := "context cleared"
	if text == "" {
		h.status.clearContext(ns, relPath, label)
	} else {
		c, ok := parseChatContext(text)
		if !ok {
			chatJSONError(w, http.StatusBadRequest, errContextFormat)
			return
		}
		c.At = h.now()
		h.status.setContext(ns, relPath, label, c)
		state = "context set"
	}
	w.Header().Set("Content-Type", "application/json")
	// count keeps an older CLI's "posted #N" line meaningful.
	io.WriteString(w, fmt.Sprintf(`{"status":%q,"count":%d}`, state, len(doc.Messages)))
}
