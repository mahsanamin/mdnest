package handlers

import (
	"io"
	"net/http"
	"sort"
	"time"
)

// Notices: an agent that is stuck or stopped, with no buttons. Posted by
// `mdnest approval notify` (the agent's Notification hook) and by
// `mdnest chat keepalive` when it lets a chat agent stop. They sit in the
// approvals list until dismissed, until the agent carries on (`approval
// done` clears its session's notices), or for 12 hours.
//
//	POST   /api/approvals/notices?agent=&cli=[&as=][&machine=][&chat=][&type=]   body = the hook input
//	DELETE /api/approvals/notices/<id>
//
// A permission_prompt notice is skipped while the same session has an open
// card: the card already asks. When no card was made (the tool is not in
// TOOLS, NEVER_REMOTE matched), the notice is the only thing that tells the
// owner the agent is waiting in its terminal.

const (
	noticeKeep          = 12 * time.Hour
	noticeMaxPerAccount = 50
	noticeMaxMessage    = 200
	noticeChatEvery     = 5 * time.Minute // one chat line per session and kind
)

type notice struct {
	ID        string
	owner     string
	Agent     string
	Name      string
	Machine   string
	SessionID string
	Type      string
	Message   string
	ChatNS    string
	ChatPath  string
	Created   time.Time
}

// NoticeView is what the UI reads.
type NoticeView struct {
	ID        string    `json:"id"`
	Agent     string    `json:"agent"`
	AgentName string    `json:"agentName"`
	Name      string    `json:"name,omitempty"`
	Machine   string    `json:"machine,omitempty"`
	Type      string    `json:"type"`
	Text      string    `json:"text"`
	Message   string    `json:"message,omitempty"`
	Chat      string    `json:"chat,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// agentLabel is how a card or notice names the agent: "Builder (Claude Code
// on mac-mini)" when the agent has a chat name, else "Claude Code on
// mac-mini".
func agentLabel(name, agent, machine string) string {
	kind := approvalAgents[agent]
	if kind == "" {
		kind = agent
	}
	if machine != "" {
		kind += " on " + machine
	}
	if name == "" {
		return kind
	}
	return name + " (" + kind + ")"
}

// noticeText is the one line a notice says.
func noticeText(n *notice) string {
	who := agentLabel(n.Name, n.Agent, n.Machine)
	switch n.Type {
	case "permission_prompt":
		return who + " is waiting for permission in its terminal"
	case "idle_prompt":
		return who + " is waiting for input"
	case "stopped":
		return who + " stopped"
	}
	if n.Message != "" {
		return who + ": " + n.Message
	}
	return who + " needs attention"
}

// chatLine is the neutral line posted in the agent's chat: no message text,
// which comes from the agent and could carry anything.
func chatLine(n *notice) string {
	who := n.Name
	if who == "" {
		who = approvalAgents[n.Agent]
	}
	if n.Machine != "" {
		who += " on " + n.Machine
	}
	if n.Type == "stopped" {
		return who + " stopped."
	}
	return who + " is waiting."
}

func (h *ApprovalHandler) noticeViewLocked(n *notice) NoticeView {
	v := NoticeView{ID: n.ID, Agent: n.Agent, AgentName: approvalAgents[n.Agent], Name: n.Name, Machine: n.Machine,
		Type: n.Type, Text: noticeText(n), Message: n.Message, CreatedAt: n.Created.UTC()}
	if n.ChatNS != "" {
		v.Chat = n.ChatNS + "/" + n.ChatPath
	}
	return v
}

func (h *ApprovalHandler) sweepNoticesLocked() {
	cutoff := h.now().Add(-noticeKeep)
	for id, n := range h.notices {
		if n.Created.Before(cutoff) {
			delete(h.notices, id)
		}
	}
}

func (h *ApprovalHandler) noticesFor(owner string) []NoticeView {
	out := []NoticeView{}
	for _, n := range h.notices {
		if n.owner == owner {
			out = append(out, h.noticeViewLocked(n))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (h *ApprovalHandler) handleNotices(w http.ResponseWriter, r *http.Request, owner, id string) {
	switch {
	case id == "" && r.Method == http.MethodPost:
		h.createNotice(w, r, owner)
	case id != "" && r.Method == http.MethodDelete:
		h.mu.Lock()
		n := h.notices[id]
		if n == nil || n.owner != owner {
			h.mu.Unlock()
			approvalError(w, http.StatusNotFound, "no such notice")
			return
		}
		delete(h.notices, id)
		h.mu.Unlock()
		approvalJSON(w, http.StatusOK, map[string]string{"status": "dismissed"})
	default:
		approvalError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *ApprovalHandler) createNotice(w http.ResponseWriter, r *http.Request, owner string) {
	q := r.URL.Query()
	if !versionAtLeast(q.Get("cli"), ApprovalMinCLI) {
		approvalError(w, http.StatusUpgradeRequired, "agent notices need mdnest CLI "+ApprovalMinCLI+" or newer; run mdnest update")
		return
	}
	agent := q.Get("agent")
	if agent == "" {
		agent = "claude-code"
	}
	if _, known := approvalAgents[agent]; !known {
		approvalError(w, http.StatusBadRequest, "unknown agent (claude-code or codex)")
		return
	}
	var chatNS, chatPath string
	if ref := q.Get("chat"); ref != "" {
		var ok bool
		if chatNS, chatPath, ok = splitChatRef(ref); !ok {
			approvalError(w, http.StatusBadRequest, "chat must be ns/path/to/chat.md")
			return
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, approvalMaxBody+1))
	if err != nil || len(body) > approvalMaxBody {
		approvalError(w, http.StatusRequestEntityTooLarge, "hook input too large (max 64KB)")
		return
	}
	fields, err := strictObject(body)
	if err != nil {
		approvalError(w, http.StatusBadRequest, "body must be the agent's hook input JSON ("+err.Error()+")")
		return
	}
	session := jsonString(fields["session_id"])
	kind := jsonString(fields["notification_type"])
	if jsonString(fields["hook_event_name"]) == "Stop" || q.Get("type") == "stopped" {
		kind = "stopped"
	}
	if kind == "" {
		kind = "notice"
	}
	kind = cleanMachineLabel(kind)
	message := visibleText(jsonString(fields["message"]))
	if len([]rune(message)) > noticeMaxMessage {
		message = string([]rune(message)[:noticeMaxMessage]) + "..."
	}
	id, err := newApprovalID()
	if err != nil {
		approvalError(w, http.StatusInternalServerError, "could not create an id")
		return
	}
	n := &notice{ID: id, owner: owner, Agent: agent, Name: sanitizeChatLabel(q.Get("as")),
		Machine: cleanMachineLabel(q.Get("machine")), SessionID: session, Type: kind, Message: message,
		ChatNS: chatNS, ChatPath: chatPath, Created: h.now()}

	h.mu.Lock()
	h.sweepLocked()
	h.sweepNoticesLocked()
	// The card already asks: no second item for the same wait.
	if kind == "permission_prompt" && session != "" {
		for _, a := range h.items {
			if a.owner == owner && a.SessionID == session && h.stateLocked(a) == ApprovalPending {
				h.mu.Unlock()
				approvalJSON(w, http.StatusOK, map[string]any{"skipped": "an approval card is already open for this session"})
				return
			}
		}
	}
	// One notice per session and kind: a repeat replaces the old one, and
	// posts in the chat at most every few minutes.
	postInChat := true
	for oid, o := range h.notices {
		if o.owner == owner && session != "" && o.SessionID == session && o.Type == kind {
			if h.now().Sub(o.Created) < noticeChatEvery {
				postInChat = false
			}
			delete(h.notices, oid)
		}
	}
	mine := 0
	var oldest *notice
	for _, o := range h.notices {
		if o.owner == owner {
			mine++
			if oldest == nil || o.Created.Before(oldest.Created) {
				oldest = o
			}
		}
	}
	if mine >= noticeMaxPerAccount && oldest != nil {
		delete(h.notices, oldest.ID)
	}
	h.notices[id] = n
	h.mu.Unlock()

	if postInChat && n.ChatNS != "" && h.chat != nil && h.canWrite != nil && h.canWrite(r, n.ChatNS, n.ChatPath) {
		as := n.Name
		if as == "" {
			as = n.Agent
		}
		h.chat.PostNotice(r, n.ChatNS, n.ChatPath, as, chatLine(n))
	}
	approvalJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// clearSessionNoticesLocked drops a session's notices once the agent carries
// on (approval done). Callers hold h.mu.
func (h *ApprovalHandler) clearSessionNoticesLocked(owner, session string) int {
	n := 0
	for id, o := range h.notices {
		if o.owner == owner && o.SessionID == session {
			delete(h.notices, id)
			n++
		}
	}
	return n
}
