package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// Tests for POST /api/transfer, against the PRD's acceptance cases (the case
// number is in each test's comment).

const (
	idA = "aaaaaaaa-1111-4111-8111-111111111111"
	idB = "bbbbbbbb-2222-4222-8222-222222222222"
)

func marked(body, id string) string { return InjectNoteID(body, id) }

// tenv is a notes root with namespaces alpha and beta on the local backend.
type tenv struct {
	root    string
	store   storage.Storage
	h       *TransferHandler
	mu      sync.Mutex
	changed []string
}

func newTEnv(t *testing.T) *tenv {
	t.Helper()
	root := t.TempDir()
	for _, ns := range []string{"alpha", "beta"} {
		if err := os.MkdirAll(filepath.Join(root, ns), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	return newTEnvWith(t, root, stg)
}

func newTEnvWith(t *testing.T, root string, stg storage.Storage) *tenv {
	e := &tenv{root: root, store: stg}
	allow := func(*http.Request, string, string) bool { return true }
	e.h = NewTransferHandler(stg, DefaultTreeLimits, allow, allow, func(ns string) {
		e.mu.Lock()
		e.changed = append(e.changed, ns)
		e.mu.Unlock()
	})
	return e
}

func (e *tenv) put(t *testing.T, ns, rel, content string) {
	t.Helper()
	p := filepath.Join(e.root, ns, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (e *tenv) read(t *testing.T, ns, rel string) (string, bool) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.root, ns, filepath.FromSlash(rel)))
	if err != nil {
		return "", false
	}
	return string(b), true
}

// snapshot lists every path (and file body) under the notes root.
func (e *tenv) snapshot(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	filepath.Walk(e.root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(e.root, p)
		if info.IsDir() {
			out[rel+"/"] = ""
			return nil
		}
		b, _ := os.ReadFile(p)
		out[rel] = string(b)
		return nil
	})
	return out
}

func transferReq(mode, fromNS, from, toNS, to string) map[string]any {
	return map[string]any{"mode": mode, "from": map[string]string{"ns": fromNS, "path": from}, "to": map[string]string{"ns": toNS, "path": to}}
}

func doTransfer(t *testing.T, h *TransferHandler, body map[string]any, dry bool, uc *middleware.UserContext) (int, map[string]any, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	url := "/api/transfer"
	if dry {
		url += "?dryRun=1"
	}
	r := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(b))
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	h.HandleTransfer(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Body.String()
}

func noteID(t *testing.T, content string) string {
	t.Helper()
	id, _ := ExtractNoteID(content)
	return id
}

// Case 1: a collision never overwrites, and names the destination path.
func TestTransfer_CollisionNeverOverwrites(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "x.md", "source\n")
	e.put(t, "beta", "x.md", "precious\n")
	for _, mode := range []string{"copy", "move"} {
		code, body, _ := doTransfer(t, e.h, transferReq(mode, "alpha", "x.md", "beta", "x.md"), false, nil)
		if code != http.StatusConflict || body["error"] != "exists" || body["path"] != "x.md" {
			t.Fatalf("%s: got %d %v, want 409 exists x.md", mode, code, body)
		}
		if got, _ := e.read(t, "beta", "x.md"); got != "precious\n" {
			t.Fatalf("%s overwrote the destination: %q", mode, got)
		}
		if _, ok := e.read(t, "alpha", "x.md"); !ok {
			t.Fatalf("%s removed the source on a collision", mode)
		}
	}
	// A destination whose parent is a file collides at the parent.
	e.put(t, "beta", "Proj", "a file, not a folder\n")
	code, body, _ := doTransfer(t, e.h, transferReq("copy", "alpha", "x.md", "beta", "Proj/x.md"), false, nil)
	if code != http.StatusConflict || body["path"] != "Proj" {
		t.Fatalf("parent-is-file: got %d %v, want 409 at Proj", code, body)
	}
	// A folder onto an existing folder is a collision too (no merge).
	e.put(t, "alpha", "F/a.md", "a\n")
	e.put(t, "beta", "F/other.md", "keep\n")
	code, body, _ = doTransfer(t, e.h, transferReq("copy", "alpha", "F", "beta", "F"), false, nil)
	if code != http.StatusConflict || body["path"] != "F" {
		t.Fatalf("folder collision: got %d %v", code, body)
	}
	if _, ok := e.read(t, "beta", "F/a.md"); ok {
		t.Fatal("folder collision still wrote into the existing folder")
	}
}

// Case 2: a copy gives every note a fresh UUID and copies no comments.
func TestTransfer_CopyFreshIDsNoComments(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "F/one.md", marked("one\n", idA))
	e.put(t, "alpha", "F/sub/two.md", marked("two\n", idB))
	e.put(t, "alpha", ".mdnest/comments/"+idA+".jsonl", `{"id":"c1"}`+"\n")

	// File copy.
	code, body, _ := doTransfer(t, e.h, transferReq("copy", "alpha", "F/one.md", "beta", "one.md"), false, nil)
	if code != http.StatusOK || body["items"] != float64(1) {
		t.Fatalf("file copy: %d %v", code, body)
	}
	got, _ := e.read(t, "beta", "one.md")
	if id := noteID(t, got); id == "" || id == idA {
		t.Fatalf("file copy kept or lost the identity: %q", id)
	}
	// Folder copy.
	code, body, _ = doTransfer(t, e.h, transferReq("copy", "alpha", "F", "beta", "G"), false, nil)
	if code != http.StatusOK || body["items"] != float64(2) {
		t.Fatalf("folder copy: %d %v", code, body)
	}
	one, _ := e.read(t, "beta", "G/one.md")
	two, _ := e.read(t, "beta", "G/sub/two.md")
	ids := map[string]bool{idA: true, idB: true, noteID(t, got): true}
	for _, c := range []string{one, two} {
		id := noteID(t, c)
		if id == "" || ids[id] {
			t.Fatalf("copied note id %q is missing or reused", id)
		}
		ids[id] = true
	}
	if !strings.HasPrefix(one, "one\n") || !strings.HasPrefix(two, "two\n") {
		t.Fatalf("copied bodies changed: %q %q", one, two)
	}
	if _, err := os.Stat(filepath.Join(e.root, "beta", ".mdnest")); err == nil {
		t.Fatal("a copy carried comment sidecars")
	}
	// The source is untouched by a copy.
	if src, _ := e.read(t, "alpha", "F/one.md"); noteID(t, src) != idA {
		t.Fatal("copy changed the source note")
	}
}

// Case 3: a move keeps every UUID; each sidecar moves and is gone from the source.
func TestTransfer_MoveKeepsIDsAndMovesComments(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "F/one.md", marked("one\n", idA))
	e.put(t, "alpha", "F/sub/two.md", marked("two\n", idB))
	e.put(t, "alpha", ".mdnest/comments/"+idA+".jsonl", `{"id":"c1"}`+"\n")
	e.put(t, "alpha", ".mdnest/comments/"+idB+".jsonl", `{"id":"c2"}`+"\n")
	e.put(t, "alpha", "solo.md", marked("solo\n", "cccccccc-3333-4333-8333-333333333333"))

	code, _, _ := doTransfer(t, e.h, transferReq("move", "alpha", "F", "beta", "Moved/F"), false, nil)
	if code != http.StatusOK {
		t.Fatalf("folder move: %d", code)
	}
	for rel, id := range map[string]string{"Moved/F/one.md": idA, "Moved/F/sub/two.md": idB} {
		c, ok := e.read(t, "beta", rel)
		if !ok || noteID(t, c) != id {
			t.Fatalf("%s: id %q, want %q", rel, noteID(t, c), id)
		}
		if _, ok := e.read(t, "beta", ".mdnest/comments/"+id+".jsonl"); !ok {
			t.Fatalf("comments for %s did not move", rel)
		}
		if _, ok := e.read(t, "alpha", ".mdnest/comments/"+id+".jsonl"); ok {
			t.Fatalf("comments for %s still in the source", rel)
		}
	}
	if _, err := os.Stat(filepath.Join(e.root, "alpha", "F")); err == nil {
		t.Fatal("the source folder survived the move")
	}
	// File move, no comments: the identity still travels.
	code, _, _ = doTransfer(t, e.h, transferReq("move", "alpha", "solo.md", "beta", "solo.md"), false, nil)
	c, _ := e.read(t, "beta", "solo.md")
	if code != http.StatusOK || noteID(t, c) != "cccccccc-3333-4333-8333-333333333333" {
		t.Fatalf("file move: %d %q", code, c)
	}
}

// failingStore fails WriteFile/WriteFrom for one destination path.
type failingStore struct {
	storage.Storage
	failNS, failPath string
}

func (f *failingStore) WriteFile(ctx context.Context, ns, rel string, data []byte) error {
	if ns == f.failNS && rel == f.failPath {
		return errors.New("disk full")
	}
	return f.Storage.WriteFile(ctx, ns, rel, data)
}

// Case 6: a failed cross-namespace move leaves the source untouched and
// removes the partial target, comment sidecars included.
func TestTransfer_MoveFailureRollsBack(t *testing.T) {
	root := t.TempDir()
	for _, ns := range []string{"alpha", "beta"} {
		os.MkdirAll(filepath.Join(root, ns), 0o755)
	}
	local, _ := storage.NewLocalStorage(root)
	e := newTEnvWith(t, root, &failingStore{Storage: local, failNS: "beta", failPath: "F/z.md"})
	e.put(t, "alpha", "F/a.md", marked("a\n", idA))
	e.put(t, "alpha", "F/img.png", "PNGDATA")
	e.put(t, "alpha", "F/z.md", "z\n")
	e.put(t, "alpha", ".mdnest/comments/"+idA+".jsonl", "{}\n")
	before := e.snapshot(t)

	code, body, _ := doTransfer(t, e.h, transferReq("move", "alpha", "F", "beta", "F"), false, nil)
	if code != http.StatusInternalServerError {
		t.Fatalf("got %d %v, want 500", code, body)
	}
	after := e.snapshot(t)
	// The only acceptable residue is the (now empty) .mdnest/comments
	// directory in beta that the rollback emptied.
	delete(after, filepath.Join("beta", ".mdnest")+"/")
	delete(after, filepath.Join("beta", ".mdnest", "comments")+"/")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("disk changed after a failed move:\nbefore %v\nafter  %v", keys(before), keys(after))
	}
	if len(e.changed) != 0 {
		t.Fatalf("a failed transfer reported changes: %v", e.changed)
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Case 7 and the root rules: nothing is moved into itself, onto itself, or
// from/to the namespace root, and nothing reaches into .git / .mdnest.
func TestTransfer_BadShapes(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "F/sub/a.md", "a\n")
	before := e.snapshot(t)
	cases := []struct {
		name string
		req  map[string]any
	}{
		{"into itself", transferReq("move", "alpha", "F", "alpha", "F/sub/F")},
		{"copy into itself", transferReq("copy", "alpha", "F", "alpha", "F/G")},
		{"same path", transferReq("move", "alpha", "F", "alpha", "F/")},
		{"root source move", transferReq("move", "alpha", "", "beta", "x")},
		{"root source copy", transferReq("copy", "alpha", "/", "beta", "x")},
		{"root destination", transferReq("copy", "alpha", "F", "beta", "/")},
		{"traversal source", transferReq("copy", "alpha", "../beta/x", "beta", "x")},
		{"traversal destination", transferReq("copy", "alpha", "F", "beta", "../alpha/F2")},
		{"into .mdnest", transferReq("copy", "alpha", "F/sub/a.md", "beta", ".mdnest/comments/x.jsonl")},
		{"from .git", transferReq("copy", "alpha", ".git/config", "beta", "c")},
		{"bad mode", transferReq("rename", "alpha", "F", "beta", "F")},
		{"bad namespace", transferReq("copy", "../alpha", "F", "beta", "F")},
	}
	for _, c := range cases {
		code, body, _ := doTransfer(t, e.h, c.req, false, nil)
		if code != http.StatusBadRequest {
			t.Errorf("%s: got %d %v, want 400", c.name, code, body)
		}
	}
	if !reflect.DeepEqual(before, e.snapshot(t)) {
		t.Fatal("a refused transfer changed the disk")
	}
}

// Case 8: both namespaces are reported changed (search cache + tree refresh).
func TestTransfer_RefreshesBothNamespaces(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "x.md", "x\n")
	if code, _, _ := doTransfer(t, e.h, transferReq("move", "alpha", "x.md", "beta", "x.md"), false, nil); code != http.StatusOK {
		t.Fatalf("move: %d", code)
	}
	sort.Strings(e.changed)
	if !reflect.DeepEqual(e.changed, []string{"alpha", "beta"}) {
		t.Fatalf("changed = %v, want both namespaces", e.changed)
	}
	// With the real search handler wired as main.go does, both caches go.
	sh := NewSearchHandler(e.store)
	sh.getFiles(context.Background(), "alpha")
	sh.getFiles(context.Background(), "beta")
	e.h.onChange = sh.InvalidateCache
	if code, _, _ := doTransfer(t, e.h, transferReq("copy", "beta", "x.md", "alpha", "y.md"), false, nil); code != http.StatusOK {
		t.Fatalf("copy: %d", code)
	}
	for _, ns := range []string{"alpha", "beta"} {
		if _, ok := sh.caches.Load(ns); ok {
			t.Fatalf("search cache for %s was not invalidated", ns)
		}
	}
}

// pathGrants grants (ns, path-prefix, permission) triples to user 1.
type pathGrants struct {
	fakeGrantStore
	grants [][3]string
}

func (p *pathGrants) CheckAccess(userID int, ns, path, perm string) bool {
	if userID != 1 {
		return false
	}
	for _, g := range p.grants {
		if g[0] != ns {
			continue
		}
		if !(g[1] == "/" || path == g[1] || strings.HasPrefix(path, g[1]+"/")) {
			continue
		}
		if perm == "read" || g[2] == "write" {
			return true
		}
	}
	return false
}

func (p *pathGrants) GetAccessibleNamespaces(int) ([]string, error) {
	var out []string
	for _, g := range p.grants {
		out = append(out, g[0])
	}
	return out, nil
}

// groupGrants is a GroupStore granting one (ns, path, perm) to OIDC group "eng".
type groupGrants struct {
	store.GroupStore
	ns, path, perm string
}

func (g *groupGrants) CheckGroupAccess(_ int, groups []string, ns, path, perm string) bool {
	in := false
	for _, x := range groups {
		in = in || x == "eng"
	}
	if !in || ns != g.ns || !(path == g.path || strings.HasPrefix(path, g.path+"/")) {
		return false
	}
	return perm == "read" || g.perm == "write"
}

func (g *groupGrants) GetAccessibleNamespacesForGroups(int, []string) ([]string, error) {
	return []string{g.ns}, nil
}

// Case 9: missing access on either side is a 403 with nothing changed —
// path-scoped grants, a group grant, and the dry run all agree.
func TestTransfer_Permissions(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "Shared/a.md", "a\n")
	e.put(t, "alpha", "Private/p.md", "p\n")
	grants := &pathGrants{grants: [][3]string{
		{"alpha", "/Shared", "read"},
		{"beta", "/Inbox", "write"},
	}}
	pc := middleware.NewPermissionChecker(grants, fakeNsAdminStore{}, &groupGrants{ns: "alpha", path: "/Team", perm: "write"})
	cr, cw := TransferPermissionFuncs(pc)
	e.h.canRead, e.h.canWrite = cr, cw
	user := &middleware.UserContext{ID: 1, Role: "collaborator"}
	before := e.snapshot(t)

	denied := []struct {
		name string
		req  map[string]any
		uc   *middleware.UserContext
	}{
		{"copy from an unreadable path", transferReq("copy", "alpha", "Private/p.md", "beta", "Inbox/p.md"), user},
		{"traversal out of the readable path", transferReq("copy", "alpha", "Shared/../Private/p.md", "beta", "Inbox/p.md"), user},
		{"copy to an unwritable path", transferReq("copy", "alpha", "Shared/a.md", "beta", "Elsewhere/a.md"), user},
		{"move needs write on the source", transferReq("move", "alpha", "Shared/a.md", "beta", "Inbox/a.md"), user},
		{"group member outside the group's path", transferReq("copy", "alpha", "Private/p.md", "alpha", "Team/p.md"), &middleware.UserContext{ID: 2, Groups: []string{"eng"}}},
		{"api token without a user", transferReq("copy", "alpha", "Shared/a.md", "beta", "Inbox/a.md"), &middleware.UserContext{ID: 99}},
	}
	for _, d := range denied {
		for _, dry := range []bool{true, false} {
			code, body, _ := doTransfer(t, e.h, d.req, dry, d.uc)
			if code != http.StatusForbidden {
				t.Errorf("%s (dry=%v): got %d %v, want 403", d.name, dry, code, body)
			}
		}
	}
	if !reflect.DeepEqual(before, e.snapshot(t)) {
		t.Fatal("a denied transfer changed the disk")
	}

	// Allowed: read source + write target.
	if code, body, _ := doTransfer(t, e.h, transferReq("copy", "alpha", "Shared/a.md", "beta", "Inbox/a.md"), false, user); code != http.StatusOK {
		t.Fatalf("permitted copy: %d %v", code, body)
	}
	// A group grant (OIDC group "eng" may write alpha:/Team) is enough for a
	// move inside it.
	e.put(t, "alpha", "Team/t.md", "t\n")
	member := &middleware.UserContext{ID: 2, Groups: []string{"eng"}}
	if code, body, _ := doTransfer(t, e.h, transferReq("move", "alpha", "Team/t.md", "alpha", "Team/Done/t.md"), false, member); code != http.StatusOK {
		t.Fatalf("group-granted move: %d %v", code, body)
	}

	// A nil check (forgotten wiring) denies, never allows.
	e.h.canRead = nil
	if code, _, _ := doTransfer(t, e.h, transferReq("copy", "alpha", "Shared/a.md", "beta", "Inbox/b.md"), false, user); code != http.StatusForbidden {
		t.Fatalf("nil canRead allowed a copy: %d", code)
	}
}

// Case 5 (transfer half): an oversized folder is refused with the counts.
func TestTransfer_TooLarge(t *testing.T) {
	e := newTEnv(t)
	e.h.limits = TreeLimits{MaxFiles: 2, MaxBytes: 1 << 20}
	for _, n := range []string{"a", "b", "c"} {
		e.put(t, "alpha", "F/"+n+".md", n+"\n")
	}
	code, body, _ := doTransfer(t, e.h, transferReq("copy", "alpha", "F", "beta", "F"), false, nil)
	if code != http.StatusRequestEntityTooLarge || body["error"] != "too_large" || body["files"] != float64(3) || body["maxFiles"] != float64(2) {
		t.Fatalf("got %d %v", code, body)
	}
	if _, err := os.Stat(filepath.Join(e.root, "beta", "F")); err == nil {
		t.Fatal("an oversized transfer wrote something")
	}
	e.h.limits = TreeLimits{MaxFiles: 100, MaxBytes: 3}
	code, body, _ = doTransfer(t, e.h, transferReq("copy", "alpha", "F", "beta", "F"), false, nil)
	if code != http.StatusRequestEntityTooLarge || body["bytes"] != float64(6) {
		t.Fatalf("byte limit: %d %v", code, body)
	}
}

// Case 12: an empty folder (and an empty folder inside one) transfers.
func TestTransfer_EmptyFolders(t *testing.T) {
	e := newTEnv(t)
	os.MkdirAll(filepath.Join(e.root, "alpha", "Empty"), 0o755)
	os.MkdirAll(filepath.Join(e.root, "alpha", "F", "hollow"), 0o755)
	e.put(t, "alpha", "F/a.md", "a\n")
	for _, c := range []struct{ from, to string }{{"Empty", "Empty"}, {"F", "F"}} {
		if code, body, _ := doTransfer(t, e.h, transferReq("move", "alpha", c.from, "beta", c.to), false, nil); code != http.StatusOK {
			t.Fatalf("%s: %d %v", c.from, code, body)
		}
	}
	for _, d := range []string{"Empty", "F/hollow"} {
		if fi, err := os.Stat(filepath.Join(e.root, "beta", d)); err != nil || !fi.IsDir() {
			t.Fatalf("empty folder %s did not arrive", d)
		}
	}
}

// Symlinks and nested reserved dirs are refused, not silently dropped (a move
// would delete them with the source).
func TestTransfer_RefusesSymlinksAndNestedReserved(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "F/a.md", "a\n")
	if err := os.Symlink(filepath.Join(e.root, "beta"), filepath.Join(e.root, "alpha", "F", "link")); err != nil {
		t.Skip("symlinks unavailable")
	}
	code, body, _ := doTransfer(t, e.h, transferReq("move", "alpha", "F", "beta", "F"), false, nil)
	if code != http.StatusBadRequest || body["error"] != "symlink" || body["path"] != "F/link" {
		t.Fatalf("symlink: %d %v", code, body)
	}
	e.put(t, "alpha", "G/.git/config", "[remote]\n")
	code, body, _ = doTransfer(t, e.h, transferReq("copy", "alpha", "G", "beta", "G"), false, nil)
	if code != http.StatusBadRequest || body["error"] != "reserved" {
		t.Fatalf("nested .git: %d %v", code, body)
	}
}

// Case 17: a dry run answers exactly what the real call would, and writes nothing.
func TestTransfer_DryRunMatchesRealCall(t *testing.T) {
	scenarios := []struct {
		name  string
		setup func(e *tenv)
		req   map[string]any
	}{
		{"ok copy", func(e *tenv) { e.put(t, "alpha", "F/a.md", "a\n") }, transferReq("copy", "alpha", "F", "beta", "F")},
		{"ok move", func(e *tenv) { e.put(t, "alpha", "x.md", "x\n") }, transferReq("move", "alpha", "x.md", "beta", "y.md")},
		{"collision", func(e *tenv) { e.put(t, "alpha", "x.md", "x\n"); e.put(t, "beta", "x.md", "b\n") }, transferReq("copy", "alpha", "x.md", "beta", "x.md")},
		{"missing", func(e *tenv) {}, transferReq("copy", "alpha", "nope.md", "beta", "x.md")},
		{"too large", func(e *tenv) {
			e.h.limits = TreeLimits{MaxFiles: 1, MaxBytes: 100}
			e.put(t, "alpha", "F/a.md", "a\n")
			e.put(t, "alpha", "F/b.md", "b\n")
		}, transferReq("copy", "alpha", "F", "beta", "F")},
		{"nesting", func(e *tenv) { e.put(t, "alpha", "F/a.md", "a\n") }, transferReq("copy", "alpha", "F", "alpha", "F/G")},
	}
	for _, s := range scenarios {
		dry := newTEnv(t)
		real := newTEnv(t)
		s.setup(dry)
		s.setup(real)
		before := dry.snapshot(t)
		dc, _, dbody := doTransfer(t, dry.h, s.req, true, nil)
		rc, _, rbody := doTransfer(t, real.h, s.req, false, nil)
		if dc != rc || dbody != rbody {
			t.Errorf("%s: dry %d %s, real %d %s", s.name, dc, dbody, rc, rbody)
		}
		if !reflect.DeepEqual(before, dry.snapshot(t)) {
			t.Errorf("%s: the dry run changed the disk", s.name)
		}
		if len(dry.changed) != 0 {
			t.Errorf("%s: the dry run reported changes", s.name)
		}
	}
}

// Chat notes and drawings need no special case: their copies are still a
// chat and a drawing.
func TestTransfer_ChatAndDrawingSurviveCopy(t *testing.T) {
	e := newTEnv(t)
	chat := "---\nmdnest-chat: true\n---\n\n#### ahsan · 2026-10-03T10:00:00Z\nhello\n"
	drawing := "---\nexcalidraw-plugin: parsed\n---\n\n## Text Elements\nbox\n\n## Drawing\n```json\n{\"type\":\"excalidraw\",\"elements\":[]}\n```\n"
	e.put(t, "alpha", "Chats/team.md", marked(chat, idA))
	e.put(t, "alpha", "Sketch.excalidraw.md", marked(drawing, idB))
	for _, c := range []struct{ from, to string }{{"Chats/team.md", "Chats/team.md"}, {"Sketch.excalidraw.md", "Sketch.excalidraw.md"}} {
		if code, body, _ := doTransfer(t, e.h, transferReq("copy", "alpha", c.from, "beta", c.to), false, nil); code != http.StatusOK {
			t.Fatalf("%s: %d %v", c.from, code, body)
		}
	}
	got, _ := e.read(t, "beta", "Chats/team.md")
	if !IsChatNote(got) {
		t.Fatal("the copied chat is no longer a chat")
	}
	if doc := ParseChat(got); !doc.IsChat || len(doc.Messages) != 1 || !strings.Contains(doc.Messages[0].Text, "hello") {
		t.Fatalf("the copied chat lost its message: %+v", doc)
	}
	d, _ := e.read(t, "beta", "Sketch.excalidraw.md")
	_, body := ExtractNoteID(d)
	_, origBody := ExtractNoteID(marked(drawing, idB))
	if body != origBody {
		t.Fatalf("the copied drawing changed:\n%q\n%q", body, origBody)
	}
}

// Binary attachments are copied byte for byte.
func TestTransfer_BinaryBytesIntact(t *testing.T) {
	e := newTEnv(t)
	bin := string([]byte{0x89, 'P', 'N', 'G', 0, 1, 2, 0xff, '\n', 0})
	e.put(t, "alpha", "F/pic.png", bin)
	if code, _, _ := doTransfer(t, e.h, transferReq("move", "alpha", "F", "beta", "F"), false, nil); code != http.StatusOK {
		t.Fatalf("move: %d", code)
	}
	if got, _ := e.read(t, "beta", "F/pic.png"); got != bin {
		t.Fatalf("binary changed: %q", got)
	}
}

// annotatingStore records Annotate calls (the git backend's commit notes).
type annotatingStore struct {
	storage.Storage
	mu    sync.Mutex
	lines map[string][]string
}

func (a *annotatingStore) Annotate(ns, line string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.lines == nil {
		a.lines = map[string][]string{}
	}
	a.lines[ns] = append(a.lines[ns], line)
}

// Case 10: each side's commit names the other side.
func TestTransfer_AnnotatesBothSides(t *testing.T) {
	root := t.TempDir()
	for _, ns := range []string{"alpha", "beta"} {
		os.MkdirAll(filepath.Join(root, ns), 0o755)
	}
	local, _ := storage.NewLocalStorage(root)
	as := &annotatingStore{Storage: local}
	e := newTEnvWith(t, root, as)
	e.put(t, "alpha", "Notes/x.md", "x\n")
	if code, _, _ := doTransfer(t, e.h, transferReq("move", "alpha", "Notes/x.md", "beta", "Project/x.md"), false, nil); code != http.StatusOK {
		t.Fatalf("move: %d", code)
	}
	want := map[string][]string{
		"alpha": {"moved to beta:Project/x.md"},
		"beta":  {"moved from alpha:Notes/x.md"},
	}
	if !reflect.DeepEqual(as.lines, want) {
		t.Fatalf("annotations = %v, want %v", as.lines, want)
	}
	as.lines = nil
	if code, _, _ := doTransfer(t, e.h, transferReq("copy", "beta", "Project/x.md", "alpha", "Back/x.md"), false, nil); code != http.StatusOK {
		t.Fatalf("copy: %d", code)
	}
	if !reflect.DeepEqual(as.lines, map[string][]string{"alpha": {"copied from beta:Project/x.md"}}) {
		t.Fatalf("copy annotations = %v", as.lines)
	}
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// On the git backend a path that held a note before gets that note's old
// marker back when it is recreated. A moved note landing there must take its
// comments to the ID it actually carries, or they would be orphaned.
func TestTransfer_GitBackendCommentsFollowLandedID(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	for _, ns := range []string{"alpha", "beta"} {
		os.MkdirAll(filepath.Join(root, ns), 0o755)
	}
	old := "dddddddd-4444-4444-8444-444444444444"
	betaDir := filepath.Join(root, "beta")
	os.WriteFile(filepath.Join(betaDir, "x.md"), []byte(marked("old\n", old)), 0o644)
	gitIn(t, betaDir, "init", "-q")
	gitIn(t, betaDir, "add", "-A")
	gitIn(t, betaDir, "commit", "-qm", "old note")
	os.Remove(filepath.Join(betaDir, "x.md"))
	gitIn(t, betaDir, "commit", "-qam", "delete it")

	gs, err := storage.NewGitStorage(root, storage.NoopCommitter{})
	if err != nil {
		t.Fatal(err)
	}
	e := newTEnvWith(t, root, gs)
	e.put(t, "alpha", "x.md", marked("new\n", idA))
	e.put(t, "alpha", ".mdnest/comments/"+idA+".jsonl", `{"id":"c"}`+"\n")
	if code, body, _ := doTransfer(t, e.h, transferReq("move", "alpha", "x.md", "beta", "x.md"), false, nil); code != http.StatusOK {
		t.Fatalf("move: %d %v", code, body)
	}
	got, _ := e.read(t, "beta", "x.md")
	landed := noteID(t, got)
	if landed == "" {
		t.Fatal("moved note has no id")
	}
	if _, ok := e.read(t, "beta", ".mdnest/comments/"+landed+".jsonl"); !ok {
		t.Fatalf("comments not filed under the landed id %s", landed)
	}
	if _, ok := e.read(t, "alpha", ".mdnest/comments/"+idA+".jsonl"); ok {
		t.Fatal("source sidecar survived the move")
	}
}

// proxyRecorder stands in for the writer on an app replica.
type proxyRecorder struct{ hits int }

func (p *proxyRecorder) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	p.hits++
	w.WriteHeader(http.StatusTeapot)
}

// On MDNEST_ROLE=app both endpoints go to the writer, which owns the tree.
func TestTransferAndDownload_ProxyToWriter(t *testing.T) {
	e := newTEnv(t)
	p := &proxyRecorder{}
	e.h.SetWriterProxy(p)
	if code, _, _ := doTransfer(t, e.h, transferReq("copy", "alpha", "x", "beta", "x"), false, nil); code != http.StatusTeapot {
		t.Fatalf("transfer not proxied: %d", code)
	}
	d := NewDownloadHandler(e.store, DefaultTreeLimits, 2)
	d.SetWriterProxy(p)
	w := httptest.NewRecorder()
	d.HandleDownload(w, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=x", nil))
	if w.Code != http.StatusTeapot || p.hits != 2 {
		t.Fatalf("download not proxied: %d hits=%d", w.Code, p.hits)
	}
}
