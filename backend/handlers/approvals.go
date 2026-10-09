package handlers

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mdnest/mdnest/backend/middleware"
)

// Agent approvals (ENABLE_AGENT_APPROVALS, experimental, off by default).
//
// An agent's PermissionRequest hook runs `mdnest approval request`, which
// posts the hook input here and long-polls for a decision. The owner presses
// Allow or Deny in a browser, and the hook prints the text this server built
// for that agent. Routes:
//
//	POST /api/approvals?agent=&chat=ns/path&machine=&cli=&ttl=   create (body = hook input JSON)
//	GET  /api/approvals                                          the caller's pending requests
//	GET  /api/approvals/<id>                                     one request (owner only)
//	GET  /api/approvals/<id>/wait                                long poll: 204 pending, 200 hook output, 410 gone
//	POST /api/approvals/<id>/decide                              browser login only, owner only
//	POST /api/approvals/close?session=                           answered in the terminal
//
// State lives in memory only. A restart drops every request and the waiting
// hook falls back to the agent's own terminal prompt, which is already on
// screen. Nothing here ever allows or denies on its own.

const (
	approvalMaxBody       = 64 << 10 // the hook input, as the agent sent it
	approvalMaxPending    = 20       // per account
	approvalDefaultTTL    = 10 * time.Minute
	approvalMinTTL        = time.Minute
	approvalMaxTTL        = 60 * time.Minute
	approvalMaxWait       = 50 * time.Second // one long poll
	approvalKeepDecided   = time.Hour        // a decided card stays readable this long after its expiry
	approvalMaxReason     = 500              // characters
	approvalMaxMachine    = 60
	approvalDefaultDenial = "Denied from mdnest."
)

// ApprovalMinCLI is the oldest `mdnest` CLI that may create a request.
// Compared on major.minor.patch only, so the 4.8.5-dev build that develop
// carries counts as 4.8.5.
const ApprovalMinCLI = "4.8.5"

// Approval states. "closed" means the question was answered in the terminal
// (or the agent moved on) before anyone pressed a button here.
const (
	ApprovalPending = "pending"
	ApprovalAllowed = "allowed"
	ApprovalDenied  = "denied"
	ApprovalExpired = "expired"
	ApprovalClosed  = "closed"
)

// approvalAgents are the agents whose hook output this server can build.
// Both take the same JSON in v1; a new agent is a new case in hookOutput.
var approvalAgents = map[string]string{
	"claude-code": "Claude Code",
	"codex":       "Codex",
}

type approval struct {
	ID          string
	owner       string // ownerKey(); never served
	OwnerName   string
	Agent       string
	Machine     string
	SessionID   string
	ToolName    string
	Command     string
	Description string
	Cwd         string
	ChatNS      string
	ChatPath    string
	Created     time.Time
	Expires     time.Time
	state       string
	DecidedBy   string
	DecidedAt   time.Time
	Reason      string
	changed     chan struct{} // closed when the state leaves pending
}

// ApprovalView is what the UI reads.
type ApprovalView struct {
	ID          string    `json:"id"`
	Agent       string    `json:"agent"`
	AgentName   string    `json:"agentName"`
	Machine     string    `json:"machine"`
	ToolName    string    `json:"toolName"`
	Command     string    `json:"command"`
	Description string    `json:"description,omitempty"`
	Cwd         string    `json:"cwd,omitempty"`
	Chat        string    `json:"chat,omitempty"` // ns/path
	State       string    `json:"state"`
	CreatedAt   time.Time `json:"createdAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
	DecidedBy   string    `json:"decidedBy,omitempty"`
	DecidedAt   string    `json:"decidedAt,omitempty"`
	Reason      string    `json:"reason,omitempty"`
}

// approvalChatPoster puts the card's message in a chat (ChatHandler.PostNotice).
type approvalChatPoster interface {
	PostNotice(r *http.Request, ns, relPath, as, text string) error
}

type ApprovalHandler struct {
	mu        sync.Mutex
	items     map[string]*approval
	multiMode bool
	now       func() time.Time
	maxWait   time.Duration
	// canWrite decides whether the request's account may post in the chat
	// it named. Required: nil means no card is ever posted in a chat.
	canWrite func(r *http.Request, ns, path string) bool
	chat     approvalChatPoster // nil when chat is off
}

// NewApprovalHandler: canWrite is the write check used before posting a card
// in a chat. Pass nil to never post (the request still shows in the list).
func NewApprovalHandler(multiMode bool, canWrite func(*http.Request, string, string) bool) *ApprovalHandler {
	return &ApprovalHandler{items: map[string]*approval{}, multiMode: multiMode, now: time.Now,
		maxWait: approvalMaxWait, canWrite: canWrite}
}

// SetTiming replaces the clock and the longest single long poll (tests).
func (h *ApprovalHandler) SetTiming(now func() time.Time, maxWait time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if now != nil {
		h.now = now
	}
	if maxWait > 0 {
		h.maxWait = maxWait
	}
}

// SetChat lets a request that names a chat post its card there.
func (h *ApprovalHandler) SetChat(c approvalChatPoster) { h.chat = c }

// ApprovalsEnabled decides ENABLE_AGENT_APPROVALS: off unless set to true,
// and always off on the multi-replica app role, where a request created on
// one replica could be waited on or decided on another.
func ApprovalsEnabled(setting, role string) bool {
	if role == "app" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}

func approvalJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func approvalError(w http.ResponseWriter, status int, msg string) {
	approvalJSON(w, status, map[string]string{"error": msg})
}

// ownerKey names the account a request belongs to. Single mode has one
// owner and no user context. In multi mode a request without one is a token
// that maps to nobody, and gets no key at all.
func (h *ApprovalHandler) ownerKey(r *http.Request) (key, name string, ok bool) {
	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		if h.multiMode {
			return "", "", false
		}
		return "single", "", true
	}
	return "user:" + strconv.Itoa(uc.ID), uc.Username, true
}

// Handle dispatches every /api/approvals route.
func (h *ApprovalHandler) Handle(w http.ResponseWriter, r *http.Request) {
	owner, ownerName, ok := h.ownerKey(r)
	if !ok {
		approvalError(w, http.StatusForbidden, "this request is not tied to an account")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/approvals"), "/")
	parts := strings.Split(rest, "/")
	switch {
	case rest == "":
		switch r.Method {
		case http.MethodGet:
			h.list(w, owner)
		case http.MethodPost:
			h.create(w, r, owner, ownerName)
		default:
			approvalError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case rest == "close":
		if r.Method != http.MethodPost {
			approvalError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		h.close(w, r, owner)
	case len(parts) == 1:
		if r.Method != http.MethodGet {
			approvalError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		h.get(w, parts[0], owner)
	case len(parts) == 2 && parts[1] == "wait":
		if r.Method != http.MethodGet {
			approvalError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		h.wait(w, r, parts[0], owner)
	case len(parts) == 2 && parts[1] == "decide":
		if r.Method != http.MethodPost {
			approvalError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		h.decide(w, r, parts[0], owner, ownerName)
	default:
		approvalError(w, http.StatusNotFound, "not found")
	}
}

// versionAtLeast compares major.minor.patch and ignores any pre-release
// suffix ("4.8.5-dev" counts as 4.8.5). An unparseable version is too old.
func versionAtLeast(have, want string) bool {
	parse := func(v string) ([3]int, bool) {
		var out [3]int
		v = strings.TrimPrefix(strings.TrimSpace(v), "v")
		if i := strings.IndexAny(v, "-+"); i >= 0 {
			v = v[:i]
		}
		f := strings.Split(v, ".")
		if len(f) != 3 {
			return out, false
		}
		for i, s := range f {
			n, err := strconv.Atoi(s)
			if err != nil || n < 0 {
				return out, false
			}
			out[i] = n
		}
		return out, true
	}
	h, ok := parse(have)
	if !ok {
		return false
	}
	wv, _ := parse(want)
	for i := 0; i < 3; i++ {
		if h[i] != wv[i] {
			return h[i] > wv[i]
		}
	}
	return true
}

func newApprovalID() (string, error) {
	b := make([]byte, 16) // 128 bits
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// hookInput is the part of a PermissionRequest (or PostToolUse) input the
// server reads. The rest is ignored.
type hookInput struct {
	SessionID     string
	Cwd           string
	HookEventName string
	ToolName      string
	ToolInput     json.RawMessage
}

// strictObject decodes one JSON object into its members, with EXACT key
// names. A duplicate key, or two keys that differ only in case, is an error.
// encoding/json would otherwise take the last duplicate and match struct
// fields case-insensitively, so the server could read a different command
// from the one the agent runs, and the card would show the wrong thing.
func strictObject(raw []byte) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("not a JSON object")
	}
	out := map[string]json.RawMessage{}
	seen := map[string]bool{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string)
		folded := strings.ToLower(key)
		if seen[folded] {
			return nil, errors.New("duplicate key " + strconv.Quote(key))
		}
		seen[folded] = true
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out[key] = v
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, errors.New("not a JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the JSON object")
	}
	return out, nil
}

func jsonString(raw json.RawMessage) string {
	var s string
	json.Unmarshal(raw, &s)
	return s
}

// parseHookInput reads the fields the server needs, strictly (see
// strictObject). tool_input, when it is an object, is checked the same way.
func parseHookInput(body []byte) (hookInput, error) {
	var in hookInput
	m, err := strictObject(body)
	if err != nil {
		return in, err
	}
	in.SessionID = jsonString(m["session_id"])
	in.Cwd = jsonString(m["cwd"])
	in.HookEventName = jsonString(m["hook_event_name"])
	in.ToolName = jsonString(m["tool_name"])
	in.ToolInput = m["tool_input"]
	if t := bytes.TrimSpace(in.ToolInput); len(t) > 0 && t[0] == '{' {
		if _, err := strictObject(t); err != nil {
			return in, errors.New("tool_input: " + err.Error())
		}
	}
	return in, nil
}

// commandOf is what the person approves: the Bash command as the agent will
// run it, or, for any other tool, its input as JSON. Never the description,
// which the model writes and which can say anything. tool_input has already
// been through strictObject.
func commandOf(toolInput json.RawMessage) (command, description string) {
	fields, err := strictObject(toolInput)
	if err != nil {
		return strings.TrimSpace(string(toolInput)), ""
	}
	if raw, ok := fields["description"]; ok {
		json.Unmarshal(raw, &description)
	}
	if raw, ok := fields["command"]; ok {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s, description
		}
		// Codex can send the command as an argv array. Each element is shell
		// quoted, so ["bash","-lc","a; b"] does not read as two commands.
		var argv []string
		if json.Unmarshal(raw, &argv) == nil {
			quoted := make([]string, len(argv))
			for i, a := range argv {
				quoted[i] = shellQuote(a)
			}
			return strings.Join(quoted, " "), description
		}
	}
	var buf bytes.Buffer
	if json.Indent(&buf, toolInput, "", "  ") == nil {
		return buf.String(), description
	}
	return string(toolInput), description
}

// shellQuote leaves a plain word alone and single-quotes anything else.
func shellQuote(s string) string {
	if s != "" && strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./=:,@%+", r))
	}) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// visibleText makes every character that could change how the command
// LOOKS without changing what runs show up as an escape, so what the person
// reads is what the agent runs. It is an allowlist: printable ASCII, newline
// and tab, and non-ASCII letters, numbers, punctuation and symbols are kept.
// Everything else is escaped: control and format characters (bidi overrides,
// zero-width characters, tag characters, soft hyphen), every space that is
// not ASCII space (a no-break space looks like a word break and is not one),
// line and paragraph separators, combining marks, private-use and unassigned
// code points. A command written in another script still reads normally.
func visibleText(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n' || r == '\t' || (r >= 0x20 && r < 0x7F):
			b.WriteRune(r)
		case r >= 0x80 && r != utf8.RuneError && unicode.In(r, unicode.L, unicode.N, unicode.P, unicode.S):
			b.WriteRune(r)
		default:
			fmt.Fprintf(&b, "\\u{%04X}", r)
		}
	}
	return b.String()
}

func cleanMachineLabel(s string) string {
	s = sanitizeChatLabel(s)
	if len([]rune(s)) > approvalMaxMachine {
		s = string([]rune(s)[:approvalMaxMachine])
	}
	return s
}

// splitChatRef turns "ns/path/to/chat.md" into its namespace and a canonical
// relative path, or reports that it is not one.
func splitChatRef(ref string) (ns, relPath string, ok bool) {
	ref = strings.TrimPrefix(ref, "/")
	i := strings.Index(ref, "/")
	if i <= 0 {
		return "", "", false
	}
	ns, raw := ref[:i], ref[i+1:]
	if strings.HasPrefix(ns, ".") || strings.ContainsAny(ns, `\`) {
		return "", "", false
	}
	rel, ok := SafeRelPath(raw)
	if !ok || rel != raw || !strings.HasSuffix(strings.ToLower(rel), ".md") {
		return "", "", false
	}
	return ns, rel, true
}

// state reports a request's state, expiring a pending one whose time is up.
// Callers hold h.mu.
func (h *ApprovalHandler) stateLocked(a *approval) string {
	if a.state == ApprovalPending && !h.now().Before(a.Expires) {
		a.state = ApprovalExpired
		close(a.changed)
	}
	return a.state
}

// sweepLocked forgets requests well past their expiry. Callers hold h.mu.
func (h *ApprovalHandler) sweepLocked() {
	now := h.now()
	for id, a := range h.items {
		h.stateLocked(a)
		if now.After(a.Expires.Add(approvalKeepDecided)) {
			delete(h.items, id)
		}
	}
}

func (h *ApprovalHandler) viewLocked(a *approval) ApprovalView {
	v := ApprovalView{ID: a.ID, Agent: a.Agent, AgentName: approvalAgents[a.Agent], Machine: a.Machine,
		ToolName: a.ToolName, Command: a.Command, Description: a.Description, Cwd: a.Cwd,
		State: h.stateLocked(a), CreatedAt: a.Created.UTC(), ExpiresAt: a.Expires.UTC(),
		DecidedBy: a.DecidedBy, Reason: a.Reason}
	if a.ChatNS != "" {
		v.Chat = a.ChatNS + "/" + a.ChatPath
	}
	if !a.DecidedAt.IsZero() {
		v.DecidedAt = a.DecidedAt.UTC().Format(time.RFC3339)
	}
	return v
}

// lookupLocked finds a request the caller owns. Someone else's request is
// reported exactly like a missing one, so its existence does not leak.
func (h *ApprovalHandler) lookupLocked(id, owner string) *approval {
	a := h.items[id]
	if a == nil || a.owner != owner {
		return nil
	}
	return a
}

func (h *ApprovalHandler) create(w http.ResponseWriter, r *http.Request, owner, ownerName string) {
	q := r.URL.Query()
	if !versionAtLeast(q.Get("cli"), ApprovalMinCLI) {
		approvalError(w, http.StatusUpgradeRequired, "agent approvals need mdnest CLI "+ApprovalMinCLI+" or newer; run mdnest update")
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
	ttl := approvalDefaultTTL
	if s := q.Get("ttl"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil {
			approvalError(w, http.StatusBadRequest, "ttl must be a number of seconds")
			return
		}
		ttl = time.Duration(n) * time.Second
		if ttl < approvalMinTTL {
			ttl = approvalMinTTL
		}
		if ttl > approvalMaxTTL {
			ttl = approvalMaxTTL
		}
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
	if err != nil {
		approvalError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	if len(body) > approvalMaxBody {
		approvalError(w, http.StatusRequestEntityTooLarge, "hook input too large (max 64KB)")
		return
	}
	in, err := parseHookInput(body)
	if err != nil || len(in.ToolInput) == 0 {
		msg := "body must be the agent's hook input JSON, with tool_input"
		if err != nil {
			msg += " (" + err.Error() + ")"
		}
		approvalError(w, http.StatusBadRequest, msg)
		return
	}
	command, description := commandOf(in.ToolInput)
	command, description = visibleText(command), visibleText(description)
	if strings.TrimSpace(command) == "" {
		approvalError(w, http.StatusBadRequest, "the hook input names no command")
		return
	}
	id, err := newApprovalID()
	if err != nil {
		approvalError(w, http.StatusInternalServerError, "could not create an id")
		return
	}
	now := h.now()
	a := &approval{ID: id, owner: owner, OwnerName: ownerName, Agent: agent,
		Machine: cleanMachineLabel(q.Get("machine")), SessionID: in.SessionID,
		ToolName: in.ToolName, Command: command, Description: description, Cwd: in.Cwd,
		ChatNS: chatNS, ChatPath: chatPath, Created: now, Expires: now.Add(ttl),
		state: ApprovalPending, changed: make(chan struct{})}

	h.mu.Lock()
	h.sweepLocked()
	pending := 0
	for _, x := range h.items {
		if x.owner == owner && x.state == ApprovalPending {
			pending++
		}
	}
	if pending >= approvalMaxPending {
		h.mu.Unlock()
		approvalError(w, http.StatusTooManyRequests, "too many pending approvals for this account (max 20)")
		return
	}
	h.items[id] = a
	h.mu.Unlock()

	h.postCard(r, a)
	approvalJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// postCard puts the request's marker in the chat it named, when chat is on
// and the account may write that chat. The message carries no command: a
// chat is a file every member reads and git keeps forever, and a command can
// hold paths, host names or a pasted secret. The command, the description and
// the buttons come from GET /api/approvals/<id>, which only the owner can
// read. A post that cannot be made is skipped; the list still shows it.
func (h *ApprovalHandler) postCard(r *http.Request, a *approval) {
	if a.ChatNS == "" || h.chat == nil || h.canWrite == nil || !h.canWrite(r, a.ChatNS, a.ChatPath) {
		return
	}
	who := approvalAgents[a.Agent]
	if a.Machine != "" {
		who += " on " + a.Machine
	}
	text := "![approval](approval:" + a.ID + ")\n\n" + who + " is waiting for approval."
	h.chat.PostNotice(r, a.ChatNS, a.ChatPath, a.Agent, text)
}

func (h *ApprovalHandler) list(w http.ResponseWriter, owner string) {
	h.mu.Lock()
	h.sweepLocked()
	out := []ApprovalView{}
	for _, a := range h.items {
		if a.owner == owner && h.stateLocked(a) == ApprovalPending {
			out = append(out, h.viewLocked(a))
		}
	}
	h.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	approvalJSON(w, http.StatusOK, map[string]any{"approvals": out})
}

func (h *ApprovalHandler) get(w http.ResponseWriter, id, owner string) {
	h.mu.Lock()
	a := h.lookupLocked(id, owner)
	if a == nil {
		h.mu.Unlock()
		approvalError(w, http.StatusNotFound, "no such approval request (it may have expired, or the server restarted)")
		return
	}
	v := h.viewLocked(a)
	h.mu.Unlock()
	approvalJSON(w, http.StatusOK, v)
}

// hookOutput is the exact text the agent's hook prints for a decision.
func hookOutput(agent, state, reason string) []byte {
	decision := map[string]any{"behavior": "allow"}
	if state == ApprovalDenied {
		if reason == "" {
			reason = approvalDefaultDenial
		}
		decision = map[string]any{"behavior": "deny", "message": reason}
	}
	var out map[string]any
	switch agent {
	case "claude-code", "codex":
		// Both agents read the same PermissionRequest answer (tested
		// 2026-10-09 against Claude Code 2.1.295 and Codex 0.160.0).
		out = map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName": "PermissionRequest",
			"decision":      decision,
		}}
	}
	b, _ := json.Marshal(out)
	return append(b, '\n')
}

func (h *ApprovalHandler) wait(w http.ResponseWriter, r *http.Request, id, owner string) {
	h.mu.Lock()
	a := h.lookupLocked(id, owner)
	if a == nil {
		h.mu.Unlock()
		approvalError(w, http.StatusGone, "no such approval request")
		return
	}
	state := h.stateLocked(a)
	changed := a.changed
	untilExpiry := a.Expires.Sub(h.now())
	h.mu.Unlock()

	if state == ApprovalPending {
		limit := h.maxWait
		if untilExpiry < limit {
			limit = untilExpiry
		}
		timer := time.NewTimer(limit)
		defer timer.Stop()
		select {
		case <-changed:
		case <-timer.C:
		case <-r.Context().Done():
			return
		}
		h.mu.Lock()
		state = h.stateLocked(a)
		h.mu.Unlock()
	}
	switch state {
	case ApprovalPending:
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	case ApprovalAllowed, ApprovalDenied:
		h.mu.Lock()
		out := hookOutput(a.Agent, state, a.Reason)
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		w.Write(out)
	default:
		approvalError(w, http.StatusGone, "this approval request is "+state)
	}
}

func (h *ApprovalHandler) decide(w http.ResponseWriter, r *http.Request, id, owner, ownerName string) {
	// Safety rule 1. The agent runs on its owner's API token, so if a token
	// could decide, the agent could approve its own request with curl. Only a
	// browser login may press the button.
	if middleware.RequestViaAPIToken(r) {
		approvalError(w, http.StatusForbidden, "an approval can only be decided from a browser login, not with an API token")
		return
	}
	var body struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&body); err != nil {
		approvalError(w, http.StatusBadRequest, `body must be {"decision": "allow" or "deny"}`)
		return
	}
	reason := strings.TrimSpace(body.Reason)
	var state string
	switch body.Decision {
	case "allow":
		state = ApprovalAllowed
		if reason != "" {
			approvalError(w, http.StatusBadRequest, "a reason goes with deny only")
			return
		}
	case "deny":
		state = ApprovalDenied
		if len([]rune(reason)) > approvalMaxReason {
			approvalError(w, http.StatusBadRequest, "reason too long (max 500 characters)")
			return
		}
	default:
		approvalError(w, http.StatusBadRequest, `decision must be "allow" or "deny"`)
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	a := h.lookupLocked(id, owner)
	if a == nil {
		approvalError(w, http.StatusNotFound, "no such approval request (it may have expired, or the server restarted)")
		return
	}
	if cur := h.stateLocked(a); cur != ApprovalPending {
		approvalJSON(w, http.StatusConflict, map[string]any{"error": "this request is already " + cur, "approval": h.viewLocked(a)})
		return
	}
	a.state = state
	a.Reason = reason
	a.DecidedAt = h.now()
	a.DecidedBy = ownerName
	if a.DecidedBy == "" {
		a.DecidedBy = "you"
	}
	close(a.changed)
	approvalJSON(w, http.StatusOK, h.viewLocked(a))
}

// close marks a session's open requests as answered elsewhere. The body may
// be the agent's PostToolUse or Stop hook input: a PostToolUse names the
// command that just finished, and only requests for that command close, so
// one parallel tool call finishing does not close another call's card that
// is still waiting. Without a command (Stop, or no body) every open request
// of the session closes.
func (h *ApprovalHandler) close(w http.ResponseWriter, r *http.Request, owner string) {
	session := r.URL.Query().Get("session")
	body, _ := io.ReadAll(io.LimitReader(r.Body, approvalMaxBody+1))
	var in hookInput
	if len(body) > 0 && len(body) <= approvalMaxBody {
		in, _ = parseHookInput(body)
	}
	if session == "" {
		session = in.SessionID
	}
	if session == "" {
		approvalError(w, http.StatusBadRequest, "session is required")
		return
	}
	onlyCommand := ""
	if in.HookEventName != "Stop" && len(in.ToolInput) > 0 {
		onlyCommand, _ = commandOf(in.ToolInput)
		onlyCommand = visibleText(onlyCommand)
	}
	h.mu.Lock()
	n := 0
	for _, a := range h.items {
		if a.owner != owner || a.SessionID != session || h.stateLocked(a) != ApprovalPending {
			continue
		}
		if onlyCommand != "" && a.Command != onlyCommand {
			continue
		}
		a.state = ApprovalClosed
		a.DecidedAt = h.now()
		close(a.changed)
		n++
	}
	h.mu.Unlock()
	approvalJSON(w, http.StatusOK, map[string]int{"closed": n})
}
