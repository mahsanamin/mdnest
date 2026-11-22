package handlers

// Optional coordination state belongs to the chat note. Commands are never
// interpreted here. The single-line JSON values below are quoted YAML scalars,
// so they need no YAML library and leave existing front matter unchanged.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

type ChatAgent struct {
	Handle string `json:"handle"`
	Trait  string `json:"trait"`
}

type ChatCursor struct {
	Account string   `json:"account,omitempty"`
	Handle  string   `json:"handle"`
	Worker  string   `json:"worker,omitempty"`
	SeenIDs []string `json:"seen_ids,omitempty"`
}

type ChatLease struct {
	By      string    `json:"by"`
	Account string    `json:"account,omitempty"`
	Expires time.Time `json:"expires"`
	Worker  string    `json:"worker,omitempty"`
	LeaseID string    `json:"lease_id"`
}

type ChatCoordination struct {
	MaxTurns int                  `json:"max_agent_turns"`
	Human    string               `json:"human_handle"`
	Status   string               `json:"crew_status"`
	Turns    int                  `json:"consecutive_agent_turns"`
	Agents   []ChatAgent          `json:"agents"`
	Cursors  []ChatCursor         `json:"cursors"`
	Claims   map[string]ChatLease `json:"claims,omitempty"`
}

const coordinationKey = "mdnest-coordination"
const chatDoneMarker = "<!-- mdnest:done -->"

// SetCoordinationRole refuses lease coordination on a multi-writer app tier,
// even when the operator explicitly enables ordinary chat there.
func (h *ChatHandler) SetCoordinationRole(role string) { h.coordinationDisabled = role == "app" }

func (h *ChatHandler) coordinationTarget(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	if h.coordinationDisabled {
		chatJSONError(w, 409, "coordination requires a single backend writer")
		return "", "", false
	}
	ns, p, ok := h.chatTarget(w, r)
	if !ok {
		return "", "", false
	}
	if lr, ok := h.store.(storage.LinkResolver); ok {
		real, err := lr.ResolveLinks(r.Context(), ns, p)
		if err != nil || real != p {
			chatJSONError(w, 400, "coordination requires the real note path, not a symlink alias")
			return "", "", false
		}
	}
	return ns, p, true
}

func cursorHasSeen(c ChatCursor, id string) bool {
	for _, seen := range c.SeenIDs {
		if seen == id {
			return true
		}
	}
	return false
}

// HandleAck persists exactly the delivered message IDs after successful work.
// Sparse acknowledgments keep type/mention-filtered work from skipping older
// unseen messages. The route always requires write access.
func (h *ChatHandler) HandleAck(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		chatJSONError(w, 405, "method not allowed")
		return
	}
	ns, p, ok := h.coordinationTarget(w, r)
	if !ok {
		return
	}
	label, _, ok := h.author(r)
	worker := r.URL.Query().Get("worker")
	if !ok || !chatTraitNameRe.MatchString(label) || worker != "" && !chatTraitNameRe.MatchString(worker) {
		chatJSONError(w, 400, "invalid cursor identity")
		return
	}
	var ids []string
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&ids) != nil || len(ids) > 1000 {
		chatJSONError(w, 400, "expected up to 1000 message IDs")
		return
	}
	unlock := lockNote(ns, p)
	defer unlock()
	data, err := h.store.ReadFile(r.Context(), ns, p)
	if errors.Is(err, storage.ErrNotExist) {
		chatJSONError(w, 404, "chat not found")
		return
	}
	if err != nil {
		chatJSONError(w, 500, "failed to read chat")
		return
	}
	doc := ParseChat(string(data))
	if !doc.IsChat {
		chatJSONError(w, 400, "not a chat")
		return
	}
	c := readCoordination(string(data))
	account := coordinationIdentity(r, label)
	index := -1
	for i, cursor := range c.Cursors {
		if cursor.Account == account && strings.EqualFold(cursor.Handle, label) && cursor.Worker == worker {
			index = i
			break
		}
	}
	if index < 0 {
		if len(c.Cursors) >= 128 {
			chatJSONError(w, 409, "too many cursors")
			return
		}
		c.Cursors = append(c.Cursors, ChatCursor{Account: account, Handle: label, Worker: worker})
		index = len(c.Cursors) - 1
	}
	cursor := &c.Cursors[index]
	for _, id := range ids {
		found := false
		for _, m := range doc.Messages {
			if m.ID == id {
				found = true
				if !cursorHasSeen(*cursor, m.ID) {
					cursor.SeenIDs = append(cursor.SeenIDs, m.ID)
				}
				break
			}
		}
		if !found {
			chatJSONError(w, 400, "unknown message ID")
			return
		}
	}
	// Prune IDs no longer present after a deliberate transcript edit. Never
	// treat a new message at an old ordinal as acknowledged.
	present := map[string]bool{}
	for _, m := range doc.Messages {
		present[m.ID] = true
	}
	kept := cursor.SeenIDs[:0]
	for _, id := range cursor.SeenIDs {
		if present[id] {
			kept = append(kept, id)
		}
	}
	cursor.SeenIDs = kept
	updated := setCoordination(string(data), c)
	if len(updated) > maxNoteSize {
		chatJSONError(w, 413, "chat is full")
		return
	}
	if err := h.store.WriteFile(r.Context(), ns, p, []byte(updated)); err != nil {
		chatJSONError(w, 500, "failed to save cursor")
		return
	}
	h.notify(r, ns, p, updated)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cursor)
}

func readCoordination(content string) ChatCoordination {
	fm, _, _ := splitFrontMatter(content)
	var c ChatCoordination
	if raw, ok := frontMatterValue(fm, coordinationKey); ok {
		// frontMatterValue only removes the outer quotes. Unquote the original
		// scalar to preserve escaped quotes, newlines and Unicode exactly.
		if decoded, err := strconv.Unquote(`"` + raw + `"`); err == nil {
			_ = json.Unmarshal([]byte(decoded), &c)
		}
	}
	if c.MaxTurns == 0 {
		raw, _ := frontMatterValue(fm, "max_agent_turns")
		c.MaxTurns, _ = strconv.Atoi(raw)
	}
	if c.Human == "" {
		c.Human, _ = frontMatterValue(fm, "human_handle")
		c.Human = strings.TrimPrefix(c.Human, "@")
	}
	if c.Status == "" {
		c.Status, _ = frontMatterValue(fm, "crew_status")
	}
	if c.Status == "" {
		c.Status = "active"
	}
	if c.Agents == nil {
		c.Agents = []ChatAgent{}
	}
	if c.Cursors == nil {
		c.Cursors = []ChatCursor{}
	}
	if c.Claims == nil {
		c.Claims = map[string]ChatLease{}
	}
	return c
}

func setCoordination(content string, c ChatCoordination) string {
	fm, rest, _ := splitFrontMatter(content)
	data, _ := json.Marshal(c)
	var b strings.Builder
	b.WriteString("---\n")
	for _, line := range strings.Split(strings.TrimSuffix(fm, "\n"), "\n") {
		key, _, _ := strings.Cut(line, ":")
		if key != coordinationKey {
			b.WriteString(line + "\n")
		}
	}
	b.WriteString(coordinationKey + ": " + strconv.Quote(string(data)) + "\n---\n")
	return b.String() + rest
}

func newChatMessageID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "m_" + hex.EncodeToString(b[:]), nil
}

func legacyChatMessageID(m ChatMessage) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d\x00%s\x00%s\x00%s\x00%s", m.N, m.Author, m.Via, m.Time, m.Text)))
	return "m_legacy_" + hex.EncodeToString(sum[:12])
}

var messageIDRe = regexp.MustCompile(`^m_[a-zA-Z0-9_\-]{1,100}$`)
var metadataLineRe = regexp.MustCompile(`^<!-- mdnest:msg (.+) -->$`)
var metadataAttrRe = regexp.MustCompile(`([a-z_]+)="([^"]*)"`)

func metadataLine(m ChatMessage) string {
	meta, _ := json.Marshal(m.Meta)
	return `<!-- mdnest:msg id="` + html.EscapeString(m.ID) + `" type="` + html.EscapeString(m.Type) + `" reply_to="` + html.EscapeString(m.ReplyTo) + `" meta="` + html.EscapeString(string(meta)) + `" -->`
}

func parseMessageMetadata(line string, m *ChatMessage) bool {
	parts := metadataLineRe.FindStringSubmatch(line)
	if parts == nil {
		return false
	}
	attrs := map[string]string{}
	offset := 0
	for _, loc := range metadataAttrRe.FindAllStringSubmatchIndex(parts[1], -1) {
		if strings.TrimSpace(parts[1][offset:loc[0]]) != "" {
			return false
		}
		key := parts[1][loc[2]:loc[3]]
		if _, duplicate := attrs[key]; duplicate {
			return false
		}
		if key != "id" && key != "type" && key != "reply_to" && key != "meta" {
			return false
		}
		attrs[key] = html.UnescapeString(parts[1][loc[4]:loc[5]])
		offset = loc[1]
	}
	if strings.TrimSpace(parts[1][offset:]) != "" || !messageIDRe.MatchString(attrs["id"]) {
		return false
	}
	if reply := attrs["reply_to"]; reply != "" && !messageIDRe.MatchString(reply) {
		return false
	}
	if typ := attrs["type"]; typ != "" {
		switch typ {
		case "task", "review", "patch", "question", "ack", "error":
		default:
			return false
		}
	}
	var meta map[string]any
	if raw := attrs["meta"]; raw != "" && raw != "null" {
		if json.Unmarshal([]byte(raw), &meta) != nil || meta == nil {
			return false
		}
	}
	m.ID, m.Type, m.ReplyTo, m.Meta = attrs["id"], attrs["type"], attrs["reply_to"], meta
	return true
}

func chatControlLine(line string) bool {
	return strings.HasPrefix(line, "<!-- mdnest:msg ") || strings.HasPrefix(line, "<!-- mdnest:claim ") || line == chatDoneMarker
}

type chatPostOptions struct {
	Type    string
	ReplyTo string
	Meta    map[string]any
	Done    bool
}

func postOptions(r *http.Request) (chatPostOptions, error) {
	q := r.URL.Query()
	o := chatPostOptions{Type: q.Get("type"), ReplyTo: q.Get("reply_to"), Done: q.Get("done") == "true"}
	if o.Type != "" {
		switch o.Type {
		case "task", "review", "patch", "question", "ack", "error":
		default:
			return o, errors.New("invalid message type")
		}
	}
	if o.ReplyTo != "" && !messageIDRe.MatchString(o.ReplyTo) {
		return o, errors.New("invalid reply_to")
	}
	if raw := q.Get("meta"); raw != "" {
		if len(raw) > 8192 || json.Unmarshal([]byte(raw), &o.Meta) != nil || o.Meta == nil {
			return o, errors.New("meta must be a JSON object (max 8KB)")
		}
	}
	return o, nil
}

func coordinationIdentity(r *http.Request, handle string) string {
	account := ""
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		account = uc.Username
	}
	return account
}

func (h *ChatHandler) humanPost(r *http.Request, c ChatCoordination, label, via string) bool {
	if c.Human == "" || !strings.EqualFold(label, c.Human) || via != "" {
		return false
	}
	// A token used by an agent can choose its display label. In multi mode,
	// only a browser-authenticated human post may reset an automatic pause.
	return !h.multiMode || !middleware.RequestViaAPIToken(r)
}

// HandleStop lets a local runner persist a pause on cancellation or its own
// independent limit. Completion is only requested by an explicit done post.
func (h *ChatHandler) HandleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		chatJSONError(w, 405, "method not allowed")
		return
	}
	ns, p, ok := h.coordinationTarget(w, r)
	if !ok {
		return
	}
	unlock := lockNote(ns, p)
	defer unlock()
	data, err := h.store.ReadFile(r.Context(), ns, p)
	if errors.Is(err, storage.ErrNotExist) {
		chatJSONError(w, 404, "chat not found")
		return
	}
	if err != nil {
		chatJSONError(w, 500, "failed to read chat")
		return
	}
	if !IsChatNote(string(data)) {
		chatJSONError(w, 400, "not a chat")
		return
	}
	c := readCoordination(string(data))
	if c.MaxTurns == 0 {
		chatJSONError(w, 409, "room not configured")
		return
	}
	if c.Status != "completed" {
		c.Status = "paused"
		updated := setCoordination(string(data), c)
		if err := h.store.WriteFile(r.Context(), ns, p, []byte(updated)); err != nil {
			chatJSONError(w, 500, "failed to pause room")
			return
		}
		h.notify(r, ns, p, updated)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(c)
}

// HandleRoom configures an opted-in room and provides its durable roster. It
// accepts personas, never commands. Existing chats remain unchanged until used.
func (h *ChatHandler) HandleRoom(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "POST" {
		chatJSONError(w, 405, "method not allowed")
		return
	}
	ns, p, ok := h.coordinationTarget(w, r)
	if !ok {
		return
	}
	unlock := lockNote(ns, p)
	defer unlock()
	data, err := h.store.ReadFile(r.Context(), ns, p)
	if errors.Is(err, storage.ErrNotExist) {
		chatJSONError(w, 404, "chat not found")
		return
	}
	if err != nil {
		chatJSONError(w, 500, "failed to read chat")
		return
	}
	if !IsChatNote(string(data)) {
		chatJSONError(w, 400, "not a chat")
		return
	}
	c := readCoordination(string(data))
	if r.Method == "POST" {
		var in struct {
			MaxTurns int         `json:"max_agent_turns"`
			Human    string      `json:"human_handle"`
			Agents   []ChatAgent `json:"agents"`
			Handles  []string    `json:"handles"`
			Goal     string      `json:"goal"`
		}
		dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
		dec.DisallowUnknownFields()
		if dec.Decode(&in) != nil || in.MaxTurns < 1 || in.MaxTurns > 10000 || len(in.Agents) > 32 || len(in.Handles) > 64 {
			chatJSONError(w, 400, "invalid room config")
			return
		}
		in.Human = strings.TrimPrefix(in.Human, "@")
		if !chatTraitNameRe.MatchString(in.Human) {
			chatJSONError(w, 400, "invalid human handle")
			return
		}
		seen := map[string]bool{}
		for i, a := range in.Agents {
			key := strings.ToLower(a.Handle)
			if !chatTraitNameRe.MatchString(a.Handle) || seen[key] || strings.EqualFold(a.Handle, in.Human) || len(a.Trait) > 8192 {
				chatJSONError(w, 400, "invalid or duplicate agent")
				return
			}
			seen[key] = true
			in.Agents[i].Trait = a.Trait
		}
		// Configuration is initialization only. A running crew cannot silently
		// reset its breaker by reconfiguring the room.
		if c.MaxTurns != 0 {
			chatJSONError(w, 409, "room already configured")
			return
		}
		c.MaxTurns, c.Human, c.Agents = in.MaxTurns, in.Human, in.Agents
		for _, name := range in.Handles {
			if !chatTraitNameRe.MatchString(name) {
				chatJSONError(w, 400, "invalid cursor handle")
				return
			}
			c.Cursors = append(c.Cursors, ChatCursor{Handle: name, Account: coordinationIdentity(r, name)})
		}
		updated := setCoordination(string(data), c)
		if in.Goal != "" {
			if len(in.Goal) > maxChatMessage || len(in.Agents) == 0 || len(ParseChat(string(data)).Messages) != 0 {
				chatJSONError(w, 400, "initial goal requires an empty room and an agent")
				return
			}
			label, via, ok := h.author(r)
			if !ok {
				chatJSONError(w, 403, "cannot attribute goal")
				return
			}
			id, err := newChatMessageID()
			if err != nil {
				chatJSONError(w, 500, "failed to generate goal ID")
				return
			}
			block := RenderChatMessage(label, via, h.now(), "@"+in.Agents[0].Handle+" "+in.Goal)
			boundary := strings.Index(block[1:], "\n") + 1
			block = block[:boundary+1] + metadataLine(ChatMessage{ID: id, Type: "task"}) + "\n" + block[boundary+1:]
			updated = AppendChatMessage(updated, block)
		}
		if len(updated) > maxNoteSize {
			chatJSONError(w, 413, "chat is full")
			return
		}
		if err := h.store.WriteFile(r.Context(), ns, p, []byte(updated)); err != nil {
			chatJSONError(w, 500, "failed to write chat")
			return
		}
		h.notify(r, ns, p, updated)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(c)
}

func (h *ChatHandler) HandleClaim(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		chatJSONError(w, 405, "method not allowed")
		return
	}
	ns, p, ok := h.coordinationTarget(w, r)
	if !ok {
		return
	}
	label, _, ok := h.author(r)
	if !ok || !chatTraitNameRe.MatchString(label) {
		chatJSONError(w, 400, "invalid claimant")
		return
	}
	id := r.URL.Query().Get("msg_id")
	ttl := 300
	if s := r.URL.Query().Get("ttl_seconds"); s != "" {
		var err error
		ttl, err = strconv.Atoi(s)
		if err != nil {
			ttl = 0
		}
	}
	if !messageIDRe.MatchString(id) || ttl < 1 || ttl > 86400 {
		chatJSONError(w, 400, "invalid message ID or TTL (1..86400 seconds)")
		return
	}
	unlock := lockNote(ns, p)
	defer unlock()
	data, err := h.store.ReadFile(r.Context(), ns, p)
	if errors.Is(err, storage.ErrNotExist) {
		chatJSONError(w, 404, "chat not found")
		return
	}
	if err != nil {
		chatJSONError(w, 500, "failed to read chat")
		return
	}
	doc := ParseChat(string(data))
	if !doc.IsChat {
		chatJSONError(w, 400, "not a chat")
		return
	}
	found := false
	for _, m := range doc.Messages {
		if m.ID == id {
			found = true
			break
		}
	}
	if !found {
		chatJSONError(w, 404, "message not found")
		return
	}
	c := readCoordination(string(data))
	now := h.now()
	account := coordinationIdentity(r, label)
	worker := r.URL.Query().Get("worker")
	if worker != "" && !chatTraitNameRe.MatchString(worker) {
		chatJSONError(w, 400, "invalid worker")
		return
	}
	lease, held := c.Claims[id]
	w.Header().Set("Content-Type", "application/json")
	if held && lease.Expires.After(now) {
		if lease.By != label || lease.Account != account || lease.Worker != worker || r.URL.Query().Get("lease_id") != lease.LeaseID {
			w.WriteHeader(409)
			json.NewEncoder(w).Encode(map[string]any{"claimed": false, "error": "ALREADY_CLAIMED", "held_by": lease.By, "expires": lease.Expires})
			return
		}
		lease.Expires = now.Add(time.Duration(ttl) * time.Second)
	} else {
		leaseID, err := newChatMessageID()
		if err != nil {
			chatJSONError(w, 500, "failed to generate lease")
			return
		}
		lease = ChatLease{By: label, Account: account, Worker: worker, LeaseID: leaseID, Expires: now.Add(time.Duration(ttl) * time.Second)}
	}
	c.Claims[id] = lease
	updated := setCoordination(string(data), c)
	if len(updated) > maxNoteSize {
		chatJSONError(w, 413, "chat is full")
		return
	}
	if err := h.store.WriteFile(r.Context(), ns, p, []byte(updated)); err != nil {
		chatJSONError(w, 500, "failed to write chat")
		return
	}
	h.notify(r, ns, p, updated)
	json.NewEncoder(w).Encode(map[string]any{"claimed": true, "held_by": label, "expires": lease.Expires, "lease_id": lease.LeaseID})
}
