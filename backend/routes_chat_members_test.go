package main

// Private chats (issue #127), driven through the REAL route table and the REAL
// auth middleware, the same way routes_test.go pins the v4.6.2 access fixes.
// Membership is enforced in the permission checker, so these tests walk every
// route that can serve, list, carry off, change or remove a note and check a
// non-member gets nothing from any of them.

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

const (
	uidMia   = 5 // write on alpha:/, member of the private chat
	uidNate  = 6 // write on alpha:/ and beta:/, NOT a member
	uidAdmin = 7 // namespace admin of alpha, NOT a member
)

// memChatMembers is an in-memory store.ChatMemberStore with the Postgres
// store's semantics, including the folder-prefix rules.
type memChatMembers struct {
	mu   sync.Mutex
	rows map[string][]int // "ns\x00/path" -> user ids
}

func newMemChatMembers() *memChatMembers { return &memChatMembers{rows: map[string][]int{}} }

// Keys are lowercased, as the Postgres store keys them.
func ck(ns, p string) string { return ns + "\x00" + strings.ToLower("/"+strings.Trim(p, "/")) }

func under(root, p string) bool {
	root = strings.ToLower("/" + strings.Trim(root, "/"))
	return root == "/" || p == root || strings.HasPrefix(p, root+"/")
}

func (m *memChatMembers) Members(ns, p string) ([]int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]int(nil), m.rows[ck(ns, p)]...), nil
}

func (m *memChatMembers) Restricted(ns string) (map[string][]int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string][]int{}
	for k, ids := range m.rows {
		parts := strings.SplitN(k, "\x00", 2)
		if parts[0] == ns && len(ids) > 0 {
			out[parts[1]] = append([]int(nil), ids...)
		}
	}
	return out, nil
}

func (m *memChatMembers) List(ns, p string) ([]store.ChatMember, error) {
	ids, _ := m.Members(ns, p)
	out := []store.ChatMember{}
	for _, id := range ids {
		out = append(out, store.ChatMember{UserID: id, Username: "user" + string(rune('0'+id))})
	}
	return out, nil
}

func (m *memChatMembers) Add(ns, p string, uid, _ int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := ck(ns, p)
	for _, id := range m.rows[k] {
		if id == uid {
			return nil
		}
	}
	m.rows[k] = append(m.rows[k], uid)
	return nil
}

func (m *memChatMembers) Invite(ns, p string, caller, target int, mayOpen bool) error {
	ids, _ := m.Members(ns, p)
	isMember := false
	for _, id := range ids {
		isMember = isMember || id == caller
	}
	if (len(ids) == 0 && !mayOpen) || (len(ids) > 0 && !isMember) {
		return store.ErrChatNotAllowed
	}
	if len(ids) == 0 {
		m.Add(ns, p, caller, caller)
	}
	if target > 0 {
		m.Add(ns, p, target, caller)
	}
	return nil
}

func (m *memChatMembers) Remove(ns, p string, uid int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := ck(ns, p)
	ids := m.rows[k]
	for i, id := range ids {
		if id == uid {
			if len(ids) == 1 {
				return store.ErrLastChatMember
			}
			m.rows[k] = append(ids[:i:i], ids[i+1:]...)
			return nil
		}
	}
	return nil
}

func (m *memChatMembers) CopyPrefix(fromNS, from, toNS, to string) (*store.ChatCopy, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f := strings.ToLower("/" + strings.Trim(from, "/"))
	t := strings.ToLower("/" + strings.Trim(to, "/"))
	c := &store.ChatCopy{NS: toNS}
	add := map[string][]int{}
	for k, ids := range m.rows {
		parts := strings.SplitN(k, "\x00", 2)
		if parts[0] == fromNS && under(f, parts[1]) {
			add[t+strings.TrimPrefix(parts[1], f)] = append([]int(nil), ids...)
		}
	}
	for p, ids := range add {
		c.Paths = append(c.Paths, p)
		for _, id := range m.rows[toNS+"\x00"+p] {
			c.Replaced = append(c.Replaced, store.ChatMemberRow{Path: p, UserID: id})
		}
		m.rows[toNS+"\x00"+p] = ids
	}
	return c, nil
}

func (m *memChatMembers) RestoreCopy(c *store.ChatCopy) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range c.Paths {
		delete(m.rows, c.NS+"\x00"+p)
	}
	for _, r := range c.Replaced {
		k := c.NS + "\x00" + r.Path
		m.rows[k] = append(m.rows[k], r.UserID)
	}
	return nil
}

// memUsers is UsersForNamespace over the fixture's grants.
type memUsers struct{ grants *memGrants }

func (m memUsers) UsersForNamespace(ns string) ([]store.NamespaceUser, error) {
	seen := map[int]bool{}
	var out []store.NamespaceUser
	for _, g := range m.grants.grants {
		if g.Namespace == ns && !seen[g.UserID] {
			seen[g.UserID] = true
			out = append(out, store.NamespaceUser{ID: g.UserID, Username: "user" + string(rune('0'+g.UserID))})
		}
	}
	return out, nil
}

// buildChatFixture:
//
//	alpha/Chats/secret.md   private chat (Owen + Mia): SECRET-WORDS, SECRET-TASK
//	                        (both chats' first message is Owen's, user3, so he owns them)
//	alpha/Chats/open.md     open chat, as every chat was before
//	alpha/Notes/a.md        an ordinary note
//	beta/                   empty, writable by Owen and Nate
func buildChatFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, d := range []string{"alpha/Chats", "alpha/Notes", "beta"} {
		os.MkdirAll(filepath.Join(root, d), 0o755)
	}
	write := func(rel, body string) {
		os.WriteFile(filepath.Join(root, filepath.FromSlash(rel)), []byte(body), 0o644)
	}
	write("alpha/Chats/secret.md", "---\nmdnest-chat: true\ntitle: SECRET-ROOM\n---\n\n"+
		"#### user3 · 2026-10-07T10:00:00Z\nSECRET-WORDS\n- [ ] SECRET-TASK\n")
	write("alpha/Chats/open.md", "---\nmdnest-chat: true\ntitle: OPEN-ROOM\n---\n\n"+
		"#### user3 · 2026-10-07T10:00:00Z\nopen words\n")
	write("alpha/Notes/a.md", "plain note\n")
	return root
}

type chatServer struct {
	*testServer
	members *memChatMembers
	perms   *middleware.PermissionChecker
}

func newChatServer(t *testing.T) *chatServer {
	t.Helper()
	root := buildChatFixture(t)
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	ts := &testServer{t: t, root: root}
	ts.tokens = handlers.NewTokenHandler(&memTokens{})

	mg := &memGrants{grants: []store.Grant{
		{UserID: uidOwen, Namespace: "alpha", Path: "/", Permission: "write"},
		{UserID: uidMia, Namespace: "alpha", Path: "/", Permission: "write"},
		{UserID: uidNate, Namespace: "alpha", Path: "/", Permission: "write"},
		{UserID: uidOwen, Namespace: "beta", Path: "/", Permission: "write"},
		{UserID: uidNate, Namespace: "beta", Path: "/", Permission: "write"},
		// A grant on one folder, so listings go through the per-path branch
		// of the read filter rather than the whole-namespace one.
		{UserID: uidPat, Namespace: "alpha", Path: "/Chats", Permission: "write"},
	}}
	gr := &memGroups{members: map[int][]store.GroupGrant{}}
	na := &memNsAdmins{of: map[int][]string{uidAdmin: {"alpha"}}}
	members := newMemChatMembers()
	members.Add("alpha", "/Chats/secret.md", uidOwen, uidOwen)
	members.Add("alpha", "/Chats/secret.md", uidMia, uidOwen)

	// Wired as main() wires it.
	perms := middleware.NewPermissionChecker(mg, na, gr)
	perms.SetStorage(stg)
	perms.SetChatMembers(members)

	search := handlers.NewSearchHandler(stg)
	note := handlers.NewNoteHandler(stg)
	move := handlers.NewMoveHandler(stg)
	move.SetChatMembers(members)
	tCanRead, tCanWrite := handlers.TransferPermissionFuncs(perms)
	transfer := handlers.NewTransferHandler(stg, handlers.DefaultTreeLimits, tCanRead, tCanWrite, search.InvalidateCache)
	transfer.SetChatMembers(members, perms.CheckWriteDest)
	chat := handlers.NewChatHandler(stg, perms.FilterNamespaces, perms.CheckRead, "admin", true)
	chat.SetMembers(members, memUsers{grants: mg})
	hub := collab.NewHub()
	chat.SetCollabHub(hub)

	invalidate := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r)
			if ns := r.URL.Query().Get("ns"); ns != "" && r.Method != http.MethodGet {
				search.InvalidateCache(ns)
			}
		})
	}
	auth := middleware.NewAuthMiddleware(testSecret, true, ts.tokens, ts.tokens)
	routes := contentRoutes{
		auth:        auth.Wrap,
		perms:       perms,
		invalidate:  invalidate,
		ns:          handlers.NewNamespaceHandler(stg, perms, nil),
		tree:        handlers.NewTreeHandler(stg, mg, gr),
		note:        note,
		history:     handlers.NewHistoryHandler(root),
		attribution: handlers.NewAttributionHandler(stg, memActivity{}),
		comments:    handlers.NewCommentsHandler(stg),
		upload:      handlers.NewUploadHandler(stg, perms),
		move:        move,
		download:    handlers.NewDownloadHandler(stg, handlers.DefaultTreeLimits, 2),
		transfer:    transfer,
		search:      search,
		tasks:       handlers.NewTaskHandler(stg, perms.FilterNamespaces, perms.CheckWrite),
		chat:        chat,
		sync:        handlers.NewSyncHandler(root, search.InvalidateCache, na),
		restart:     handlers.NewRestartHandler(func() {}),
		ws:          handlers.NewWSHandler(hub, testSecret, perms),
	}
	mux := http.NewServeMux()
	registerContentRoutes(mux, routes)
	ts.srv = httptest.NewServer(mux)
	t.Cleanup(ts.srv.Close)
	return &chatServer{testServer: ts, members: members, perms: perms}
}

func (cs *chatServer) exists(rel string) bool {
	_, err := os.Stat(filepath.Join(cs.root, filepath.FromSlash(rel)))
	return err == nil
}

func zipNames(t *testing.T, body string) []string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader([]byte(body)), int64(len(body)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	return names
}

const secretQ = "ns=alpha&path=Chats/secret.md"

// Every route that reads a note, for a non-member with write on the whole
// namespace and for a namespace admin who is not on the chat.
func TestPrivateChat_NonMemberIsRefusedEverywhere(t *testing.T) {
	cs := newChatServer(t)
	for name, tok := range map[string]string{
		"collaborator": jwtFor(t, uidNate, "collaborator", nil),
		"ns admin":     jwtFor(t, uidAdmin, "admin", nil),
		"folder grant": jwtFor(t, uidPat, "collaborator", nil),
	} {
		for _, p := range []string{
			"/api/note?" + secretQ,
			"/api/chat?" + secretQ,
			"/api/chat?" + secretQ + "&format=text",
			"/api/chat/members?" + secretQ,
			"/api/comments?" + secretQ,
			"/api/note/attribution?" + secretQ,
			"/api/note/history?" + secretQ,
			"/api/download?" + secretQ,
			"/api/tasks?" + secretQ,
			"/api/files/alpha/Chats/secret.md",
		} {
			code, body := cs.get(tok, p)
			if code != http.StatusForbidden || strings.Contains(body, "SECRET") {
				t.Errorf("%s GET %s: %d %s", name, p, code, body)
			}
		}

		// Listings leave it out and keep everything else.
		for _, c := range []struct{ path, want string }{
			{"/api/tree?ns=alpha", "open.md"},
			{"/api/chats", "OPEN-ROOM"},
			{"/api/chats?format=text", "OPEN-ROOM"},
			{"/api/search?ns=alpha&q=SECRET", ""},
			{"/api/search?ns=alpha&q=secret.md", ""},
			{"/api/tasks?ns=alpha", ""},
			{"/api/tasks/all", ""},
		} {
			code, body := cs.get(tok, c.path)
			if name == "folder grant" && c.path == "/api/tasks?ns=alpha" {
				// The whole-namespace board needs read on the root, which a
				// folder grant does not have; refused before chats matter.
				if code != http.StatusForbidden {
					t.Errorf("%s %s: %d", name, c.path, code)
				}
				continue
			}
			if code != http.StatusOK || strings.Contains(body, "secret.md") || strings.Contains(body, "SECRET") {
				t.Errorf("%s %s leaked the private chat: %d %s", name, c.path, code, body)
			}
			if c.want != "" && !strings.Contains(body, c.want) {
				t.Errorf("%s %s lost the open chat: %s", name, c.path, body)
			}
		}

		// A folder download carries everything but the private chat.
		code, body := cs.get(tok, "/api/download?ns=alpha&path=Chats")
		if code != http.StatusOK {
			t.Fatalf("%s folder download: %d %s", name, code, body)
		}
		if got := strings.Join(zipNames(t, body), ","); strings.Contains(got, "secret") || !strings.Contains(got, "open.md") {
			t.Errorf("%s folder zip: %s", name, got)
		}
		if name != "folder grant" {
			code, body = cs.get(tok, "/api/download?ns=alpha")
			if code != http.StatusOK || strings.Contains(strings.Join(zipNames(t, body), ","), "secret") {
				t.Errorf("%s namespace zip carried the private chat", name)
			}
		}
	}
}

// Every route that changes, moves, copies or removes a note.
func TestPrivateChat_NonMemberCannotChangeIt(t *testing.T) {
	cs := newChatServer(t)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	before := cs.readFile("alpha/Chats/secret.md")
	writes := []struct{ method, path, body string }{
		{http.MethodPut, "/api/note?" + secretQ, "overwritten"},
		{http.MethodPatch, "/api/note?" + secretQ + "&position=append", "appended"},
		{http.MethodDelete, "/api/note?" + secretQ, ""},
		{http.MethodDelete, "/api/note?ns=alpha&path=Chats", ""},
		{http.MethodPost, "/api/chat?" + secretQ, "hello"},
		{http.MethodPost, "/api/chat/convert?" + secretQ, ""},
		{http.MethodPost, "/api/chat/status?" + secretQ, `{"text":"x"}`},
		{http.MethodPost, "/api/chat/agents?name=spy&" + secretQ, "spy on them"},
		{http.MethodPost, "/api/chat?as=spy&" + secretQ, "/role spy on them"},
		{http.MethodPost, "/api/chat/members?" + secretQ, ""},
		{http.MethodPost, "/api/chat/members?" + secretQ, `{"userId":6}`},
		{http.MethodPost, "/api/move?ns=alpha&from=Chats/secret.md&to=Notes/stolen.md", ""},
		{http.MethodPost, "/api/move?ns=alpha&from=Chats&to=Moved", ""},
		{http.MethodPost, "/api/transfer", `{"mode":"copy","from":{"ns":"alpha","path":"Chats/secret.md"},"to":{"ns":"beta","path":"stolen.md"}}`},
		{http.MethodPost, "/api/transfer", `{"mode":"copy","from":{"ns":"alpha","path":"Chats"},"to":{"ns":"beta","path":"Chats"}}`},
		{http.MethodPost, "/api/transfer", `{"mode":"move","from":{"ns":"alpha","path":"Chats"},"to":{"ns":"beta","path":"Chats"}}`},
	}
	for _, w := range writes {
		code, body := cs.do(nate, w.method, w.path, strings.NewReader(w.body), "application/json")
		if code < 400 || strings.Contains(body, "SECRET") {
			t.Errorf("%s %s %s: %d %s", w.method, w.path, w.body, code, body)
		}
	}
	if got := cs.readFile("alpha/Chats/secret.md"); got != before {
		t.Errorf("a refused call changed the chat: %q", got)
	}
	for _, p := range []string{"beta/stolen.md", "beta/Chats", "alpha/Notes/stolen.md", "alpha/Moved"} {
		if cs.exists(p) {
			t.Errorf("a refused call created %s", p)
		}
	}
	// The open chat next to it still works for Nate.
	if code, _ := cs.do(nate, http.MethodPost, "/api/chat?ns=alpha&path=Chats/open.md", strings.NewReader("hi"), "text/plain"); code != http.StatusOK && code != http.StatusCreated {
		t.Errorf("posting to the open chat: %d", code)
	}
}

func TestPrivateChat_MembersReadInviteAndRemove(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	mia := jwtFor(t, uidMia, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)

	for _, tok := range []string{owen, mia} {
		code, body := cs.get(tok, "/api/chat?"+secretQ)
		if code != http.StatusOK || !strings.Contains(body, "SECRET-WORDS") {
			t.Fatalf("member read: %d %s", code, body)
		}
		if _, body := cs.get(tok, "/api/chats"); !strings.Contains(body, `"private":true`) {
			t.Errorf("chat list does not mark it private: %s", body)
		}
	}

	// Mia invites Nate. He gets the whole history on his next request, with
	// the token he already had.
	code, body := cs.do(mia, http.MethodPost, "/api/chat/members?"+secretQ, strings.NewReader(`{"userId":6}`), "application/json")
	if code != http.StatusOK || !strings.Contains(body, `"id":6`) {
		t.Fatalf("invite: %d %s", code, body)
	}
	if code, body := cs.get(nate, "/api/chat?"+secretQ); code != http.StatusOK || !strings.Contains(body, "SECRET-WORDS") {
		t.Errorf("invited member cannot read the history: %d %s", code, body)
	}
	if _, body := cs.get(nate, "/api/tree?ns=alpha"); !strings.Contains(body, "secret.md") {
		t.Errorf("invited member does not see it in the tree: %s", body)
	}

	// Owen removes him: refused again at once.
	if code, _ := cs.do(owen, http.MethodDelete, "/api/chat/members?"+secretQ+"&userId=6", nil, ""); code != http.StatusOK {
		t.Fatalf("remove: %d", code)
	}
	if code, _ := cs.get(nate, "/api/chat?"+secretQ); code != http.StatusForbidden {
		t.Errorf("removed member still reads the chat: %d", code)
	}

	// Inviting someone who does not exist, or who has no grant in this
	// workspace (user 7 administers it but holds no grant here), is refused
	// the same way, so the answer says nothing about accounts elsewhere on
	// the server.
	for _, id := range []string{"99", "7"} {
		code, body := cs.do(owen, http.MethodPost, "/api/chat/members?"+secretQ, strings.NewReader(`{"userId":`+id+`}`), "application/json")
		if code != http.StatusNotFound || !strings.Contains(body, "no such user in this workspace") {
			t.Errorf("inviting user %s from outside the workspace: %d %s", id, code, body)
		}
	}

	// Mia leaves; Owen, now alone, cannot remove himself.
	if code, _ := cs.do(mia, http.MethodDelete, "/api/chat/members?"+secretQ+"&userId=5", nil, ""); code != http.StatusOK {
		t.Errorf("leaving: %d", code)
	}
	if code, _ := cs.do(owen, http.MethodDelete, "/api/chat/members?"+secretQ+"&userId=3", nil, ""); code != http.StatusConflict {
		t.Errorf("removing the last member: %d", code)
	}
	if code, _ := cs.get(owen, "/api/chat?"+secretQ); code != http.StatusOK {
		t.Errorf("last member locked out: %d", code)
	}
}

func TestPrivateChat_MakingPrivate(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)

	// Making an existing open chat private is for a namespace admin: anyone
	// else could tag a shared note as a chat and hide it from everyone.
	q := "ns=alpha&path=Chats/open.md"
	if code, body := cs.get(nate, "/api/chat/members?"+q); code != http.StatusOK || !strings.Contains(body, `"private":false`) {
		t.Fatalf("open chat members: %d %s", code, body)
	}
	for _, body := range []string{"", `{"userId":5}`} {
		if code, _ := cs.do(owen, http.MethodPost, "/api/chat/members?"+q, strings.NewReader(body), "application/json"); code != http.StatusForbidden {
			t.Errorf("a collaborator made an open chat private (%q): %d", body, code)
		}
	}
	if code, _ := cs.get(nate, "/api/chat?"+q); code != http.StatusOK {
		t.Fatalf("a refused make-private still closed the chat: %d", code)
	}
	// A plain note tagged as a chat cannot be taken that way either.
	cs.do(owen, http.MethodPost, "/api/note?ns=alpha&path=Notes/shared.md", strings.NewReader("everyone's"), "text/plain")
	cs.do(nate, http.MethodPost, "/api/chat/convert?ns=alpha&path=Notes/shared.md", nil, "")
	if code, _ := cs.do(nate, http.MethodPost, "/api/chat/members?ns=alpha&path=Notes/shared.md", nil, ""); code != http.StatusForbidden {
		t.Errorf("convert-then-make-private took a shared note: %d", code)
	}
	admin := jwtFor(t, uidAdmin, "admin", nil)
	if code, body := cs.do(admin, http.MethodPost, "/api/chat/members?"+q, strings.NewReader(`{"userId":3}`), "application/json"); code != http.StatusOK {
		t.Fatalf("namespace admin makes it private: %d %s", code, body)
	}
	if code, _ := cs.get(nate, "/api/chat?"+q); code != http.StatusForbidden {
		t.Errorf("open chat made private is still readable by others: %d", code)
	}
	if code, _ := cs.get(owen, "/api/chat?"+q); code != http.StatusOK {
		t.Errorf("the invited member cannot read it: %d", code)
	}

	// A new chat created private never exists as an open one.
	code, _ := cs.do(owen, http.MethodPost, "/api/chat/convert?ns=alpha&path=Chats/new.md&private=1", nil, "")
	if code != http.StatusCreated {
		t.Fatalf("create private: %d", code)
	}
	if code, _ := cs.get(nate, "/api/note?ns=alpha&path=Chats/new.md"); code != http.StatusForbidden {
		t.Errorf("new private chat readable by a non-member: %d", code)
	}
	if code, _ := cs.get(owen, "/api/chat?ns=alpha&path=Chats/new.md"); code != http.StatusOK {
		t.Errorf("creator cannot read their private chat: %d", code)
	}

	// Members cannot be listed on something that is not a chat.
	if code, _ := cs.get(owen, "/api/chat/members?ns=alpha&path=Notes/a.md"); code != http.StatusBadRequest {
		t.Errorf("members of a plain note: %d", code)
	}
}

func TestPrivateChat_MembershipFollowsTheNote(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)

	// Rename.
	if code, body := cs.do(owen, http.MethodPost, "/api/move?ns=alpha&from=Chats/secret.md&to=Chats/renamed.md", nil, ""); code != http.StatusOK {
		t.Fatalf("move: %d %s", code, body)
	}
	if code, _ := cs.get(nate, "/api/note?ns=alpha&path=Chats/renamed.md"); code != http.StatusForbidden {
		t.Errorf("a renamed private chat became open: %d", code)
	}
	// The old path stays restricted: the chat's git history is still served
	// there. A non-member cannot create a note at it either.
	if code, _ := cs.do(nate, http.MethodPost, "/api/note?"+secretQ, strings.NewReader("mine"), "text/plain"); code != http.StatusForbidden {
		t.Errorf("old path opened after the move: %d", code)
	}

	// Moving the folder that holds it.
	if code, body := cs.do(owen, http.MethodPost, "/api/move?ns=alpha&from=Chats&to=Rooms", nil, ""); code != http.StatusOK {
		t.Fatalf("folder move: %d %s", code, body)
	}
	if code, _ := cs.get(nate, "/api/note?ns=alpha&path=Rooms/renamed.md"); code != http.StatusForbidden {
		t.Errorf("a private chat moved with its folder became open: %d", code)
	}

	// A copy to another namespace is private to the same people.
	body := `{"mode":"copy","from":{"ns":"alpha","path":"Rooms/renamed.md"},"to":{"ns":"beta","path":"copy.md"}}`
	if code, out := cs.do(owen, http.MethodPost, "/api/transfer", strings.NewReader(body), "application/json"); code != http.StatusOK {
		t.Fatalf("copy: %d %s", code, out)
	}
	if code, _ := cs.get(nate, "/api/note?ns=beta&path=copy.md"); code != http.StatusForbidden {
		t.Errorf("a copied private chat is open: %d", code)
	}
	if code, _ := cs.get(owen, "/api/note?ns=beta&path=copy.md"); code != http.StatusOK {
		t.Errorf("the member lost the copy: %d", code)
	}

	// A move to another namespace keeps it private and frees the source.
	body = `{"mode":"move","from":{"ns":"beta","path":"copy.md"},"to":{"ns":"alpha","path":"Back/copy.md"}}`
	if code, out := cs.do(owen, http.MethodPost, "/api/transfer", strings.NewReader(body), "application/json"); code != http.StatusOK {
		t.Fatalf("cross move: %d %s", code, out)
	}
	if code, _ := cs.get(nate, "/api/note?ns=alpha&path=Back/copy.md"); code != http.StatusForbidden {
		t.Errorf("a private chat moved across namespaces is open: %d", code)
	}
	if m, _ := cs.members.Members("beta", "/copy.md"); len(m) == 0 {
		t.Errorf("the source path lost its restriction: its history would open")
	}

	// Moving a chat back onto an old path REPLACES the list left there, so
	// someone removed since cannot come back with it.
	// A list left at an old path: Owen and Nate were both in that chat
	// when it was moved away, and Nate has been removed from it since.
	cs.members.Add("alpha", "/Rooms/old.md", uidOwen, uidOwen)
	cs.members.Add("alpha", "/Rooms/old.md", uidNate, uidOwen)
	os.WriteFile(filepath.Join(cs.root, "alpha", "Rooms", "new.md"), []byte("---\nmdnest-chat: true\n---\n"), 0o644)
	cs.members.Add("alpha", "/Rooms/new.md", uidOwen, uidOwen)
	if code, _ := cs.do(owen, http.MethodPost, "/api/move?ns=alpha&from=Rooms/new.md&to=Rooms/old.md", nil, ""); code != http.StatusOK {
		t.Fatalf("move onto an old path: %d", code)
	}
	if code, _ := cs.get(nate, "/api/note?ns=alpha&path=Rooms/old.md"); code != http.StatusForbidden {
		t.Errorf("an old list at the destination let a non-member back in: %d", code)
	}
}

// The chat's file is ordinary markdown. Editing its text cannot change who is
// on it: the list is not in the file.
func TestPrivateChat_ListIsNotInTheNote(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	_, body := cs.get(owen, "/api/note?"+secretQ)
	edited := strings.Replace(body, "title: SECRET-ROOM", "title: SECRET-ROOM\nmembers: [6]\nprivate: false", 1)
	if code, _ := cs.do(owen, http.MethodPut, "/api/note?"+secretQ, strings.NewReader(edited), "text/plain"); code >= 400 {
		t.Fatalf("member edit: %d", code)
	}
	if code, _ := cs.get(nate, "/api/note?"+secretQ); code != http.StatusForbidden {
		t.Errorf("editing the note text changed who can read it: %d", code)
	}
}

// Without a member store (single mode, or multi mode before this change) a
// chat is exactly what it was. routes_test.go covers single mode; this pins
// that the members route is simply absent there.
func TestPrivateChat_MembersRouteOnlyWithAStore(t *testing.T) {
	ts := newTestServer(t, true)
	code, _ := ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/chat/members?ns=alpha&path=Private/room.md")
	if code != http.StatusNotFound {
		t.Errorf("members route without a store: %d", code)
	}
}

var _ = io.Discard
var _ = url.QueryEscape

// --- found by the security review after the first push ---------------------

// A failed move used to roll back by dropping every member list under the
// destination. Aimed at an existing folder (the rename fails), that wiped the
// list of a private chat already living there and opened it.
func TestPrivateChat_FailedMoveDoesNotOpenAChatAtTheDestination(t *testing.T) {
	cs := newChatServer(t)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	// Nate owns Notes/a.md and aims it at the existing folder Chats.
	code, _ := cs.do(nate, http.MethodPost, "/api/move?ns=alpha&from=Notes/a.md&to=Chats", nil, "")
	if code < 400 {
		t.Fatalf("moving a file onto an existing folder should fail, got %d", code)
	}
	if code, body := cs.get(nate, "/api/note?"+secretQ); code != http.StatusForbidden {
		t.Errorf("a failed move opened the private chat: %d %s", code, body)
	}
	// The same through /api/transfer within one namespace.
	body := `{"mode":"move","from":{"ns":"alpha","path":"Notes/a.md"},"to":{"ns":"alpha","path":"Chats"}}`
	cs.do(nate, http.MethodPost, "/api/transfer", strings.NewReader(body), "application/json")
	if code, _ := cs.get(nate, "/api/note?"+secretQ); code != http.StatusForbidden {
		t.Errorf("a failed transfer opened the private chat: %d", code)
	}
}

// private=1 on convert must not turn someone else's existing note into a chat
// only the caller can open.
func TestPrivateChat_ConvertCannotTakeAnExistingNote(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	before := cs.readFile("alpha/Notes/a.md")
	code, _ := cs.do(nate, http.MethodPost, "/api/chat/convert?ns=alpha&path=Notes/a.md&private=1", nil, "")
	if code < 400 {
		t.Errorf("private convert of an existing note: %d", code)
	}
	if code, _ := cs.get(owen, "/api/note?ns=alpha&path=Notes/a.md"); code != http.StatusOK {
		t.Errorf("owen was locked out of an ordinary note: %d", code)
	}
	if got := cs.readFile("alpha/Notes/a.md"); got != before {
		t.Errorf("a refused convert changed the note: %q", got)
	}
}

// A private chat's old path keeps its restriction after a move or delete, so
// its git history there (note/at, note/history) stays closed to non-members.
func TestPrivateChat_OldPathStaysClosedAfterMoveAndDelete(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	if code, _ := cs.do(owen, http.MethodPost, "/api/move?ns=alpha&from=Chats/secret.md&to=Chats/renamed.md", nil, ""); code != http.StatusOK {
		t.Fatalf("move: %d", code)
	}
	for _, p := range []string{"/api/note/history?" + secretQ, "/api/note/at?" + secretQ + "&ref=0123456789abcdef0123456789abcdef01234567"} {
		if code, _ := cs.get(nate, p); code != http.StatusForbidden {
			t.Errorf("after a move, %s: %d", p, code)
		}
	}
	if code, _ := cs.do(owen, http.MethodDelete, "/api/note?ns=alpha&path=Chats/renamed.md", nil, ""); code != http.StatusOK {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := cs.get(nate, "/api/note/history?ns=alpha&path=Chats/renamed.md"); code != http.StatusForbidden {
		t.Errorf("after a delete, the history is open: %d", code)
	}
	// The folder no longer holds a live private chat, so the leftover
	// restriction does not stop a non-member managing it. (Its other chat
	// goes first: only its owner may delete that one, chat_owner.go.)
	if code, _ := cs.do(owen, http.MethodDelete, "/api/note?ns=alpha&path=Chats/open.md", nil, ""); code != http.StatusOK {
		t.Fatalf("owner deleting the open chat: %d", code)
	}
	if code, body := cs.do(nate, http.MethodDelete, "/api/note?ns=alpha&path=Chats", nil, ""); code != http.StatusOK {
		t.Errorf("a leftover restriction blocked deleting the folder: %d %s", code, body)
	}
}

// A live-editing connection is authorised once, when it joins. Removing a
// member must close theirs, or a removed member with the note open in the
// editor keeps receiving every new message.
func TestPrivateChat_RemovalClosesTheLiveConnection(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	mia := jwtFor(t, uidMia, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	if _, code := dialWS(t, cs.testServer, nate, "Chats/secret.md"); code == http.StatusSwitchingProtocols {
		t.Fatalf("a non-member joined the live room")
	}
	cs.do(owen, http.MethodPost, "/api/chat/members?"+secretQ, strings.NewReader(`{"userId":6}`), "application/json")
	nws, code := dialWS(t, cs.testServer, nate, "Chats/secret.md")
	if code != http.StatusSwitchingProtocols {
		t.Fatalf("an invited member could not join the live room: %d", code)
	}
	mws, _ := dialWS(t, cs.testServer, mia, "Chats/secret.md")
	time.Sleep(100 * time.Millisecond) // let both joins register
	cs.do(owen, http.MethodDelete, "/api/chat/members?"+secretQ+"&userId=6", nil, "")

	deadline := time.After(3 * time.Second)
	for closed := false; !closed; {
		select {
		case _, open := <-nws.msgs:
			closed = !open
		case <-deadline:
			t.Fatal("the removed member's live connection stayed open")
		}
	}
	// Mia is still a member: her connection stays up.
	select {
	case _, open := <-mws.msgs:
		for open {
			select {
			case _, open = <-mws.msgs:
			case <-time.After(300 * time.Millisecond):
				return
			}
		}
		t.Error("a member's live connection was closed too")
	case <-time.After(300 * time.Millisecond):
	}
}

// The list left at a moved chat's old path guards its git history. A
// non-member must not be able to replace it by moving or copying a private
// chat of their own onto that path, directly or inside a folder.
func TestPrivateChat_LeftoverListCannotBeReplacedByANonMember(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	if code, _ := cs.do(owen, http.MethodPost, "/api/move?ns=alpha&from=Chats/secret.md&to=Archive/secret.md", nil, ""); code != http.StatusOK {
		t.Fatalf("owen moves the chat away: %d", code)
	}
	// Nate builds Mine/secret.md, a private chat of his own, then aims the
	// folder at Chats, where the old list is.
	if code, _ := cs.do(nate, http.MethodPost, "/api/chat/convert?ns=alpha&path=Mine/secret.md&private=1", nil, ""); code != http.StatusCreated {
		t.Fatalf("nate's own chat: %d", code)
	}
	os.RemoveAll(filepath.Join(cs.root, "alpha", "Chats")) // the folder is gone, only the list is left
	attempts := []struct{ method, path, body string }{
		{http.MethodPost, "/api/move?ns=alpha&from=Mine&to=Chats", ""},
		{http.MethodPost, "/api/move?ns=alpha&from=Mine/secret.md&to=Chats/secret.md", ""},
		{http.MethodPost, "/api/transfer", `{"mode":"copy","from":{"ns":"alpha","path":"Mine"},"to":{"ns":"alpha","path":"Chats"}}`},
		{http.MethodPost, "/api/transfer", `{"mode":"move","from":{"ns":"alpha","path":"Mine"},"to":{"ns":"alpha","path":"Chats"}}`},
	}
	for _, a := range attempts {
		if code, _ := cs.do(nate, a.method, a.path, strings.NewReader(a.body), "application/json"); code != http.StatusForbidden {
			t.Errorf("%s %s %s: %d", a.method, a.path, a.body, code)
		}
		if ids, _ := cs.members.Members("alpha", "/Chats/secret.md"); containsTestID(ids, uidNate) {
			t.Fatalf("nate replaced the old list: %v", ids)
		}
	}
	if code, _ := cs.get(nate, "/api/note/history?"+secretQ); code != http.StatusForbidden {
		t.Errorf("the old history opened: %d", code)
	}
}

func containsTestID(ids []int, id int) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// Found by the independent review. On a case-insensitive mount CHATS/SECRET.md
// opens Chats/secret.md, so the member check must not depend on the spelling.
func TestPrivateChat_LetterCaseDoesNotSkipTheCheck(t *testing.T) {
	cs := newChatServer(t)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	for _, p := range []string{"CHATS/SECRET.md", "chats/Secret.md", "Chats/SECRET.MD"} {
		for _, route := range []string{"/api/note", "/api/chat", "/api/note/history", "/api/download", "/api/comments"} {
			if code, _ := cs.get(nate, route+"?ns=alpha&path="+url.QueryEscape(p)); code != http.StatusForbidden {
				t.Errorf("%s %s: %d", route, p, code)
			}
		}
		if code, _ := cs.do(nate, http.MethodDelete, "/api/note?ns=alpha&path="+url.QueryEscape(p), nil, ""); code != http.StatusForbidden {
			t.Errorf("DELETE %s: %d", p, code)
		}
	}
	if code, _ := cs.do(nate, http.MethodDelete, "/api/note?ns=alpha&path=CHATS", nil, ""); code != http.StatusForbidden {
		t.Errorf("DELETE the folder by another spelling: %d", code)
	}
}

// A move never lands on an existing note: it would replace the note's text,
// and a private chat dropped over a shared note would take it from everyone.
func TestPrivateChat_MoveCannotReplaceAnExistingNote(t *testing.T) {
	cs := newChatServer(t)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	before := cs.readFile("alpha/Notes/a.md")
	if code, _ := cs.do(nate, http.MethodPost, "/api/chat/convert?ns=alpha&path=Mine/x.md&private=1", nil, ""); code != http.StatusCreated {
		t.Fatalf("nate's chat: %d", code)
	}
	if code, _ := cs.do(nate, http.MethodPost, "/api/move?ns=alpha&from=Mine/x.md&to=Notes/a.md", nil, ""); code != http.StatusConflict {
		t.Errorf("move onto an existing note: %d", code)
	}
	if got := cs.readFile("alpha/Notes/a.md"); got != before {
		t.Errorf("the note was replaced: %q", got)
	}
	if code, _ := cs.get(owen, "/api/note?ns=alpha&path=Notes/a.md"); code != http.StatusOK {
		t.Errorf("owen lost the shared note: %d", code)
	}
	// A rename that only changes case still works.
	if code, body := cs.do(owen, http.MethodPost, "/api/move?ns=alpha&from=Notes/a.md&to=Notes/A.md", nil, ""); code != http.StatusOK {
		t.Errorf("case-only rename: %d %s", code, body)
	}
}

// A link to a private chat must not carry its text into search or the task
// board, for a namespace admin or a reader of the whole namespace.
func TestPrivateChat_LinkToItStaysOutOfListings(t *testing.T) {
	cs := newChatServer(t)
	os.MkdirAll(filepath.Join(cs.root, "alpha", "Shared"), 0o755)
	if err := os.Symlink(filepath.Join(cs.root, "alpha", "Chats", "secret.md"), filepath.Join(cs.root, "alpha", "Shared", "x.md")); err != nil {
		t.Skip("no symlinks")
	}
	for name, tok := range map[string]string{
		"ns admin":   jwtFor(t, uidAdmin, "admin", nil),
		"root grant": jwtFor(t, uidNate, "collaborator", nil),
	} {
		for _, p := range []string{"/api/search?ns=alpha&q=SECRET-WORDS", "/api/tasks?ns=alpha", "/api/tasks/all"} {
			if _, body := cs.get(tok, p); strings.Contains(body, "SECRET") {
				t.Errorf("%s %s leaked the chat through a link: %s", name, p, body)
			}
		}
		if code, _ := cs.get(tok, "/api/note?ns=alpha&path=Shared/x.md"); code != http.StatusForbidden {
			t.Errorf("%s read the chat through the link: %d", name, code)
		}
	}
}

// foldingStorage stands in for a disk that matches names the way macOS does
// (Docker Desktop): ToLower is not enough, it also folds the long s. Stat
// finds secret.md when asked for ſecret.md. Only the checker gets this view.
type foldingStorage struct{ storage.Storage }

func (f foldingStorage) Stat(ctx context.Context, ns, rel string) (storage.FileInfo, error) {
	real := ""
	for _, seg := range strings.Split(strings.ReplaceAll(rel, "ſ", "s"), "/") {
		entries, err := f.Storage.ReadDir(ctx, ns, real)
		if err != nil {
			return storage.FileInfo{}, err
		}
		match := ""
		for _, e := range entries {
			if strings.EqualFold(e.Name, seg) {
				match = e.Name
			}
		}
		if match == "" {
			return storage.FileInfo{}, storage.ErrNotExist
		}
		real = strings.TrimPrefix(real+"/"+match, "/")
	}
	return f.Storage.Stat(ctx, ns, real)
}

// A non-ASCII spelling the disk folds onto a private chat must be refused,
// and a private chat cannot be given a non-ASCII path in the first place.
func TestPrivateChat_UnicodeSpellingCannotAliasIt(t *testing.T) {
	cs := newChatServer(t)
	stg, _ := storage.NewLocalStorage(cs.root)
	cs.perms.SetStorage(foldingStorage{stg})
	nate := jwtFor(t, uidNate, "collaborator", nil)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	for _, p := range []string{"Chats/ſecret.md", "Chats/ſECRET.md"} {
		if code, _ := cs.get(nate, "/api/note?ns=alpha&path="+url.QueryEscape(p)); code != http.StatusForbidden {
			t.Errorf("%s: %d", p, code)
		}
	}
	// A real non-ASCII note, spelled exactly, still works.
	os.WriteFile(filepath.Join(cs.root, "alpha", "Notes", "café.md"), []byte("fine"), 0o644)
	if code, _ := cs.get(nate, "/api/note?ns=alpha&path="+url.QueryEscape("Notes/café.md")); code != http.StatusOK {
		t.Errorf("an exactly spelled non-ASCII note: %d", code)
	}
	if code, _ := cs.do(owen, http.MethodPost, "/api/chat/convert?ns=alpha&path="+url.QueryEscape("Chats/équipe.md")+"&private=1", nil, ""); code != http.StatusBadRequest {
		t.Errorf("private chat at a non-ASCII path: %d", code)
	}
	if code, _ := cs.do(owen, http.MethodPost, "/api/move?ns=alpha&from=Chats/secret.md&to="+url.QueryEscape("Équipe/secret.md"), nil, ""); code < 400 {
		t.Errorf("moving a private chat to a non-ASCII path: %d", code)
	}
	if code, _ := cs.get(nate, "/api/note?ns=alpha&path="+url.QueryEscape("Équipe/secret.md")); code == http.StatusOK {
		t.Errorf("the chat ended up open at a non-ASCII path")
	}
}

// Lists are keyed by the lowercased path. On a case-sensitive disk a private
// chat at Notes/A.md would therefore also cover the existing Notes/a.md, so
// no list may be written where another spelling of the name exists.
func TestPrivateChat_OtherSpellingCannotTakeANote(t *testing.T) {
	cs := newChatServer(t)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	admin := jwtFor(t, uidAdmin, "admin", nil)
	readable := func(why string) {
		t.Helper()
		if code, _ := cs.get(owen, "/api/note?ns=alpha&path=Notes/a.md"); code != http.StatusOK {
			t.Errorf("%s: owen lost Notes/a.md: %d", why, code)
		}
	}
	if code, _ := cs.do(nate, http.MethodPost, "/api/chat/convert?ns=alpha&path=Notes/A.md&private=1", nil, ""); code != http.StatusConflict {
		t.Errorf("private chat at another spelling of a note: %d", code)
	}
	readable("convert")

	cs.do(nate, http.MethodPost, "/api/chat/convert?ns=alpha&path=Mine/x.md&private=1", nil, "")
	if code, _ := cs.do(nate, http.MethodPost, "/api/move?ns=alpha&from=Mine/x.md&to=Notes/A.md", nil, ""); code < 400 {
		t.Errorf("move a private chat onto another spelling: %d", code)
	}
	readable("move")
	body := `{"mode":"move","from":{"ns":"alpha","path":"Mine"},"to":{"ns":"alpha","path":"NOTES"}}`
	os.Rename(filepath.Join(cs.root, "alpha", "Mine", "x.md"), filepath.Join(cs.root, "alpha", "Mine", "a.md"))
	cs.members.Add("alpha", "/Mine/a.md", uidNate, uidNate)
	if code, _ := cs.do(nate, http.MethodPost, "/api/transfer", strings.NewReader(body), "application/json"); code < 400 {
		t.Errorf("transfer a folder holding a private chat onto another spelling: %d", code)
	}
	readable("transfer")

	// Two chats whose names differ only in case: neither can be made private.
	os.WriteFile(filepath.Join(cs.root, "alpha", "Chats", "OPEN.md"), []byte("---\nmdnest-chat: true\n---\n"), 0o644)
	if code, _ := cs.do(admin, http.MethodPost, "/api/chat/members?ns=alpha&path=Chats/open.md", nil, ""); code != http.StatusConflict {
		t.Errorf("making one of two same-name chats private: %d", code)
	}
	if code, _ := cs.get(nate, "/api/chat?ns=alpha&path=Chats/OPEN.md"); code != http.StatusOK {
		t.Errorf("the other spelling was locked: %d", code)
	}
}
