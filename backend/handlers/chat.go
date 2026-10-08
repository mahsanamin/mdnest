package handlers

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
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
	"github.com/mdnest/mdnest/backend/store"
)

// File-based chat (ENABLE_CHAT). Request handling only — the markdown format
// lives in chat_markdown.go. Routes:
//
//	GET  /api/chat?ns=&path=[&after=N][&exclude=label][&mention=label][&format=text]   read a chat
//	POST /api/chat?ns=&path=[&as=label]                 post (body = message text)
//	POST /api/chat/convert?ns=&path=[&title=]           make a note a chat (creates it if missing)
//	GET  /api/chats[?format=text]                       every chat the caller can read
//	GET/POST/DELETE /api/chat/members?ns=&path=          private chat members (chat_members.go)
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
	status     *chatStatusStore      // who is working on what (chat_status.go)
	members    store.ChatMemberStore // private chats (chat_members.go); nil = off
	users      chatUserLookup
}

// NewChatHandler: nsFilter and canRead are REQUIRED. /api/chats spans
// namespaces and cannot sit behind the single-namespace route guard, so those
// two functions are its only access control. A nil one denies everything.
func NewChatHandler(stg storage.Storage, nsFilter func(*http.Request, []string) []string,
	canRead func(*http.Request, string, string) bool, singleUser string, multiMode bool) *ChatHandler {
	return &ChatHandler{store: stg, nsFilter: nsFilter, canRead: canRead, singleUser: singleUser, multiMode: multiMode,
		now: time.Now, index: &chatIndex{entries: map[string]chatIndexEntry{}}, status: newChatStatusStore()}
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
	// Working lists who has said they are busy, and on what (chat_status.go).
	Working []ChatStatus `json:"working"`
	// Contexts is each poster's last /context report, by label
	// (chat_context.go), so the page can show it by their name.
	Contexts map[string]ChatContext `json:"contexts"`
	// Agents is each agent's saved role, by name (chat_traits.go).
	Agents map[string]string `json:"agents"`
	// Owner is the account that owns the chat, and CanDelete whether this
	// caller may delete it (chat_owner.go), so the page offers Delete only
	// to those who may.
	Owner     string `json:"owner,omitempty"`
	CanDelete bool   `json:"canDelete"`
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
	// exclude drops one poster's own messages, so an agent waiting for a
	// reply is not woken by what it just posted itself. Matched on the
	// label (the part before "(via …)"), sanitised the same way a post is.
	exclude := sanitizeChatLabel(r.URL.Query().Get("exclude"))
	// mention keeps only messages addressed to that name (@name, or @all /
	// @everyone), so several agents can share a chat without each one
	// answering everything.
	mention := sanitizeChatLabel(r.URL.Query().Get("mention"))
	msgs := []ChatMessage{}
	for _, m := range doc.Messages {
		if m.N <= after || (exclude != "" && m.Author == exclude) {
			continue
		}
		if mention != "" && !ChatMentions(m.Text, mention) {
			continue
		}
		msgs = append(msgs, m)
	}
	// A poll that names its poster (exclude=NAME: every `chat wait --as`) is
	// presence: NAME is listening, and thinking if this poll handed it new
	// messages. Inferred here so it works with any CLI that can wait.
	if exclude != "" && exclude != "~" {
		if label, via, ok := h.authorFor(r, exclude); ok {
			h.status.polled(ns, relPath, label, via, len(msgs) > 0, h.now())
		}
	}
	if r.URL.Query().Get("format") == "text" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Chat-Count", strconv.Itoa(len(doc.Messages)))
		// Who is working on what, for an agent deciding whether to pick a task
		// up: "codxu: reviewing the PR | claude-b: running tests". A header so
		// the CLI reads it with grep, not a JSON parser; every part is already
		// one terminal-safe line.
		if hdr := busyHeader(h.status.list(ns, relPath, h.now())); hdr != "" {
			w.Header().Set("X-Chat-Working", hdr)
		}
		var b strings.Builder
		for _, m := range msgs {
			b.WriteString(formatChatMessageText(m))
		}
		// A waiting agent that is handed new messages is reminded of its
		// saved role, last, so it is the freshest thing it reads.
		if exclude != "" && len(msgs) > 0 {
			if trait := chatTraitFor(doc.Agents, exclude); trait != "" {
				b.WriteString(chatTraitReminder(exclude, trait))
			}
		}
		io.WriteString(w, b.String())
		return
	}
	you, _, _ := h.authorFor(r, "")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(chatResponse{Namespace: ns, Path: relPath, Title: chatTitle(doc, relPath),
		Description: doc.Description, Count: len(doc.Messages), Messages: msgs, You: you,
		Working: h.status.list(ns, relPath, h.now()), Contexts: h.status.contexts(ns, relPath, h.now()),
		Agents: agentsOrEmpty(doc.Agents), Owner: ChatOwner(string(data)), CanDelete: mayRemoveChat(r, ns, string(data))})
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
	// "/status what I am doing" sets the poster's status instead of adding a
	// message, so any CLI version (or MCP post_chat) can use it.
	if st, isStatus := slashStatus(text); isStatus {
		h.applyStatus(w, r, ns, relPath, st, http.StatusOK)
		return
	}
	// "/context 42%" reports how much of its context an agent has used.
	if c, isContext := slashContext(text); isContext {
		h.applyContext(w, r, ns, relPath, c)
		return
	}
	label, via, ok := h.author(r)
	if !ok {
		chatJSONError(w, http.StatusForbidden, "cannot attribute this post to a user")
		return
	}
	// "/role one or two lines" saves the poster's own role (chat_traits.go).
	if trait, isRole := slashRole(text); isRole {
		h.applyTrait(w, r, ns, relPath, label, trait)
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
	// The post is the result of whatever the poster said it was working on.
	h.status.posted(ns, relPath, label)
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

// Chat images come from two places, and a message names one with
// ![nod](gif:nod):
//   - the built-in set, embedded in the binary (chatgifs/*.svg), so every
//     install has reactions with no setup;
//   - the namespace's ChatGifDir, an ordinary folder people manage in the
//     tree and agents add to with `mdnest create`. A file there with the
//     same name as a built-in overrides it, for that namespace only.
//
// avatar-NAME.* (in the namespace folder) is shown beside NAME's messages.
const ChatGifDir = "ChatGifs"

// BuiltinGifRoute serves the embedded set. It is public on purpose: generic
// artwork, no user data, and an <img> cannot send an Authorization header.
const BuiltinGifRoute = "/api/chat/gifs/builtin/"

//go:embed chatgifs/*.svg chatgifs/avatars/*.svg
var builtinGifFS embed.FS

var chatGifExts = map[string]bool{".gif": true, ".svg": true, ".png": true, ".webp": true, ".jpg": true, ".jpeg": true}

// ChatGif is one image a chat message can use.
type ChatGif struct {
	Name   string `json:"name"`             // what gif:NAME refers to, e.g. "nod" or "avatar-codxu"
	Path   string `json:"path"`             // namespace-relative ("ChatGifs/nod.svg") or, for a built-in, the absolute route
	Scope  string `json:"scope"`            // "workspace" or "builtin"
	Avatar string `json:"avatar,omitempty"` // set for avatar-NAME files: the poster it belongs to
	// Kind is "avatar-choice" for the built-in avatars a poster can pick
	// (`mdnest chat avatar --pick owl`). They are never shown as reactions and
	// never attached to a poster by name: picking one copies it to
	// ChatGifs/avatar-NAME.svg.
	Kind string `json:"kind,omitempty"`
}

func builtinGifs() []ChatGif {
	entries, _ := fs.ReadDir(builtinGifFS, "chatgifs")
	out := make([]ChatGif, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.TrimSuffix(e.Name(), path.Ext(e.Name()))
		out = append(out, ChatGif{Name: name, Path: BuiltinGifRoute + e.Name(), Scope: "builtin"})
	}
	avatars, _ := fs.ReadDir(builtinGifFS, "chatgifs/avatars")
	for _, e := range avatars {
		name := strings.TrimSuffix(e.Name(), path.Ext(e.Name()))
		out = append(out, ChatGif{Name: name, Path: BuiltinGifRoute + "avatars/" + e.Name(), Scope: "builtin", Kind: "avatar-choice"})
	}
	return out
}

// HandleGifs lists every image a chat in this namespace can use: the
// namespace's own, then the built-ins it does not override. The tree shows
// only text files, so without this neither the UI nor an agent could see them.
func (h *ChatHandler) HandleGifs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return
	}
	gifs := []ChatGif{}
	have := map[string]bool{}
	entries, err := h.store.ReadDir(r.Context(), ns, ChatGifDir)
	if err != nil && !errors.Is(err, storage.ErrNotExist) {
		chatJSONError(w, http.StatusInternalServerError, "failed to list chat gifs")
		return
	}
	// The library is a folder of the namespace: list only what the user may
	// read (grants can be path-scoped; /api/files checks each image again).
	canRead := middleware.ReadFilterFor(r, ns)
	for _, e := range entries {
		ext := strings.ToLower(path.Ext(e.Name))
		if e.IsDir || !chatGifExts[ext] || strings.HasPrefix(e.Name, ".") || !canRead(ChatGifDir+"/"+e.Name) {
			continue
		}
		name := strings.TrimSuffix(e.Name, path.Ext(e.Name))
		g := ChatGif{Name: name, Path: ChatGifDir + "/" + e.Name, Scope: "workspace"}
		if strings.HasPrefix(strings.ToLower(name), "avatar-") {
			g.Avatar = name[len("avatar-"):]
		}
		gifs = append(gifs, g)
		have[strings.ToLower(name)] = true
	}
	sort.Slice(gifs, func(i, j int) bool { return gifs[i].Path < gifs[j].Path })
	for _, g := range builtinGifs() {
		if g.Kind == "avatar-choice" || !have[strings.ToLower(g.Name)] {
			gifs = append(gifs, g)
		}
	}
	if r.URL.Query().Get("format") == "text" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		var b strings.Builder
		for _, g := range gifs {
			switch {
			case g.Kind == "avatar-choice":
				fmt.Fprintf(&b, "avatar choice\t%s\t(mdnest chat avatar ... --pick %s)\n", g.Name, g.Name)
			case g.Avatar != "":
				fmt.Fprintf(&b, "avatar of %s\t%s (%s)\n", g.Avatar, g.Path, g.Scope)
			default:
				fmt.Fprintf(&b, "![%s](gif:%s)\t%s\n", g.Name, g.Name, g.Scope)
			}
		}
		io.WriteString(w, b.String())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"gifs": gifs})
}

// HandleBuiltinGif serves one embedded image, inert and cacheable.
func HandleBuiltinGif(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	// Either "<name>.svg" (a reaction) or "avatars/<name>.svg" (an avatar
	// choice). Nothing else: the embedded FS holds only these two folders,
	// and anything with ".." or more segments is refused before the lookup.
	rel := strings.TrimPrefix(r.URL.Path, BuiltinGifRoute)
	dir, name := "", rel
	if strings.HasPrefix(rel, "avatars/") {
		dir, name = "avatars/", strings.TrimPrefix(rel, "avatars/")
	}
	if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	data, err := builtinGifFS.ReadFile("chatgifs/" + dir + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	setServedFileSafetyHeaders(w, name, "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(data)
}

// ChatEnabled decides ENABLE_CHAT. Chat is on by default: it is a note plus
// a handful of endpoints, and agents coordinating in a chat are not users,
// so it is as useful in single mode as in multi. "false" turns it off. The
// exception is the multi-replica app role (MDNEST_ROLE=app): posts are
// serialised by a per-process lock, which cannot stop two replicas
// appending at once, so there it stays off unless the operator opts in.
func ChatEnabled(setting, role string) bool {
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	}
	return role != "app"
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
	// The account that makes a note a chat owns it: only the owner or an
	// admin may delete it later (chat_owner.go).
	if out != existing {
		out = stampChatOwner(out, requestOwnerName(r))
	}
	// ?private=1 makes the chat private to the caller. The member list is
	// written BEFORE the note: a new chat must never exist, even briefly,
	// as an open one that every reader of the namespace can see.
	if r.URL.Query().Get("private") == "1" {
		// Only for a new note. On an existing one it would let anyone with
		// write access turn a shared note (or an open chat) into something
		// only they can open. An existing chat is made private through
		// /api/chat/members, which only accepts a chat.
		if !created {
			chatJSONError(w, http.StatusConflict, "private=1 only creates a new chat; use the chat's members to make an existing one private")
			return
		}
		if !PrivateChatPathOK(relPath) {
			chatJSONError(w, http.StatusBadRequest, "a private chat needs a plain ASCII path")
			return
		}
		// The list is keyed by the lowercased path: on a case-sensitive disk
		// it would also cover an existing note spelled with other capitals.
		if foldedMatches(ctx, h.store, ns, relPath) > 0 {
			chatJSONError(w, http.StatusConflict, "another note has this name in different letter case; pick another name")
			return
		}
		uc := middleware.UserFromContext(ctx)
		if h.members == nil || uc == nil || uc.ID <= 0 {
			chatJSONError(w, http.StatusBadRequest, "private chats are not available here")
			return
		}
		if err := h.members.Add(ns, "/"+relPath, uc.ID, uc.ID); err != nil {
			chatJSONError(w, http.StatusInternalServerError, "failed to make the chat private")
			return
		}
		// Anyone who joined the live room for this path before the note
		// existed would otherwise stay connected to a private chat.
		defer h.dropNonMembers(ns, relPath, "/"+relPath)
	}
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
	// Private is true for a chat with a member list (chat_members.go). Only
	// members ever see a private chat in the list.
	Private bool `json:"private,omitempty"`
	// Owner and CanDelete as in chatResponse.
	Owner     string `json:"owner,omitempty"`
	CanDelete bool   `json:"canDelete"`
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
		var private map[string][]int
		if h.members != nil {
			private, _ = h.members.Restricted(ns)
		}
		for _, c := range h.scanNamespace(ctx, ns) {
			if h.canRead(r, ns, "/"+c.Path) {
				_, c.Private = private[strings.ToLower("/"+c.Path)] // keys are lowercased
				c.CanDelete = mayRemoveOwnedBy(r, ns, c.Owner)
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
	sum := ChatSummary{Namespace: ns, Path: relPath, Title: chatTitle(doc, relPath), Count: len(doc.Messages), Owner: ChatOwner(string(data))}
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
