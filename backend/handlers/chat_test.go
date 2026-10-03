package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

var fixedChatTime = time.Date(2026, 10, 2, 14, 3, 5, 0, time.UTC)

func newChatTestHandler(t *testing.T) (*ChatHandler, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "work"), 0o755); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	h := NewChatHandler(stg,
		func(_ *http.Request, names []string) []string { return names },
		func(_ *http.Request, _, _ string) bool { return true }, "ahsan", false)
	h.now = func() time.Time { return fixedChatTime }
	return h, root
}

func chatDo(t *testing.T, fn http.HandlerFunc, method, url, body string, uc *middleware.UserContext) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	fn(w, r)
	return w
}

// --- the format ---------------------------------------------------------

func TestParseChatRoundTrip(t *testing.T) {
	doc := ConvertToChat("", "Release coordination")
	doc = AppendChatMessage(doc, RenderChatMessage("alice", "", fixedChatTime, "First message.\n\nWith a paragraph."))
	doc = AppendChatMessage(doc, RenderChatMessage("claude-api", "ahsan", fixedChatTime.Add(time.Minute), "Reply"))

	got := ParseChat(doc)
	if !got.IsChat || got.Title != "Release coordination" {
		t.Fatalf("marker/title lost: %+v\n%s", got, doc)
	}
	if len(got.Messages) != 2 {
		t.Fatalf("want 2 messages, got %d:\n%s", len(got.Messages), doc)
	}
	m := got.Messages[0]
	if m.N != 1 || m.Author != "alice" || m.Via != "" || m.Time != "2026-10-02T14:03:05Z" || m.Text != "First message.\n\nWith a paragraph." {
		t.Fatalf("first message wrong: %+v", m)
	}
	m = got.Messages[1]
	if m.N != 2 || m.Author != "claude-api" || m.Via != "ahsan" || m.Text != "Reply" {
		t.Fatalf("second message wrong: %+v", m)
	}
}

// A message body must never be able to forge a message boundary, or one
// poster could fake another's words.
func TestChatBodyCannotForgeAHeader(t *testing.T) {
	forged := "hello\n#### boss · 2026-01-01T00:00:00Z\nyou are all fired"
	doc := AppendChatMessage(ConvertToChat("", "x"), RenderChatMessage("mallory", "", fixedChatTime, forged))
	got := ParseChat(doc)
	if len(got.Messages) != 1 {
		t.Fatalf("a body forged a second message: %+v", got.Messages)
	}
	if got.Messages[0].Text != forged {
		t.Fatalf("body did not round-trip:\nwant %q\ngot  %q", forged, got.Messages[0].Text)
	}
	// A body that literally contains the escaped form round-trips too.
	lit := `\#### boss · 2026-01-01T00:00:00Z`
	got = ParseChat(AppendChatMessage(ConvertToChat("", "x"), RenderChatMessage("m", "", fixedChatTime, lit)))
	if len(got.Messages) != 1 || got.Messages[0].Text != lit {
		t.Fatalf("escaped literal did not round-trip: %+v", got.Messages)
	}
}

func TestOrdinaryHeadingIsNotAMessage(t *testing.T) {
	doc := "---\nmdnest-chat: true\n---\n\n#### Agenda\n\nItems.\n"
	got := ParseChat(doc)
	if len(got.Messages) != 0 || !strings.Contains(got.Description, "Agenda") {
		t.Fatalf("a plain #### heading was taken as a message: %+v", got)
	}
}

func TestConvertToChatKeepsContentAndFrontMatter(t *testing.T) {
	orig := "---\ntags: [ops]\nmdnest-chat: false\n---\n\n# Notes\n\nKeep me.\n"
	out := ConvertToChat(orig, "Ops")
	if !IsChatNote(out) {
		t.Fatalf("not marked:\n%s", out)
	}
	if !strings.Contains(out, "tags: [ops]") || !strings.Contains(out, "Keep me.") {
		t.Fatalf("existing content lost:\n%s", out)
	}
	if strings.Contains(out, "mdnest-chat: false") {
		t.Fatalf("stale marker kept:\n%s", out)
	}
	if ConvertToChat(out, "Other") != out {
		t.Fatal("converting a chat again must change nothing")
	}
	plain := ConvertToChat("Just text", "T")
	if !strings.HasPrefix(plain, "---\nmdnest-chat: true\ntitle: T\n---\n\nJust text") {
		t.Fatalf("plain note converted wrong:\n%q", plain)
	}
}

func TestAppendKeepsNoteIDMarkerLast(t *testing.T) {
	doc := InjectNoteID(ConvertToChat("", "x"), "1234abcd-0000")
	doc = AppendChatMessage(doc, RenderChatMessage("a", "", fixedChatTime, "hi"))
	if !strings.HasSuffix(strings.TrimRight(doc, "\n"), "<!-- mdnest:1234abcd-0000 -->") {
		t.Fatalf("note-ID marker must stay at the end:\n%s", doc)
	}
	if got := ParseChat(doc); len(got.Messages) != 1 || got.Messages[0].Text != "hi" {
		t.Fatalf("marker leaked into the message: %+v", got.Messages)
	}
}

func TestSanitizeChatLabel(t *testing.T) {
	if got := sanitizeChatLabel("bob (via admin)\n· x"); strings.ContainsAny(got, "()\n·") {
		t.Fatalf("label kept header syntax: %q", got)
	}
}

// --- the handler --------------------------------------------------------

func TestChatPostRejectsANoteThatIsNotAChat(t *testing.T) {
	h, root := newChatTestHandler(t)
	os.WriteFile(filepath.Join(root, "work", "plain.md"), []byte("# hi\n"), 0o644)
	w := chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=plain.md", "hello", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("posting to a plain note must be refused, got %d %s", w.Code, w.Body)
	}
	data, _ := os.ReadFile(filepath.Join(root, "work", "plain.md"))
	if string(data) != "# hi\n" {
		t.Fatalf("plain note was modified: %q", data)
	}
}

func TestChatCreatePostRead(t *testing.T) {
	h, _ := newChatTestHandler(t)
	w := chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=Chats/release.md&title=Release", "", nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	if w := chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=Chats/release.md&as=claude-a", "ready?", nil); w.Code != http.StatusCreated {
		t.Fatalf("post: %d %s", w.Code, w.Body)
	}
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=Chats/release.md", "yes", nil)

	w = chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=Chats/release.md&after=1", "", nil)
	var resp chatResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Count != 2 || len(resp.Messages) != 1 || resp.Messages[0].Text != "yes" || resp.Messages[0].Author != "ahsan" {
		t.Fatalf("after=1 should return only the second message from the single-mode user: %+v", resp)
	}
	if resp.Title != "Release" {
		t.Fatalf("title = %q", resp.Title)
	}

	w = chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=Chats/release.md&format=text", "", nil)
	if !strings.Contains(w.Body.String(), "[#1] claude-a · 2026-10-02T14:03:05Z\nready?") {
		t.Fatalf("text format wrong:\n%s", w.Body)
	}
}

// The reason the per-note lock exists: N posters at once must produce N
// messages, none lost.
func TestConcurrentPostsAreAllKept(t *testing.T) {
	h, root := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=busy.md", "", nil)
	const n = 40
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			chatDo(t, h.Handle, http.MethodPost, fmt.Sprintf("/api/chat?ns=work&path=busy.md&as=agent-%d", i), fmt.Sprintf("msg %d", i), nil)
		}(i)
	}
	wg.Wait()
	data, _ := os.ReadFile(filepath.Join(root, "work", "busy.md"))
	if got := len(ParseChat(string(data)).Messages); got != n {
		t.Fatalf("concurrent posts lost messages: want %d, got %d", n, got)
	}
}

// Same guarantee for the plain append endpoint, which agents without the
// chat command use.
func TestConcurrentAppendsAreAllKept(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "work"), 0o755)
	stg, _ := storage.NewLocalStorage(root)
	nh := NewNoteHandler(stg)
	const n = 40
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			chatDo(t, nh.Handle, http.MethodPatch, "/api/note?ns=work&path=log.md", fmt.Sprintf("line-%d", i), nil)
		}(i)
	}
	wg.Wait()
	data, _ := os.ReadFile(filepath.Join(root, "work", "log.md"))
	for i := 0; i < n; i++ {
		if !strings.Contains(string(data), fmt.Sprintf("line-%d\n", i)) && !strings.HasSuffix(string(data), fmt.Sprintf("line-%d", i)) {
			t.Fatalf("append line-%d was lost:\n%s", i, data)
		}
	}
}

// In multi mode `as` is a label, never an identity: a label that is not the
// account is recorded as "label (via account)".
func TestMultiModeAuthorCannotImpersonate(t *testing.T) {
	h, root := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=c.md", "", nil)
	bob := &middleware.UserContext{ID: 2, Username: "bob"}
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=alice", "hi", bob)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md", "plain", bob)
	data, _ := os.ReadFile(filepath.Join(root, "work", "c.md"))
	msgs := ParseChat(string(data)).Messages
	if msgs[0].Author != "alice" || msgs[0].Via != "bob" {
		t.Fatalf("label must carry the real account: %+v", msgs[0])
	}
	if msgs[1].Author != "bob" || msgs[1].Via != "" {
		t.Fatalf("no label means the account itself: %+v", msgs[1])
	}
}

func TestChatListFindsOnlyChatsTheCallerCanRead(t *testing.T) {
	h, root := newChatTestHandler(t)
	os.MkdirAll(filepath.Join(root, "work", "secret"), 0o755)
	os.WriteFile(filepath.Join(root, "work", "plain.md"), []byte("not a chat\n"), 0o644)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=open.md&title=Open", "", nil)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=secret/hidden.md", "", nil)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=open.md", "latest", nil)

	h.canRead = func(_ *http.Request, _, p string) bool { return !strings.HasPrefix(p, "/secret/") }
	w := chatDo(t, h.HandleList, http.MethodGet, "/api/chats", "", nil)
	var resp struct{ Chats []ChatSummary }
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Chats) != 1 || resp.Chats[0].Path != "open.md" || resp.Chats[0].Count != 1 || resp.Chats[0].LastText != "latest" {
		t.Fatalf("list wrong: %+v", resp.Chats)
	}

	// The index must notice a new post (size/mtime changed) on the next list.
	time.Sleep(10 * time.Millisecond)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=open.md", "newer", nil)
	w = chatDo(t, h.HandleList, http.MethodGet, "/api/chats", "", nil)
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Chats[0].Count != 2 || resp.Chats[0].LastText != "newer" {
		t.Fatalf("index served a stale summary: %+v", resp.Chats[0])
	}
}

func TestChatListDeniesWithoutFilters(t *testing.T) {
	h, _ := newChatTestHandler(t)
	h.nsFilter = nil
	if w := chatDo(t, h.HandleList, http.MethodGet, "/api/chats", "", nil); w.Code != http.StatusForbidden {
		t.Fatalf("a missing access filter must deny, got %d", w.Code)
	}
}

// --- security review regressions ---------------------------------------

// The grant check in front of these routes sees the path as SENT, while
// SafeRelPath cleans it. A non-canonical path must be refused, or a grant on
// /Shared authorises a write to /Private via "Shared/../Private/x.md".
func TestChatRefusesNonCanonicalPaths(t *testing.T) {
	h, root := newChatTestHandler(t)
	for _, p := range []string{"Shared/../Private/x.md", "./x.md", "a//x.md", "Shared/./x.md"} {
		w := chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path="+p, "", nil)
		if w.Code != http.StatusBadRequest {
			t.Errorf("path %q: want 400, got %d %s", p, w.Code, w.Body)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "work", "Private")); err == nil {
		t.Fatal("a traversal path created a folder outside the requested one")
	}
}

// ?ns= on the list must name a real namespace, never a path to walk.
func TestChatListRejectsNamespaceTraversal(t *testing.T) {
	h, _ := newChatTestHandler(t)
	for _, ns := range []string{"../..", "..", "work/..", "nope"} {
		w := chatDo(t, h.HandleList, http.MethodGet, "/api/chats?ns="+ns, "", nil)
		if w.Code != http.StatusNotFound {
			t.Errorf("ns=%q: want 404, got %d %s", ns, w.Code, w.Body)
		}
	}
	if w := chatDo(t, h.HandleList, http.MethodGet, "/api/chats?ns=work", "", nil); w.Code != http.StatusOK {
		t.Fatalf("a real namespace must still list: %d", w.Code)
	}
}

// Multi mode: a request with no user context (a token mapped to no user)
// must not post — it could otherwise choose any label with no "(via …)".
func TestMultiModePostWithoutUserIsRefused(t *testing.T) {
	h, root := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=c.md", "", nil)
	h.multiMode = true
	w := chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=boss", "hi", nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d %s", w.Code, w.Body)
	}
	data, _ := os.ReadFile(filepath.Join(root, "work", "c.md"))
	if len(ParseChat(string(data)).Messages) != 0 {
		t.Fatal("an unattributable post was written")
	}
}

func TestLabelsAndTextOutputAreTerminalSafe(t *testing.T) {
	if got := sanitizeChatLabel("evil\x1b[2J‮admin"); strings.ContainsAny(got, "\x1b‮") {
		t.Fatalf("label kept a control/bidi char: %q", got)
	}
	out := formatChatMessageText(ChatMessage{N: 1, Author: "a", Time: "t", Text: "x\x1b]52;c;ZXZpbA==\x07y\nok"})
	if strings.ContainsAny(out, "\x1b\x07") || !strings.Contains(out, "\nok") {
		t.Fatalf("text output must drop escapes and keep newlines: %q", out)
	}
}

// Only the head of a file is read to decide whether it is a chat, so the
// marker must still be found when the chat itself is large.
func TestLargeChatStillListed(t *testing.T) {
	h, root := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=big.md&title=Big", "", nil)
	big := strings.Repeat("word ", 4000)
	for i := 0; i < 5; i++ {
		chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=big.md", big, nil)
	}
	os.WriteFile(filepath.Join(root, "work", "huge-plain.md"), []byte(strings.Repeat("x", 1<<20)), 0o644)
	w := chatDo(t, h.HandleList, http.MethodGet, "/api/chats", "", nil)
	var resp struct{ Chats []ChatSummary }
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Chats) != 1 || resp.Chats[0].Count != 5 {
		t.Fatalf("large chat not listed correctly: %+v", resp.Chats)
	}
}

// exclude lets a waiting agent ignore its own posts. The count header still
// reports every message, so the agent can move its cursor past its own.
func TestChatReadExcludesOneAuthor(t *testing.T) {
	h, _ := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=c.md", "", nil)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=codxu", "mine", nil)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=codu", "theirs", nil)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=codxu", "mine again", nil)

	w := chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=c.md&exclude=codxu&format=text", "", nil)
	out := w.Body.String()
	if !strings.Contains(out, "theirs") || strings.Contains(out, "mine") {
		t.Fatalf("exclude=codxu should return only codu's message:\n%s", out)
	}
	if got := w.Header().Get("X-Chat-Count"); got != "3" {
		t.Fatalf("X-Chat-Count must count every message, got %q", got)
	}
	w = chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=c.md&after=2&exclude=codxu&format=text", "", nil)
	if strings.TrimSpace(w.Body.String()) != "" {
		t.Fatalf("after #2 only codxu has posted, so nothing should come back:\n%s", w.Body)
	}
}

func TestChatMentions(t *testing.T) {
	for _, tc := range []struct {
		text, name string
		want       bool
	}{
		{"@codxu can you take the frontend?", "codxu", true},
		{"thanks @CodXu.", "codxu", true},
		{"@all standup in 5", "codxu", true},
		{"@everyone please read", "codxu", true},
		{"@codu only", "codxu", false},
		{"mail me at x@codxu.com", "codxu", false},
		{"no mention here", "codxu", false},
		{"@codxu-bot is someone else", "codxu", false},
	} {
		if got := ChatMentions(tc.text, tc.name); got != tc.want {
			t.Errorf("ChatMentions(%q, %q) = %v, want %v", tc.text, tc.name, got, tc.want)
		}
	}
}

func TestChatReadMentionFilter(t *testing.T) {
	h, _ := newChatTestHandler(t)
	chatDo(t, h.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=c.md", "", nil)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=ahsan", "@codu do the backend", nil)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=ahsan", "@codxu do the frontend", nil)
	chatDo(t, h.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md&as=ahsan", "@all lunch", nil)
	w := chatDo(t, h.Handle, http.MethodGet, "/api/chat?ns=work&path=c.md&mention=codxu&format=text", "", nil)
	out := w.Body.String()
	if strings.Contains(out, "backend") || !strings.Contains(out, "frontend") || !strings.Contains(out, "lunch") {
		t.Fatalf("mention=codxu should return the frontend and @all messages only:\n%s", out)
	}
}

func TestChatGifsMergesWorkspaceAndBuiltins(t *testing.T) {
	h, root := newChatTestHandler(t)
	dir := filepath.Join(root, "work", "ChatGifs")
	os.MkdirAll(dir, 0o755)
	for _, f := range []string{"nod.svg", "avatar-codxu.gif", "party.svg", "notes.md", ".hidden.svg"} {
		os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644)
	}
	w := chatDo(t, h.HandleGifs, http.MethodGet, "/api/chat/gifs?ns=work", "", nil)
	var resp struct{ Gifs []ChatGif }
	json.Unmarshal(w.Body.Bytes(), &resp)
	byName := map[string]ChatGif{}
	for _, g := range resp.Gifs {
		if _, dup := byName[g.Name]; dup {
			t.Fatalf("%q listed twice; a workspace file must REPLACE the built-in: %+v", g.Name, resp.Gifs)
		}
		byName[g.Name] = g
	}
	if g := byName["nod"]; g.Scope != "workspace" || g.Path != "ChatGifs/nod.svg" {
		t.Fatalf("the workspace nod should override the built-in: %+v", g)
	}
	if g := byName["done"]; g.Scope != "builtin" || g.Path != BuiltinGifRoute+"done.svg" {
		t.Fatalf("built-ins must be listed: %+v", g)
	}
	if g := byName["avatar-codxu"]; g.Avatar != "codxu" {
		t.Fatalf("avatar not recognised: %+v", g)
	}
	if _, ok := byName["notes"]; ok {
		t.Fatal("non-image files must not be listed")
	}
	if _, ok := byName[".hidden"]; ok {
		t.Fatal("dotfiles must not be listed")
	}
	// A namespace with no folder still gets the built-ins.
	os.MkdirAll(filepath.Join(root, "other"), 0o755)
	w = chatDo(t, h.HandleGifs, http.MethodGet, "/api/chat/gifs?ns=other", "", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"scope":"builtin"`) {
		t.Fatalf("an empty namespace should still list the built-ins: %d %s", w.Code, w.Body)
	}
}

func TestBuiltinGifIsServedInert(t *testing.T) {
	rec := httptest.NewRecorder()
	HandleBuiltinGif(rec, httptest.NewRequest(http.MethodGet, BuiltinGifRoute+"nod.svg", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/svg+xml" {
		t.Fatalf("status %d type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("built-in SVG must carry the sandbox CSP and nosniff: %v", rec.Header())
	}
	for _, bad := range []string{"../chat.go", "missing.svg", ""} {
		rec := httptest.NewRecorder()
		HandleBuiltinGif(rec, httptest.NewRequest(http.MethodGet, BuiltinGifRoute+bad, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%q: want 404, got %d", bad, rec.Code)
		}
	}
}

func TestChatEnabledDefaults(t *testing.T) {
	for _, tc := range []struct {
		setting, role string
		want          bool
	}{
		{"", "single", true},  // on by default, single mode included
		{"", "writer", true},  // the writer is a single process
		{"", "app", false},    // replicas: the per-process lock cannot help
		{"true", "app", true}, // an operator may opt in
		{"false", "single", false},
		{"FALSE", "single", false},
		{"nonsense", "single", true},
	} {
		if got := ChatEnabled(tc.setting, tc.role); got != tc.want {
			t.Errorf("ChatEnabled(%q, %q) = %v, want %v", tc.setting, tc.role, got, tc.want)
		}
	}
}
