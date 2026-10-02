package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// File-based chat (ENABLE_CHAT). Request handling only — the markdown format
// lives in chat_markdown.go. Routes:
//
//	GET  /api/chat?ns=&path=[&after=N][&format=text]   read a chat
//	POST /api/chat?ns=&path=[&as=label]                 post (body = message text)
//	POST /api/chat/convert?ns=&path=[&title=]           make a note a chat (creates it if missing)
//	GET  /api/chats[?format=text]                       every chat the caller can read
//
// The note is the only state. Posting appends a block under the per-note lock
// (notelock.go), so concurrent posters never drop each other's messages.

const maxChatMessage = 64 << 10 // 64KB — a message, not a document

type ChatHandler struct {
	store      storage.Storage
	nsFilter   func(r *http.Request, namespaces []string) []string
	canRead    func(r *http.Request, ns, path string) bool
	singleUser string // the label a single-mode post defaults to (MDNEST_USER)
	multiMode  bool   // a request with no user context is NOT the single-mode owner here
	hub        *collab.Hub
	now        func() time.Time
	index      *chatIndex
}

// NewChatHandler: nsFilter and canRead are REQUIRED. /api/chats spans
// namespaces and cannot sit behind the single-namespace route guard, so those
// two functions are its only access control. A nil one denies everything.
func NewChatHandler(stg storage.Storage, nsFilter func(*http.Request, []string) []string,
	canRead func(*http.Request, string, string) bool, singleUser string, multiMode bool) *ChatHandler {
	return &ChatHandler{store: stg, nsFilter: nsFilter, canRead: canRead, singleUser: singleUser, multiMode: multiMode,
		now: time.Now, index: &chatIndex{entries: map[string]chatIndexEntry{}}}
}

// SetCollabHub lets a post notify an editor that has the same note open.
func (h *ChatHandler) SetCollabHub(hub *collab.Hub) { h.hub = hub }

func chatJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (h *ChatHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.read(w, r)
	case http.MethodPost:
		h.post(w, r)
	default:
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// chatTarget resolves ns + path and insists on a markdown file.
func (h *ChatHandler) chatTarget(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return "", "", false
	}
	raw := r.URL.Query().Get("path")
	relPath, ok := SafeRelPath(raw)
	if !ok || !strings.HasSuffix(strings.ToLower(relPath), ".md") {
		chatJSONError(w, http.StatusBadRequest, "path must be a .md note")
		return "", "", false
	}
	// The permission middleware checks the path exactly as sent, while
	// SafeRelPath CLEANS it ("Shared/../Private/x.md" -> "Private/x.md"). A
	// path-scoped grant on /Shared would then authorise a write to /Private.
	// Only a path that is already canonical gets through, so the path that
	// was authorised is the path that is acted on.
	if relPath != raw {
		chatJSONError(w, http.StatusBadRequest, "path must be canonical (no '.', '..', '//' or trailing '/')")
		return "", "", false
	}
	return ns, relPath, true
}

type chatResponse struct {
	Namespace   string        `json:"ns"`
	Path        string        `json:"path"`
	Title       string        `json:"title"`
	Description string        `json:"description,omitempty"`
	Count       int           `json:"count"`
	Messages    []ChatMessage `json:"messages"`
	// You is the name a post from this caller gets when it sends no `as` —
	// the UI's default "posting as" (single mode has no account to show).
	You string `json:"you"`
}

func chatTitle(doc ChatDoc, relPath string) string {
	if doc.Title != "" {
		return doc.Title
	}
	return strings.TrimSuffix(path.Base(relPath), path.Ext(relPath))
}

func (h *ChatHandler) read(w http.ResponseWriter, r *http.Request) {
	ns, relPath, ok := h.chatTarget(w, r)
	if !ok {
		return
	}
	data, err := h.store.ReadFile(r.Context(), ns, relPath)
	if errors.Is(err, storage.ErrNotExist) {
		chatJSONError(w, http.StatusNotFound, "not found")
		return
	} else if err != nil {
		chatJSONError(w, http.StatusInternalServerError, "failed to read chat")
		return
	}
	doc := ParseChat(string(data))
	if !doc.IsChat {
		chatJSONError(w, http.StatusBadRequest, "this note is not a chat — convert it first")
		return
	}
	after, _ := strconv.Atoi(r.URL.Query().Get("after"))
	msgs := []ChatMessage{}
	for _, m := range doc.Messages {
		if m.N > after {
			msgs = append(msgs, m)
		}
	}
	if r.URL.Query().Get("format") == "text" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Chat-Count", strconv.Itoa(len(doc.Messages)))
		var b strings.Builder
		for _, m := range msgs {
			b.WriteString(formatChatMessageText(m))
		}
		io.WriteString(w, b.String())
		return
	}
	you, _, _ := h.authorFor(r, "")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(chatResponse{Namespace: ns, Path: relPath, Title: chatTitle(doc, relPath),
		Description: doc.Description, Count: len(doc.Messages), Messages: msgs, You: you})
}

// formatChatMessageText is the terminal rendering the CLI prints verbatim, so
// the CLI never has to parse JSON (its no-python3/jq tier stays trivial).
func formatChatMessageText(m ChatMessage) string {
	who := m.Author
	if m.Via != "" {
		who += " (via " + m.Via + ")"
	}
	return fmt.Sprintf("[#%d] %s · %s\n%s\n\n", m.N, terminalSafe(who), m.Time, terminalSafe(m.Text))
}

// terminalSafe replaces control characters (other than newline and tab) with
// U+FFFD. format=text goes straight to a terminal via the CLI, and another
// chat member's ESC sequences must not be able to rewrite the screen or, on
// some terminals, write the clipboard (OSC 52).
func terminalSafe(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || (r >= 0x7f && r < 0xa0) {
			return '\uFFFD'
		}
		return r
	}, s)
}

// author decides who a post is from. In multi mode the account is always the
// authenticated user; `as` only sets a display label, and a label that is not
// the account is rendered "label (via account)" so it cannot impersonate.
func (h *ChatHandler) author(r *http.Request) (label, via string, ok bool) {
	return h.authorFor(r, r.URL.Query().Get("as"))
}

func (h *ChatHandler) authorFor(r *http.Request, rawAs string) (label, via string, ok bool) {
	as := sanitizeChatLabel(rawAs)
	uc := middleware.UserFromContext(r.Context())
	if uc == nil && h.multiMode {
		// Multi mode with no user context is an authenticated token that maps
		// to no user. Letting it post would let it pick any label with no
		// "(via …)", i.e. impersonate anyone — refuse instead.
		return "", "", false
	}
	if uc == nil {
		// Single mode: one owner, so the label is just a name for the poster.
		if as == "" {
			as = sanitizeChatLabel(h.singleUser)
		}
		if as == "" {
			as = "me"
		}
		return as, "", true
	}
	account := sanitizeChatLabel(uc.Username)
	if account == "" {
		return "", "", false
	}
	if as == "" || as == account {
		return account, "", true
	}
	return as, account, true
}

func (h *ChatHandler) post(w http.ResponseWriter, r *http.Request) {
	ns, relPath, ok := h.chatTarget(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxChatMessage+1))
	if err != nil {
		chatJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	if len(body) > maxChatMessage {
		chatJSONError(w, http.StatusRequestEntityTooLarge, "message too long (max 64KB)")
		return
	}
	text := strings.TrimSpace(string(body))
	if text == "" {
		chatJSONError(w, http.StatusBadRequest, "message is empty")
		return
	}
	label, via, ok := h.author(r)
	if !ok {
		chatJSONError(w, http.StatusForbidden, "cannot attribute this post to a user")
		return
	}

	ctx := r.Context()
	unlock := lockNote(ns, relPath)
	data, err := h.store.ReadFile(ctx, ns, relPath)
	if errors.Is(err, storage.ErrNotExist) {
		unlock()
		chatJSONError(w, http.StatusNotFound, "chat not found — create it first")
		return
	} else if err != nil {
		unlock()
		chatJSONError(w, http.StatusInternalServerError, "failed to read chat")
		return
	}
	content := string(data)
	if !IsChatNote(content) {
		unlock()
		chatJSONError(w, http.StatusBadRequest, "this note is not a chat — convert it first")
		return
	}
	at := h.now()
	updated := AppendChatMessage(content, RenderChatMessage(label, via, at, text))
	if len(updated) > maxNoteSize {
		unlock()
		chatJSONError(w, http.StatusRequestEntityTooLarge, "chat is full (10MB) — start a new one")
		return
	}
	if err := h.store.WriteFile(ctx, ns, relPath, []byte(updated)); err != nil {
		unlock()
		chatJSONError(w, http.StatusInternalServerError, "failed to write chat")
		return
	}
	unlock()

	doc := ParseChat(updated)
	msg := doc.Messages[len(doc.Messages)-1]
	h.notify(r, ns, relPath, updated)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"status": "posted", "count": len(doc.Messages), "message": msg})
}

// notify tells an editor with this note open that it changed underneath it
// (live-collab only). The chat view itself polls, so it works without collab.
func (h *ChatHandler) notify(r *http.Request, ns, relPath, content string) {
	if h.hub == nil {
		return
	}
	userID, username := 0, "chat"
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		userID, username = uc.ID, uc.Username
	}
	_, clean := ExtractNoteID(content)
	h.hub.BroadcastFileChanged(ns, relPath, userID, username, contentETag([]byte(canonicalForETag(clean))), "", "")
}

// HandleConvert makes a note a chat, creating it when it does not exist —
// which is also how a brand-new chat is started.
func (h *ChatHandler) HandleConvert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, relPath, ok := h.chatTarget(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	title := r.URL.Query().Get("title")
	unlock := lockNote(ns, relPath)
	defer unlock()

	existing := ""
	created := false
	data, err := h.store.ReadFile(ctx, ns, relPath)
	switch {
	case err == nil:
		existing = string(data)
	case errors.Is(err, storage.ErrNotExist):
		created = true
		if strings.TrimSpace(title) == "" {
			title = strings.TrimSuffix(path.Base(relPath), path.Ext(relPath))
		}
	default:
		chatJSONError(w, http.StatusInternalServerError, "failed to read note")
		return
	}
	if created {
		if dir := path.Dir(relPath); dir != "." {
			if err := h.store.MkdirAll(ctx, ns, dir); err != nil {
				chatJSONError(w, http.StatusInternalServerError, "failed to create folder")
				return
			}
		}
	}
	out := ConvertToChat(existing, title)
	if out != existing {
		if err := h.store.WriteFile(ctx, ns, relPath, []byte(out)); err != nil {
			chatJSONError(w, http.StatusInternalServerError, "failed to write note")
			return
		}
	}
	status := "converted"
	if created {
		status = "created"
	} else if out == existing {
		status = "already a chat"
	}
	w.Header().Set("Content-Type", "application/json")
	if created {
		w.WriteHeader(http.StatusCreated)
	}
	json.NewEncoder(w).Encode(map[string]string{"status": status, "ns": ns, "path": relPath,
		"title": chatTitle(ParseChat(out), relPath)})
}

// ChatSummary is one row of the "all chats" list.
type ChatSummary struct {
	Namespace  string `json:"ns"`
	Path       string `json:"path"`
	Title      string `json:"title"`
	Count      int    `json:"count"`
	LastAuthor string `json:"lastAuthor,omitempty"`
	LastTime   string `json:"lastTime,omitempty"`
	LastText   string `json:"lastText,omitempty"`
}

// chatIndex remembers, per file, whether it is a chat and its summary, keyed
// by size + mtime. Listing still walks every namespace on each request (cheap)
// but only re-reads files that changed, so a busy chat does not make every
// list refresh re-read the whole tree. In memory on purpose — derived data,
// nothing written under NOTES_DIR (see tasks_cache.go for why).
type chatIndex struct {
	mu      sync.Mutex
	entries map[string]chatIndexEntry
}

type chatIndexEntry struct {
	size    int64
	mtime   int64
	isChat  bool
	summary ChatSummary
	seen    int64 // generation of the last walk that saw this file
}

func (h *ChatHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if h.nsFilter == nil || h.canRead == nil {
		chatJSONError(w, http.StatusForbidden, "access denied")
		return
	}
	ctx := r.Context()
	names, err := h.store.ListNamespaces(ctx)
	if err != nil {
		chatJSONError(w, http.StatusInternalServerError, "failed to list namespaces")
		return
	}
	if only := r.URL.Query().Get("ns"); only != "" {
		// Exact membership in the real namespace list — never the raw value.
		// Storage does no containment check for a namespace root, so
		// `ns=../..` would otherwise walk outside NOTES_DIR.
		found := false
		for _, n := range names {
			if n == only {
				found = true
				break
			}
		}
		if !found {
			chatJSONError(w, http.StatusNotFound, "namespace not found")
			return
		}
		names = []string{only}
	}
	names = h.nsFilter(r, names)

	chats := []ChatSummary{}
	for _, ns := range names {
		for _, c := range h.scanNamespace(ctx, ns) {
			if h.canRead(r, ns, "/"+c.Path) {
				chats = append(chats, c)
			}
		}
	}
	// Most recently active first; never-posted chats after, by title.
	sort.SliceStable(chats, func(i, j int) bool {
		if chats[i].LastTime != chats[j].LastTime {
			return chats[i].LastTime > chats[j].LastTime
		}
		return strings.ToLower(chats[i].Title) < strings.ToLower(chats[j].Title)
	})

	if r.URL.Query().Get("format") == "text" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		var b strings.Builder
		for _, c := range chats {
			last := "no messages yet"
			if c.LastTime != "" {
				last = c.LastTime + " by " + c.LastAuthor
			}
			fmt.Fprintf(&b, "%s/%s\t%s\t%d msgs\t%s\n", c.Namespace, c.Path, c.Title, c.Count, last)
		}
		io.WriteString(w, b.String())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"chats": chats})
}

func (h *ChatHandler) scanNamespace(ctx context.Context, ns string) []ChatSummary {
	gen := time.Now().UnixNano()
	var out []ChatSummary
	h.store.Walk(ctx, ns, "", func(relPath string, info storage.FileInfo) error {
		if info.IsDir {
			if relPath != "" && strings.HasPrefix(info.Name, ".") {
				return storage.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(info.Name), ".md") {
			return nil
		}
		key := ns + "\x00" + relPath
		mtime := info.ModTime.UnixNano()
		h.index.mu.Lock()
		e, ok := h.index.entries[key]
		h.index.mu.Unlock()
		if !ok || e.size != info.Size || e.mtime != mtime {
			e = chatIndexEntry{size: info.Size, mtime: mtime}
			if sum, isChat := h.summarize(ctx, ns, relPath); isChat {
				e.isChat, e.summary = true, sum
			}
		}
		e.seen = gen
		h.index.mu.Lock()
		h.index.entries[key] = e
		h.index.mu.Unlock()
		if e.isChat {
			out = append(out, e.summary)
		}
		return nil
	})
	// Forget files this walk no longer found (deleted or moved), so the index
	// cannot grow without bound.
	prefix := ns + "\x00"
	h.index.mu.Lock()
	for k, e := range h.index.entries {
		if strings.HasPrefix(k, prefix) && e.seen != gen {
			delete(h.index.entries, k)
		}
	}
	h.index.mu.Unlock()
	return out
}

// summarize reads a note's head to decide whether it is a chat, and only then
// the whole file — so a namespace of large ordinary notes costs a few KB each.
func (h *ChatHandler) summarize(ctx context.Context, ns, relPath string) (ChatSummary, bool) {
	if !h.headIsChat(ctx, ns, relPath) {
		return ChatSummary{}, false
	}
	data, err := h.store.ReadFile(ctx, ns, relPath)
	if err != nil || !IsChatNote(string(data)) {
		return ChatSummary{}, false
	}
	doc := ParseChat(string(data))
	sum := ChatSummary{Namespace: ns, Path: relPath, Title: chatTitle(doc, relPath), Count: len(doc.Messages)}
	if n := len(doc.Messages); n > 0 {
		last := doc.Messages[n-1]
		sum.LastAuthor, sum.LastTime, sum.LastText = last.Author, last.Time, chatPreview(last.Text)
	}
	return sum, true
}

// chatHeadBytes bounds how much of a note is read to look for the marker.
// Frontmatter sits at the top, so this is plenty for any real chat.
const chatHeadBytes = 8 << 10

func (h *ChatHandler) headIsChat(ctx context.Context, ns, relPath string) bool {
	f, err := h.store.Open(ctx, ns, relPath)
	if err != nil {
		return false
	}
	defer f.Close()
	head, err := io.ReadAll(io.LimitReader(f, chatHeadBytes))
	if err != nil {
		return false
	}
	return IsChatNote(string(head))
}

func chatPreview(text string) string {
	t := strings.Join(strings.Fields(text), " ")
	if r := []rune(t); len(r) > 140 {
		return string(r[:140]) + "…"
	}
	return t
}
