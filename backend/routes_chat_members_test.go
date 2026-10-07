package main

// Private chats (issue #127), driven through the REAL route table and the REAL
// auth middleware, the same way routes_test.go pins the v4.6.2 access fixes.
// Membership is enforced in the permission checker, so these tests walk every
// route that can serve, list, carry off, change or remove a note and check a
// non-member gets nothing from any of them.

import (
	"archive/zip"
	"bytes"
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

func ck(ns, p string) string { return ns + "\x00/" + strings.Trim(p, "/") }

func under(root, p string) bool {
	root = "/" + strings.Trim(root, "/")
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

func (m *memChatMembers) each(ns, root string, fn func(k, p string)) {
	for k := range m.rows {
		parts := strings.SplitN(k, "\x00", 2)
		if parts[0] == ns && under(root, parts[1]) {
			fn(k, parts[1])
		}
	}
}

func (m *memChatMembers) MovePrefix(fromNS, from, toNS, to string) error {
	if err := m.CopyPrefix(fromNS, from, toNS, to); err != nil {
		return err
	}
	return m.DeletePrefix(fromNS, from)
}

func (m *memChatMembers) CopyPrefix(fromNS, from, toNS, to string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	f := "/" + strings.Trim(from, "/")
	t := "/" + strings.Trim(to, "/")
	add := map[string][]int{}
	m.each(fromNS, f, func(k, p string) {
		add[toNS+"\x00"+t+strings.TrimPrefix(p, f)] = append([]int(nil), m.rows[k]...)
	})
	for k, ids := range add {
		m.rows[k] = ids
	}
	return nil
}

func (m *memChatMembers) DeletePrefix(ns, p string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var drop []string
	m.each(ns, p, func(k, _ string) { drop = append(drop, k) })
	for _, k := range drop {
		delete(m.rows, k)
	}
	return nil
}

type memUsers struct{}

func (memUsers) GetUserByID(id int) (*store.User, error) {
	if id <= 0 || id > 9 {
		return nil, nil
	}
	return &store.User{ID: id, Username: "user" + string(rune('0'+id))}, nil
}

// buildChatFixture:
//
//	alpha/Chats/secret.md   private chat (Owen + Mia): SECRET-WORDS, SECRET-TASK
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
		"#### owen · 2026-10-07T10:00:00Z\nSECRET-WORDS\n- [ ] SECRET-TASK\n")
	write("alpha/Chats/open.md", "---\nmdnest-chat: true\ntitle: OPEN-ROOM\n---\n\n"+
		"#### owen · 2026-10-07T10:00:00Z\nopen words\n")
	write("alpha/Notes/a.md", "plain note\n")
	return root
}

type chatServer struct {
	*testServer
	members *memChatMembers
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
	note.SetChatMembers(members)
	move := handlers.NewMoveHandler(stg)
	move.SetChatMembers(members)
	tCanRead, tCanWrite := handlers.TransferPermissionFuncs(perms)
	transfer := handlers.NewTransferHandler(stg, handlers.DefaultTreeLimits, tCanRead, tCanWrite, search.InvalidateCache)
	transfer.SetChatMembers(members)
	chat := handlers.NewChatHandler(stg, perms.FilterNamespaces, perms.CheckRead, "admin", true)
	chat.SetMembers(members, memUsers{})

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
	}
	mux := http.NewServeMux()
	registerContentRoutes(mux, routes)
	ts.srv = httptest.NewServer(mux)
	t.Cleanup(ts.srv.Close)
	return &chatServer{testServer: ts, members: members}
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

	// Inviting a user who does not exist is refused.
	if code, _ := cs.do(owen, http.MethodPost, "/api/chat/members?"+secretQ, strings.NewReader(`{"userId":99}`), "application/json"); code != http.StatusNotFound {
		t.Errorf("inviting a nonexistent user: %d", code)
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

	// An open chat becomes private to whoever closes it.
	q := "ns=alpha&path=Chats/open.md"
	if code, body := cs.get(nate, "/api/chat/members?"+q); code != http.StatusOK || !strings.Contains(body, `"private":false`) {
		t.Fatalf("open chat members: %d %s", code, body)
	}
	if code, _ := cs.do(owen, http.MethodPost, "/api/chat/members?"+q, nil, ""); code != http.StatusOK {
		t.Fatalf("make private: %d", code)
	}
	if code, _ := cs.get(nate, "/api/chat?"+q); code != http.StatusForbidden {
		t.Errorf("open chat made private is still readable by others: %d", code)
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
	// The old path is free again: a new note there is an ordinary note.
	if code, _ := cs.do(nate, http.MethodPost, "/api/note?"+secretQ, strings.NewReader("mine"), "text/plain"); code >= 400 {
		t.Errorf("old path still restricted after the move: %d", code)
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
	if m, _ := cs.members.Members("beta", "/copy.md"); len(m) != 0 {
		t.Errorf("member list left behind at the source: %v", m)
	}

	// Deleting it forgets the list.
	if code, _ := cs.do(owen, http.MethodDelete, "/api/note?ns=alpha&path=Back/copy.md", nil, ""); code != http.StatusOK {
		t.Fatalf("delete: %d", code)
	}
	if m, _ := cs.members.Members("alpha", "/Back/copy.md"); len(m) != 0 {
		t.Errorf("member list outlived the chat: %v", m)
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
