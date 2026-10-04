package main

// Regression tests for the v4.6.2 access fixes. They drive the REAL route
// table (registerContentRoutes) through the REAL auth middleware with JWTs and
// API tokens, against fake grant stores that match paths with the same
// store.PathCovers rule Postgres uses. A guard that is wrong in the wiring,
// not in a handler, fails here.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"nhooyr.io/websocket"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

const testSecret = "routes-test-secret"

const (
	uidPat   = 1 // direct write grant on alpha:/Shared
	uidGus   = 2 // read on alpha:/Shared through a group only
	uidOwen  = 3 // write on alpha:/ (whole namespace)
	uidAdele = 4 // role=admin, namespace admin of beta, read grant on alpha:/Shared
)

const privateID = "dddddddd-4444-4444-8444-444444444444"

// --- fakes ---------------------------------------------------------------

type memGrants struct {
	store.GrantStore // unimplemented methods panic: the routes must not need them
	grants           []store.Grant
}

func (m *memGrants) GetGrantsForUser(uid int) ([]store.Grant, error) {
	var out []store.Grant
	for _, g := range m.grants {
		if g.UserID == uid {
			out = append(out, g)
		}
	}
	return out, nil
}

// CheckAccess mirrors PostgresGrantStore.CheckAccess: path coverage by
// store.PathCovers, write satisfies read.
func (m *memGrants) CheckAccess(uid int, ns, p, perm string) bool {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	gs, _ := m.GetGrantsForUser(uid)
	for _, g := range gs {
		if g.Namespace == ns && store.PathCovers(g.Path, p) && (perm == "read" || g.Permission == "write") {
			return true
		}
	}
	return false
}

func (m *memGrants) GetAccessibleNamespaces(uid int) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	gs, _ := m.GetGrantsForUser(uid)
	for _, g := range gs {
		if !seen[g.Namespace] {
			seen[g.Namespace] = true
			out = append(out, g.Namespace)
		}
	}
	return out, nil
}

type memGroups struct {
	store.GroupStore
	members map[int][]store.GroupGrant // userID -> grants of their groups
}

func (m *memGroups) MemberGroupGrants(uid int, _ []string, ns string) ([]store.GroupGrant, error) {
	var out []store.GroupGrant
	for _, g := range m.members[uid] {
		if g.Namespace == ns {
			out = append(out, g)
		}
	}
	return out, nil
}

func (m *memGroups) CheckGroupAccess(uid int, oidc []string, ns, p, perm string) bool {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	gs, _ := m.MemberGroupGrants(uid, oidc, ns)
	for _, g := range gs {
		if store.PathCovers(g.Path, p) && (perm == "read" || g.Permission == "write") {
			return true
		}
	}
	return false
}

func (m *memGroups) GetAccessibleNamespacesForGroups(uid int, _ []string) ([]string, error) {
	var out []string
	for _, g := range m.members[uid] {
		out = append(out, g.Namespace)
	}
	return out, nil
}

type memNsAdmins struct {
	store.NamespaceAdminStore
	of map[int][]string
}

func (m *memNsAdmins) IsAdminOf(uid int, ns string) (bool, error) {
	for _, n := range m.of[uid] {
		if n == ns {
			return true, nil
		}
	}
	return false, nil
}
func (m *memNsAdmins) ListByUser(uid int) ([]string, error) { return m.of[uid], nil }

type memTokens struct {
	mu     sync.Mutex
	tokens []store.APIToken
}

func (m *memTokens) Add(t store.APIToken) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tokens = append(m.tokens, t)
	return nil
}
func (m *memTokens) All() ([]store.APIToken, error) { return m.tokens, nil }
func (m *memTokens) FindByHash(h string) (*store.APIToken, error) {
	for i := range m.tokens {
		if m.tokens[i].TokenHash == h {
			return &m.tokens[i], nil
		}
	}
	return nil, nil
}
func (m *memTokens) DeleteByID(string) (bool, error) { return false, nil }

type memActivity struct{}

func (memActivity) Record(string, string, string, int, string) error { return nil }
func (memActivity) Summary(ns, p string) (*store.NoteAttribution, error) {
	return &store.NoteAttribution{}, nil
}

// --- fixture ---------------------------------------------------------------

type testServer struct {
	t      *testing.T
	root   string
	srv    *httptest.Server
	tokens *handlers.TokenHandler
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("git %v: %v %s", args, err, out)
	}
}

// buildFixture lays out namespace alpha (git-backed) and beta.
//
//	alpha/Private/p.md        TOP-SECRET, a task, a comment thread, a chat
//	alpha/Shared/a.md         readable by the /Shared users
//	alpha/Shared/ok-link.md   -> Shared/a.md   (a link that stays inside the grant)
//	alpha/Shared/link.md      -> Private/p.md  (a link out of the grant)
//	alpha/Shared/ldir         -> Private       (a linked folder out of the grant)
func buildFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	alpha := filepath.Join(root, "alpha")
	for _, d := range []string{"Private", "Shared", ".mdnest/comments", "ChatGifs"} {
		os.MkdirAll(filepath.Join(alpha, d), 0o755)
	}
	os.MkdirAll(filepath.Join(root, "beta"), 0o755)
	os.WriteFile(filepath.Join(alpha, "Private", "p.md"),
		[]byte(handlers.InjectNoteID("TOP-SECRET\n- [ ] SECRET-TASK\n", privateID)), 0o644)
	os.WriteFile(filepath.Join(alpha, "Private", "room.md"),
		[]byte("---\nmdnest-chat: true\ntitle: SECRET-ROOM\n---\n"), 0o644)
	os.WriteFile(filepath.Join(alpha, "Shared", "a.md"), []byte("shared words\n- [ ] SHARED-TASK\n"), 0o644)
	os.WriteFile(filepath.Join(alpha, ".mdnest", "comments", privateID+".jsonl"),
		[]byte(`{"id":"c1","author":"boss","body":"PRIVATE-COMMENT","createdAt":"2026-01-01T00:00:00Z"}`+"\n"), 0o644)
	os.WriteFile(filepath.Join(alpha, "ChatGifs", "secret-gif.gif"), []byte("GIF89a"), 0o644)
	gitRun(t, alpha, "init", "-q")
	gitRun(t, alpha, "remote", "add", "origin", "https://bob:s3cr3t-pat@git.example.com/team/alpha.git")
	gitRun(t, alpha, "add", "-A")
	gitRun(t, alpha, "commit", "-q", "-m", "seed")
	if err := os.Symlink(filepath.Join(alpha, "Shared", "a.md"), filepath.Join(alpha, "Shared", "ok-link.md")); err != nil {
		t.Skip("no symlinks")
	}
	os.Symlink(filepath.Join(alpha, "Private", "p.md"), filepath.Join(alpha, "Shared", "link.md"))
	os.Symlink(filepath.Join(alpha, "Private"), filepath.Join(alpha, "Shared", "ldir"))
	// Links whose TARGET is reserved or outside the namespace.
	os.Symlink("../.git/config", filepath.Join(alpha, "Shared", "cfg.md"))
	os.Symlink("../.mdnest/comments/"+privateID+".jsonl", filepath.Join(alpha, "Shared", "thread.md"))
	os.WriteFile(filepath.Join(root, "beta", "secret.md"), []byte("BETA-SECRET\n"), 0o644)
	os.Symlink("../../beta/secret.md", filepath.Join(alpha, "Shared", "out.md"))
	return root
}

func newTestServer(t *testing.T, multi bool) *testServer {
	t.Helper()
	root := buildFixture(t)
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	ts := &testServer{t: t, root: root}
	ts.tokens = handlers.NewTokenHandler(&memTokens{})

	var perms *middleware.PermissionChecker
	var grants store.GrantStore
	var groups store.GroupStore
	var nsAdmins store.NamespaceAdminStore
	if multi {
		mg := &memGrants{grants: []store.Grant{
			{UserID: uidPat, Namespace: "alpha", Path: "/Shared", Permission: "write"},
			{UserID: uidOwen, Namespace: "alpha", Path: "/", Permission: "write"},
			{UserID: uidAdele, Namespace: "alpha", Path: "/Shared", Permission: "read"},
		}}
		gr := &memGroups{members: map[int][]store.GroupGrant{
			uidGus: {{Namespace: "alpha", Path: "/Shared", Permission: "read"}},
		}}
		na := &memNsAdmins{of: map[int][]string{uidAdele: {"beta"}}}
		grants, groups, nsAdmins = mg, gr, na
		perms = middleware.NewPermissionChecker(mg, na, gr)
	}
	if perms != nil {
		perms.SetStorage(stg) // as main() wires it
	}

	hub := collab.NewHub()
	note := handlers.NewNoteHandler(stg)
	search := handlers.NewSearchHandler(stg)
	nsFilter := func(_ *http.Request, n []string) []string { return n }
	canRead := func(*http.Request, string, string) bool { return true }
	canWrite := canRead
	if perms != nil {
		nsFilter, canRead, canWrite = perms.FilterNamespaces, perms.CheckRead, perms.CheckWrite
	}
	tasks := handlers.NewTaskHandler(stg, nsFilter, canWrite)
	chat := handlers.NewChatHandler(stg, nsFilter, canRead, "admin", multi)
	invalidate := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r)
			if ns := r.URL.Query().Get("ns"); ns != "" && r.Method != http.MethodGet {
				search.InvalidateCache(ns)
			}
		})
	}
	auth := middleware.NewAuthMiddleware(testSecret, multi, ts.tokens, ts.tokens)
	routes := contentRoutes{
		auth:       auth.Wrap,
		perms:      perms,
		invalidate: invalidate,
		ns:         handlers.NewNamespaceHandler(stg, perms, nil),
		tree:       handlers.NewTreeHandler(stg, grants, groups),
		note:       note,
		history:    handlers.NewHistoryHandler(root),
		upload:     handlers.NewUploadHandler(stg, perms),
		move:       handlers.NewMoveHandler(stg),
		download:   handlers.NewDownloadHandler(stg, handlers.DefaultTreeLimits, 2),
		transfer:   handlers.NewTransferHandler(stg, handlers.DefaultTreeLimits, canRead, canWrite, search.InvalidateCache),
		search:     search,
		tasks:      tasks,
		chat:       chat,
		sync:       handlers.NewSyncHandler(root, search.InvalidateCache, nsAdmins),
	}
	if multi {
		routes.attribution = handlers.NewAttributionHandler(stg, memActivity{})
		routes.comments = handlers.NewCommentsHandler(stg)
		routes.ws = handlers.NewWSHandler(hub, testSecret, perms)
	}
	mux := http.NewServeMux()
	registerContentRoutes(mux, routes)
	ts.srv = httptest.NewServer(mux)
	t.Cleanup(ts.srv.Close)
	return ts
}

func jwtFor(t *testing.T, uid int, role string, extra jwt.MapClaims) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": "user" + string(rune('0'+uid)), "user_id": uid, "role": role,
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
	}
	for k, v := range extra {
		claims[k] = v
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (ts *testServer) do(token, method, path string, body io.Reader, ct string) (int, string) {
	ts.t.Helper()
	req, _ := http.NewRequest(method, ts.srv.URL+path, body)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		ts.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (ts *testServer) get(token, path string) (int, string) {
	return ts.do(token, http.MethodGet, path, nil, "")
}

func (ts *testServer) readFile(rel string) string {
	b, _ := os.ReadFile(filepath.Join(ts.root, filepath.FromSlash(rel)))
	return string(b)
}

// --- hole 1: content read across a folder grant -----------------------------

func TestRoutes_SearchStaysInsideFolderGrant(t *testing.T) {
	ts := newTestServer(t, true)
	for _, tok := range []string{jwtFor(t, uidPat, "collaborator", nil), jwtFor(t, uidGus, "collaborator", nil)} {
		_, body := ts.get(tok, "/api/search?ns=alpha&q=TOP-SECRET")
		if strings.Contains(body, "Private") || strings.Contains(body, "TOP-SECRET") {
			t.Errorf("search leaked /Private: %s", body)
		}
		// p.md is also reachable by name through the linked folder.
		_, body = ts.get(tok, "/api/search?ns=alpha&q=p.md")
		if strings.Contains(body, "ldir/p.md") || strings.Contains(body, "Private/p.md") {
			t.Errorf("filename search leaked /Private: %s", body)
		}
		code, body := ts.get(tok, "/api/search?ns=alpha&q=shared%20words")
		if code != 200 || !strings.Contains(body, "Shared/a.md") {
			t.Errorf("normal search broke: %d %s", code, body)
		}
	}
	_, body := ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/search?ns=alpha&q=TOP-SECRET")
	if !strings.Contains(body, "Private/p.md") {
		t.Errorf("whole-namespace reader lost search results: %s", body)
	}
}

func TestRoutes_CommentsNeedReadOnTheNote(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil)
	before := ts.readFile("alpha/Shared/link.md")
	for _, p := range []string{"Private/p.md", "Shared/../Private/p.md", "Shared/link.md"} {
		code, body := ts.get(pat, "/api/comments?ns=alpha&path="+url.QueryEscape(p))
		if code != http.StatusForbidden || strings.Contains(body, "PRIVATE-COMMENT") {
			t.Errorf("GET comments %s: %d %s", p, code, body)
		}
		code, _ = ts.do(pat, http.MethodPost, "/api/comments?ns=alpha&path="+url.QueryEscape(p),
			strings.NewReader(`{"body":"hi"}`), "application/json")
		if code != http.StatusForbidden {
			t.Errorf("POST comment %s: %d", p, code)
		}
	}
	if got := ts.readFile("alpha/Private/p.md"); !strings.Contains(got, privateID) || got != before {
		t.Errorf("a denied comments call rewrote the note: %q", got)
	}
	code, _ := ts.get(pat, "/api/comments?ns=alpha&path=Shared/a.md")
	if code != http.StatusOK {
		t.Errorf("comments on a granted note: %d", code)
	}
	code, body := ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/comments?ns=alpha&path=Private/p.md")
	if code != 200 || !strings.Contains(body, "PRIVATE-COMMENT") {
		t.Errorf("full reader lost comments: %d %s", code, body)
	}
}

func TestRoutes_GlobalTasksStayInsideFolderGrant(t *testing.T) {
	ts := newTestServer(t, true)
	for _, tok := range []string{jwtFor(t, uidPat, "collaborator", nil), jwtFor(t, uidGus, "collaborator", nil)} {
		code, body := ts.get(tok, "/api/tasks/all")
		if code != 200 || strings.Contains(body, "SECRET-TASK") {
			t.Errorf("tasks/all leaked /Private: %d %s", code, body)
		}
		if !strings.Contains(body, "SHARED-TASK") {
			t.Errorf("tasks/all lost the granted task: %s", body)
		}
	}
	_, body := ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/tasks/all")
	if !strings.Contains(body, "SECRET-TASK") {
		t.Errorf("full reader lost tasks: %s", body)
	}
}

func TestRoutes_HistoryAndNoteAtNeedReadOnThePath(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil)
	code, body := ts.get(pat, "/api/note/history?ns=alpha&path=Private/p.md")
	if code != http.StatusForbidden {
		t.Errorf("history of /Private: %d %s", code, body)
	}
	_, hist := ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/note/history?ns=alpha&path=Private/p.md")
	var commits []struct{ Commit string }
	json.Unmarshal([]byte(hist), &commits)
	if len(commits) == 0 {
		t.Fatalf("full reader got no history: %s", hist)
	}
	for _, p := range []string{"Private/p.md", "Shared/../Private/p.md"} {
		code, body = ts.get(pat, "/api/note/at?ns=alpha&path="+url.QueryEscape(p)+"&ref="+commits[0].Commit)
		if code != http.StatusForbidden || strings.Contains(body, "TOP-SECRET") {
			t.Errorf("note/at %s: %d %s", p, code, body)
		}
	}
	code, _ = ts.get(pat, "/api/note/history?ns=alpha&path=Shared/a.md")
	if code != 200 {
		t.Errorf("history of a granted note: %d", code)
	}
}

func TestRoutes_AttributionNeedsReadOnThePath(t *testing.T) {
	ts := newTestServer(t, true)
	code, _ := ts.get(jwtFor(t, uidPat, "collaborator", nil), "/api/note/attribution?ns=alpha&path=Private/p.md")
	if code != http.StatusForbidden {
		t.Errorf("attribution of /Private: %d", code)
	}
	code, _ = ts.get(jwtFor(t, uidPat, "collaborator", nil), "/api/note/attribution?ns=alpha&path=Shared/a.md")
	if code != 200 {
		t.Errorf("attribution of a granted note: %d", code)
	}
}

func TestRoutes_ChatListsStayInsideFolderGrant(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil)
	_, body := ts.get(pat, "/api/chats")
	if strings.Contains(body, "SECRET-ROOM") {
		t.Errorf("chats leaked a /Private room: %s", body)
	}
	_, body = ts.get(pat, "/api/chat/gifs?ns=alpha")
	if strings.Contains(body, "secret-gif") {
		t.Errorf("chat gifs listed a folder the user cannot read: %s", body)
	}
	_, body = ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/chat/gifs?ns=alpha")
	if !strings.Contains(body, "secret-gif") {
		t.Errorf("full reader lost the gif library: %s", body)
	}
}

func TestRoutes_TreeAdminOfAnotherNamespaceIsStillFiltered(t *testing.T) {
	ts := newTestServer(t, true)
	_, body := ts.get(jwtFor(t, uidAdele, "admin", nil), "/api/tree?ns=alpha")
	if strings.Contains(body, "Private") {
		t.Errorf("an admin of beta sees alpha's whole tree: %s", body)
	}
	if !strings.Contains(body, "Shared/a.md") {
		t.Errorf("tree lost the granted folder: %s", body)
	}
}

// --- hole 2: symlinks carry a read (or write) across a grant ---------------

func TestRoutes_SymlinkOutOfGrantIsRefused(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil)
	for _, p := range []string{"Shared/link.md", "Shared/ldir/p.md"} {
		code, body := ts.get(pat, "/api/note?ns=alpha&path="+p)
		if code != http.StatusForbidden || strings.Contains(body, "TOP-SECRET") {
			t.Errorf("GET /api/note %s: %d %s", p, code, body)
		}
		code, body = ts.get(pat, "/api/files/alpha/"+p)
		if code != http.StatusForbidden || strings.Contains(body, "TOP-SECRET") {
			t.Errorf("GET /api/files %s: %d %s", p, code, body)
		}
		code, _ = ts.do(pat, http.MethodPut, "/api/note?ns=alpha&path="+p, strings.NewReader("OVERWRITTEN"), "")
		if code != http.StatusForbidden {
			t.Errorf("PUT through %s: %d", p, code)
		}
	}
	if got := ts.readFile("alpha/Private/p.md"); strings.Contains(got, "OVERWRITTEN") {
		t.Fatalf("a /Shared writer overwrote /Private through a link")
	}
	code, _ := ts.do(pat, http.MethodPost, "/api/folder?ns=alpha&path=Shared/ldir/new", nil, "")
	if code != http.StatusForbidden {
		t.Errorf("mkdir through a linked folder: %d", code)
	}
	// A link that stays inside the grant keeps working.
	code, body := ts.get(pat, "/api/note?ns=alpha&path=Shared/ok-link.md")
	if code != 200 || !strings.Contains(body, "shared words") {
		t.Errorf("in-grant link broke: %d %s", code, body)
	}
	// And a reader of the whole namespace may still follow every link.
	code, body = ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/note?ns=alpha&path=Shared/link.md")
	if code != 200 || !strings.Contains(body, "TOP-SECRET") {
		t.Errorf("full reader lost a link: %d %s", code, body)
	}
}

// --- .git / .mdnest are never request paths ---------------------------------

func reservedPaths() []string {
	return []string{".git/config", ".GIT/config", "Shared/../.git/config", "sub/.git/config",
		".mdnest/comments/" + privateID + ".jsonl", ".MDNest/board.json", ".git"}
}

func checkGitRanNothing(t *testing.T, ts *testServer) {
	t.Helper()
	cfg := ts.readFile("alpha/.git/config")
	if strings.Contains(cfg, "fsmonitor") || strings.Contains(cfg, "PWNED") {
		t.Fatalf(".git/config was written: %q", cfg)
	}
	marker := filepath.Join(ts.root, "PWNED")
	os.WriteFile(filepath.Join(ts.root, "alpha", "n.md"), []byte("x"), 0o644)
	exec.Command("git", "-C", filepath.Join(ts.root, "alpha"), "add", "-A").Run() // what the committer runs
	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("git ran a planted command")
	}
}

func testReservedPathsRefused(t *testing.T, multi bool) {
	ts := newTestServer(t, multi)
	tok := jwtFor(t, uidOwen, "collaborator", nil) // full write in multi; anything in single
	payload := "[core]\n\tfsmonitor = \"touch " + filepath.Join(ts.root, "PWNED") + "; false\"\n"
	for _, p := range reservedPaths() {
		q := url.QueryEscape(p)
		for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodPost, http.MethodDelete} {
			code, body := ts.do(tok, m, "/api/note?ns=alpha&path="+q, strings.NewReader(payload), "")
			if code != http.StatusBadRequest {
				t.Errorf("%s /api/note %s: %d %s", m, p, code, body)
			}
		}
		checks := []struct{ method, path string }{
			{http.MethodGet, "/api/files/alpha/" + p},
			{http.MethodGet, "/api/note/history?ns=alpha&path=" + q},
			{http.MethodGet, "/api/note/at?ns=alpha&path=" + q + "&ref=0000000"},
			{http.MethodPost, "/api/folder?ns=alpha&path=" + q},
			{http.MethodPost, "/api/move?ns=alpha&from=Shared/a.md&to=" + q},
			{http.MethodPost, "/api/move?ns=alpha&from=" + q + "&to=Shared/stolen"},
			{http.MethodGet, "/api/tasks?ns=alpha&path=" + q},
			{http.MethodPatch, "/api/tasks?ns=alpha&path=" + q},
			{http.MethodGet, "/api/chat?ns=alpha&path=" + q},
			{http.MethodPost, "/api/chat/convert?ns=alpha&path=" + q},
			{http.MethodGet, "/api/download?ns=alpha&path=" + q},
		}
		if multi {
			checks = append(checks,
				struct{ method, path string }{http.MethodGet, "/api/comments?ns=alpha&path=" + q},
				struct{ method, path string }{http.MethodGet, "/api/note/attribution?ns=alpha&path=" + q})
		}
		for _, c := range checks {
			code, body := ts.do(tok, c.method, c.path, strings.NewReader(payload), "")
			if code < 400 || code == http.StatusInternalServerError || strings.Contains(body, "[core]") || strings.Contains(body, "PRIVATE-COMMENT") {
				t.Errorf("%s %s: %d %s", c.method, c.path, code, body)
			}
		}
	}
	// A transfer names its paths in the BODY: neither side may be reserved.
	for _, p := range reservedPaths() {
		for _, body := range []string{
			`{"mode":"copy","from":{"ns":"alpha","path":"Shared/a.md"},"to":{"ns":"alpha","path":` + strconv.Quote(p) + `}}`,
			`{"mode":"move","from":{"ns":"alpha","path":` + strconv.Quote(p) + `},"to":{"ns":"alpha","path":"Shared/stolen"}}`,
		} {
			for _, q := range []string{"", "?dryRun=1"} {
				code, resp := ts.do(tok, http.MethodPost, "/api/transfer"+q, strings.NewReader(body), "application/json")
				if code != http.StatusBadRequest || strings.Contains(resp, "[core]") {
					t.Errorf("transfer%s %s: %d %s", q, body, code, resp)
				}
			}
		}
	}
	// A task created into a reserved note named in the BODY.
	code, _ := ts.do(tok, http.MethodPost, "/api/tasks?ns=alpha&path=Shared/a.md",
		strings.NewReader(`{"title":"x","note":".git/hooks/pre-commit"}`), "application/json")
	if code < 400 {
		t.Errorf("task create into .git: %d", code)
	}
	// Upload: a reserved folder in the path, or a reserved name as the file.
	for _, tc := range []struct{ path, name string }{{"Shared/x.png", ".git"}, {".git/x", "config"}, {"Shared/x", ".mdnest"}} {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", tc.name)
		fw.Write([]byte(payload))
		mw.Close()
		code, body := ts.do(tok, http.MethodPost, "/api/upload?ns=alpha&path="+url.QueryEscape(tc.path), &buf, mw.FormDataContentType())
		if code < 400 {
			t.Errorf("upload %s/%s: %d %s", tc.path, tc.name, code, body)
		}
	}
	checkGitRanNothing(t, ts)
	// The tree and search never list them.
	_, tree := ts.get(tok, "/api/tree?ns=alpha")
	if strings.Contains(tree, ".git") || strings.Contains(tree, ".mdnest") {
		t.Errorf("tree lists a reserved folder: %s", tree)
	}
	// Ordinary dotfiles that are not reserved still work.
	code, _ = ts.do(tok, http.MethodPost, "/api/note?ns=alpha&path=Shared/.gitkeep-notes.md", strings.NewReader("ok"), "")
	if code != http.StatusCreated {
		t.Errorf("a dotted-but-not-reserved name was refused: %d", code)
	}
}

func TestRoutes_ReservedPathsRefused_Multi(t *testing.T)  { testReservedPathsRefused(t, true) }
func TestRoutes_ReservedPathsRefused_Single(t *testing.T) { testReservedPathsRefused(t, false) }

// Server-built .mdnest paths keep working: comments write their sidecar.
func TestRoutes_ServerBuiltMdnestPathsStillWork(t *testing.T) {
	ts := newTestServer(t, true)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	code, body := ts.do(owen, http.MethodPost, "/api/comments?ns=alpha&path=Shared/a.md",
		strings.NewReader(`{"body":"looks good","anchorText":"shared"}`), "application/json")
	if code != http.StatusCreated && code != http.StatusOK {
		t.Fatalf("comment create: %d %s", code, body)
	}
	_, body = ts.get(owen, "/api/comments?ns=alpha&path=Shared/a.md")
	if !strings.Contains(body, "looks good") {
		t.Fatalf("comment not stored: %s", body)
	}
}

// --- auth: a login step token is not a session -----------------------------

func TestRoutes_TempTokenIsNotASession(t *testing.T) {
	ts := newTestServer(t, true)
	for _, purpose := range []string{"totp", "totp_setup", "change_password", "anything"} {
		tok := jwtFor(t, uidOwen, "collaborator", jwt.MapClaims{"purpose": purpose})
		code, body := ts.get(tok, "/api/note?ns=alpha&path=Shared/a.md")
		if code != http.StatusUnauthorized {
			t.Errorf("purpose=%s on /api/note: %d %s", purpose, code, body)
		}
		// The <img> query-token fallback must refuse it too.
		code, _ = ts.get("", "/api/files/alpha/Shared/a.md?token="+tok)
		if code != http.StatusUnauthorized {
			t.Errorf("purpose=%s via ?token=: %d", purpose, code)
		}
	}
	code, _ := ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/note?ns=alpha&path=Shared/a.md")
	if code != 200 {
		t.Errorf("a session token stopped working: %d", code)
	}
	code, _ = ts.get("", "/api/files/alpha/Shared/a.md?token="+jwtFor(t, uidOwen, "collaborator", nil))
	if code != 200 {
		t.Errorf("?token= fallback stopped working: %d", code)
	}
}

func TestRoutes_APITokens(t *testing.T) {
	ts := newTestServer(t, true)
	owned, _, err := ts.tokens.CreateAPIToken("ci", uidPat, "pat", "collaborator")
	if err != nil {
		t.Fatal(err)
	}
	code, body := ts.get(owned, "/api/note?ns=alpha&path=Shared/a.md")
	if code != 200 {
		t.Errorf("owned API token: %d %s", code, body)
	}
	code, _ = ts.get(owned, "/api/note?ns=alpha&path=Private/p.md")
	if code != http.StatusForbidden {
		t.Errorf("owned API token escaped its grant: %d", code)
	}
	// An ownerless token (a single-mode token imported after switching to
	// multi mode) resolves to no user. It must not be treated as single mode.
	legacy, _, _ := ts.tokens.CreateAPIToken("legacy", 0, "admin", "")
	for _, p := range []string{"/api/note?ns=alpha&path=Private/p.md", "/api/tasks/all", "/api/search?ns=alpha&q=TOP"} {
		code, body := ts.get(legacy, p)
		if code != http.StatusUnauthorized || strings.Contains(body, "TOP-SECRET") || strings.Contains(body, "SECRET-TASK") {
			t.Errorf("ownerless token on %s: %d %s", p, code, body)
		}
	}
}

func TestRoutes_SingleModeUnchanged(t *testing.T) {
	ts := newTestServer(t, false)
	tok := jwtFor(t, 0, "", nil)
	code, body := ts.get(tok, "/api/note?ns=alpha&path=Shared/link.md")
	if code != 200 || !strings.Contains(body, "TOP-SECRET") {
		t.Errorf("single mode must still follow in-namespace links: %d %s", code, body)
	}
	_, body = ts.get(tok, "/api/search?ns=alpha&q=TOP-SECRET")
	if !strings.Contains(body, "Private/p.md") {
		t.Errorf("single-mode search lost results: %s", body)
	}
	_, body = ts.get(tok, "/api/tasks/all")
	if !strings.Contains(body, "SECRET-TASK") {
		t.Errorf("single-mode tasks lost results: %s", body)
	}
	code, _ = ts.do(tok, http.MethodPatch, "/api/note?ns=alpha&path=Shared/a.md", strings.NewReader("more\n"), "")
	if code != 200 {
		t.Errorf("single-mode append: %d", code)
	}
	if mk, _, _ := ts.tokens.CreateAPIToken("cli", 0, "admin", ""); mk != "" {
		if code, _ := ts.get(mk, "/api/note?ns=alpha&path=Private/p.md"); code != 200 {
			t.Errorf("single-mode API token: %d", code)
		}
	}
}

// --- sync-status ------------------------------------------------------------

func TestRoutes_SyncStatusNeedsNamespaceAccessAndHidesCredentials(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil)
	code, body := ts.get(pat, "/api/admin/sync-status?ns=beta")
	if code != http.StatusForbidden {
		t.Errorf("sync-status of an ungranted namespace: %d %s", code, body)
	}
	code, body = ts.get(pat, "/api/admin/sync-status?ns=alpha")
	if code != 200 || strings.Contains(body, "s3cr3t-pat") || strings.Contains(body, "bob:") {
		t.Errorf("sync-status leaked remote credentials: %d %s", code, body)
	}
	if !strings.Contains(body, "git.example.com/team/alpha.git") {
		t.Errorf("sync-status lost the remote host: %s", body)
	}
}

// --- live collaboration -----------------------------------------------------

type wsClient struct {
	c    *websocket.Conn
	msgs chan map[string]any
}

func dialWS(t *testing.T, ts *testServer, token, p string) (*wsClient, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	u := strings.Replace(ts.srv.URL, "http", "ws", 1) + "/api/ws?ns=alpha&path=" + url.QueryEscape(p) + "&token=" + token
	c, resp, err := websocket.Dial(ctx, u, nil)
	if err != nil {
		if resp != nil {
			return nil, resp.StatusCode
		}
		t.Fatalf("dial: %v", err)
	}
	wc := &wsClient{c: c, msgs: make(chan map[string]any, 64)}
	go func() {
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				close(wc.msgs)
				return
			}
			var m map[string]any
			json.Unmarshal(data, &m)
			wc.msgs <- m
		}
	}()
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return wc, http.StatusSwitchingProtocols
}

func (w *wsClient) send(t *testing.T, v any) {
	b, _ := json.Marshal(v)
	if err := w.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}

// waitFor returns the first message of the given type within d.
func (w *wsClient) waitFor(typ string, d time.Duration) map[string]any {
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-w.msgs:
			if !ok {
				return nil
			}
			if m["type"] == typ {
				return m
			}
		case <-deadline:
			return nil
		}
	}
}

func TestRoutes_LiveCollabRespectsGrants(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil) // writer of /Shared
	gus := jwtFor(t, uidGus, "collaborator", nil) // reader of /Shared

	for _, p := range []string{"Private/p.md", "Shared/../Private/p.md", "Shared/link.md", ".git/config"} {
		if c, code := dialWS(t, ts, pat, p); c != nil || code < 400 {
			t.Errorf("joined the room of %s (status %d)", p, code)
		}
	}
	if c, code := dialWS(t, ts, jwtFor(t, uidOwen, "collaborator", jwt.MapClaims{"purpose": "totp"}), "Shared/a.md"); c != nil || code != http.StatusUnauthorized {
		t.Errorf("temp token joined a room (status %d)", code)
	}

	writer, _ := dialWS(t, ts, pat, "Shared/a.md")
	reader, _ := dialWS(t, ts, gus, "Shared/a.md")
	if writer == nil || reader == nil {
		t.Fatal("granted users could not join")
	}
	time.Sleep(100 * time.Millisecond) // both joined
	reader.send(t, map[string]any{"type": "content", "content": "INJECTED"})
	reader.send(t, map[string]any{"type": "cursor", "line": 3})
	if m := writer.waitFor("content", 400*time.Millisecond); m != nil {
		t.Errorf("a reader's content reached a writer: %v", m)
	}
	if m := writer.waitFor("cursor", 100*time.Millisecond); m != nil {
		t.Errorf("a reader's cursor reached a writer: %v", m)
	}
	writer.send(t, map[string]any{"type": "content", "content": "REAL EDIT"})
	if m := reader.waitFor("content", 2*time.Second); m == nil || m["content"] != "REAL EDIT" {
		t.Errorf("a writer's live edit did not reach the reader: %v", m)
	}
}

// A link's TARGET is held to the same rules as a request path: a write through
// a link into .git is the fsmonitor attack again, and a link out of the
// namespace must not serve another namespace's file — to anyone, including a
// whole-namespace writer, whose grant check alone would pass.
func TestRoutes_LinksIntoReservedOrOutOfNamespaceAreRefused(t *testing.T) {
	ts := newTestServer(t, true)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	payload := "[core]\n\tfsmonitor = \"touch " + filepath.Join(ts.root, "PWNED") + "; false\"\n"
	for _, p := range []string{"Shared/cfg.md", "Shared/thread.md", "Shared/out.md"} {
		code, body := ts.get(owen, "/api/note?ns=alpha&path="+p)
		if code < 400 || strings.Contains(body, "[core]") || strings.Contains(body, "PRIVATE-COMMENT") || strings.Contains(body, "BETA-SECRET") {
			t.Errorf("GET %s: %d %s", p, code, body)
		}
		code, _ = ts.do(owen, http.MethodPut, "/api/note?ns=alpha&path="+p, strings.NewReader(payload), "")
		if code < 400 {
			t.Errorf("PUT %s: %d", p, code)
		}
	}
	checkGitRanNothing(t, ts)
	_, body := ts.get(owen, "/api/search?ns=alpha&q=BETA-SECRET")
	if strings.Contains(body, "BETA-SECRET") {
		t.Errorf("search served a file outside the namespace: %s", body)
	}
}

// The board's columns belong to the whole namespace, so changing them needs
// write on the namespace, whatever ?path= the request names.
func TestRoutes_BoardWriteNeedsNamespaceWrite(t *testing.T) {
	ts := newTestServer(t, true)
	board := `{"version":1,"columns":[{"id":"x","title":"Hijacked"}]}`
	code, _ := ts.do(jwtFor(t, uidPat, "collaborator", nil), http.MethodPut, "/api/board?ns=alpha&path=Shared/a.md", strings.NewReader(board), "application/json")
	if code != http.StatusForbidden {
		t.Errorf("a /Shared writer replaced the namespace board: %d", code)
	}
	code, _ = ts.do(jwtFor(t, uidOwen, "collaborator", nil), http.MethodPut, "/api/board?ns=alpha", strings.NewReader(board), "application/json")
	if code != http.StatusOK {
		t.Errorf("a namespace writer could not save the board: %d", code)
	}
	code, _ = ts.get(jwtFor(t, uidPat, "collaborator", nil), "/api/board?ns=alpha&path=Shared/a.md")
	if code != http.StatusOK {
		t.Errorf("a /Shared user lost read of the board layout: %d", code)
	}
}

// --- download and transfer (issue #114) ---------------------------------------

func zipEntries(t *testing.T, body string) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(strings.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

// A folder download goes through path-scoped read: a /Shared reader zips
// /Shared (without its links), never /Private, the namespace root, or
// anything a link reaches.
func TestRoutes_DownloadStaysInsideFolderGrant(t *testing.T) {
	ts := newTestServer(t, true)
	secrets := []string{"TOP-SECRET", "PRIVATE-COMMENT", "s3cr3t-pat", "BETA-SECRET"}
	for _, tok := range []string{jwtFor(t, uidPat, "collaborator", nil), jwtFor(t, uidGus, "collaborator", nil)} {
		code, body := ts.get(tok, "/api/download?ns=alpha&path=Shared")
		if code != 200 {
			t.Fatalf("download of the granted folder: %d %s", code, body)
		}
		for name, content := range zipEntries(t, body) {
			for _, s := range secrets {
				if strings.Contains(content, s) {
					t.Errorf("zip entry %s carries %s", name, s)
				}
			}
			if strings.Contains(name, "link") || strings.Contains(name, "ldir") || strings.Contains(name, "cfg") || strings.Contains(name, "out.md") || strings.Contains(name, "thread") {
				t.Errorf("zip carries a link: %s", name)
			}
		}
		for _, p := range []string{"Private", "Private/p.md", "Shared/../Private", "Shared/link.md", "Shared/ldir", "Shared/ldir/p.md", "Shared/cfg.md", "Shared/thread.md", "Shared/out.md", ""} {
			code, body := ts.get(tok, "/api/download?ns=alpha&path="+url.QueryEscape(p))
			if code < 400 {
				t.Errorf("download %q: %d", p, code)
			}
			for _, s := range secrets {
				if strings.Contains(body, s) {
					t.Errorf("download %q leaked %s", p, s)
				}
			}
		}
	}
	// A reader of the whole namespace gets it all, minus .git, .mdnest and links.
	code, body := ts.get(jwtFor(t, uidOwen, "collaborator", nil), "/api/download?ns=alpha")
	if code != 200 {
		t.Fatalf("full reader, root download: %d", code)
	}
	for name, content := range zipEntries(t, body) {
		if strings.Contains(name, ".git/") || strings.Contains(name, ".mdnest/") || strings.Contains(content, "s3cr3t-pat") || strings.Contains(content, "PRIVATE-COMMENT") || strings.Contains(content, "BETA-SECRET") {
			t.Errorf("root zip entry %s exposes internals", name)
		}
	}
}

// Transfer names two namespaces in its body; the route table gives it no
// middleware, so this pins that the handler's own checks are the real ones.
func TestRoutes_TransferChecksBothSides(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil) // write alpha:/Shared
	adele := jwtFor(t, uidAdele, "admin", nil)    // read alpha:/Shared, admin of beta
	gus := jwtFor(t, uidGus, "collaborator", nil) // group read alpha:/Shared
	req := func(mode, fns, fp, tns, tp string) string {
		return `{"mode":"` + mode + `","from":{"ns":"` + fns + `","path":` + strconv.Quote(fp) + `},"to":{"ns":"` + tns + `","path":` + strconv.Quote(tp) + `}}`
	}
	denied := []struct {
		tok, body string
	}{
		{pat, req("copy", "alpha", "Shared/a.md", "beta", "a.md")},          // no grant on beta
		{pat, req("copy", "alpha", "Private/p.md", "alpha", "Shared/p.md")}, // cannot read /Private
		{pat, req("copy", "alpha", "Shared/../Private/p.md", "alpha", "Shared/p.md")},
		{pat, req("copy", "alpha", "Shared/link.md", "alpha", "Shared/l2.md")}, // a link out of the grant
		{pat, req("copy", "alpha", "Shared/ldir/p.md", "alpha", "Shared/l3.md")},
		{pat, req("move", "alpha", "Shared/a.md", "alpha", "Private/a.md")},     // cannot write /Private
		{pat, req("copy", "alpha", "Shared/a.md", "alpha", "Shared/ldir/a.md")}, // writes through a link into /Private
		{adele, req("move", "alpha", "Shared/a.md", "beta", "a.md")},            // move needs write on the source
		{gus, req("copy", "alpha", "Shared/a.md", "alpha", "Shared/g.md")},      // read-only group grant
	}
	for _, d := range denied {
		for _, q := range []string{"?dryRun=1", ""} {
			code, body := ts.do(d.tok, http.MethodPost, "/api/transfer"+q, strings.NewReader(d.body), "application/json")
			if code != http.StatusForbidden || strings.Contains(body, "TOP-SECRET") {
				t.Errorf("%s%s: %d %s", d.body, q, code, body)
			}
		}
	}
	if got := ts.readFile("alpha/Private/a.md") + ts.readFile("alpha/Shared/p.md") + ts.readFile("beta/a.md"); got != "" {
		t.Fatalf("a denied transfer wrote something: %q", got)
	}
	// Allowed: a copy inside the writable folder, and a namespace admin
	// copying what they may read into their namespace.
	for _, a := range []struct{ tok, body, file string }{
		{pat, req("copy", "alpha", "Shared/a.md", "alpha", "Shared/copy.md"), "alpha/Shared/copy.md"},
		{adele, req("copy", "alpha", "Shared/a.md", "beta", "from-alpha.md"), "beta/from-alpha.md"},
	} {
		code, body := ts.do(a.tok, http.MethodPost, "/api/transfer", strings.NewReader(a.body), "application/json")
		if code != 200 || !strings.Contains(ts.readFile(a.file), "shared words") {
			t.Errorf("%s: %d %s", a.body, code, body)
		}
	}
	// A folder holding links is refused rather than half-copied.
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	code, body := ts.do(owen, http.MethodPost, "/api/transfer", strings.NewReader(req("copy", "alpha", "Shared", "alpha", "Copied")), "application/json")
	if code != http.StatusBadRequest || !strings.Contains(body, "symlink") {
		t.Errorf("folder with links: %d %s", code, body)
	}
	// An ownerless legacy token is not single mode here either.
	legacy, _, _ := ts.tokens.CreateAPIToken("legacy", 0, "admin", "")
	code, _ = ts.do(legacy, http.MethodPost, "/api/transfer", strings.NewReader(req("copy", "alpha", "Private/p.md", "beta", "p.md")), "application/json")
	if code != http.StatusUnauthorized {
		t.Errorf("ownerless token transfer: %d", code)
	}
	code, _ = ts.get(legacy, "/api/download?ns=alpha&path=Private")
	if code != http.StatusUnauthorized {
		t.Errorf("ownerless token download: %d", code)
	}
}

// Single mode: one owner, so download and transfer work across the board.
func TestRoutes_SingleModeDownloadAndTransfer(t *testing.T) {
	ts := newTestServer(t, false)
	tok := jwtFor(t, 0, "", nil)
	code, body := ts.get(tok, "/api/download?ns=alpha&path=Private")
	if code != 200 || !strings.Contains(strings.Join(func() []string {
		var v []string
		for _, c := range zipEntries(t, body) {
			v = append(v, c)
		}
		return v
	}(), ""), "TOP-SECRET") {
		t.Errorf("single-mode download: %d", code)
	}
	code, body = ts.do(tok, http.MethodPost, "/api/transfer", strings.NewReader(`{"mode":"move","from":{"ns":"alpha","path":"Private/p.md"},"to":{"ns":"beta","path":"moved/p.md"}}`), "application/json")
	if code != 200 || !strings.Contains(ts.readFile("beta/moved/p.md"), "TOP-SECRET") || ts.readFile("alpha/Private/p.md") != "" {
		t.Errorf("single-mode move: %d %s", code, body)
	}
	if !strings.Contains(ts.readFile("beta/.mdnest/comments/"+privateID+".jsonl"), "PRIVATE-COMMENT") {
		t.Errorf("the moved note's comments did not follow it")
	}
}
