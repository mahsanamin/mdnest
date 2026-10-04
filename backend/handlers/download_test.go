package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

func download(h *DownloadHandler, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.HandleDownload(w, r)
	return w
}

func zipNames(t *testing.T, body []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
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

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Case 4 and 12: the zip keeps the hierarchy from the folder's own name,
// includes hidden files and empty folders, and excludes .git, .mdnest and
// symlinks.
func TestDownload_ZipShape(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "Proj/a.md", "a\n")
	e.put(t, "alpha", "Proj/sub/b.md", "b\n")
	e.put(t, "alpha", "Proj/.hidden", "h")
	e.put(t, "alpha", "Proj/.git/config", "[remote]\n")
	e.put(t, "alpha", "Proj/.mdnest/board.json", "{}")
	os.MkdirAll(filepath.Join(e.root, "alpha", "Proj", "empty"), 0o755)
	if err := os.Symlink("/etc/passwd", filepath.Join(e.root, "alpha", "Proj", "pw")); err != nil {
		t.Skip("symlinks unavailable")
	}
	os.Symlink(filepath.Join(e.root, "beta"), filepath.Join(e.root, "alpha", "Proj", "dirlink"))

	h := NewDownloadHandler(e.store, DefaultTreeLimits, 2)
	w := download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=Proj", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("got %d %s", w.Code, w.Body.String())
	}
	if cd := w.Header().Get("Content-Disposition"); cd != `attachment; filename="Proj.zip"` {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	got := zipNames(t, w.Body.Bytes())
	want := []string{"Proj/", "Proj/.hidden", "Proj/a.md", "Proj/empty/", "Proj/sub/", "Proj/sub/b.md"}
	if !reflect.DeepEqual(sortedKeys(got), want) {
		t.Fatalf("zip entries = %v, want %v", sortedKeys(got), want)
	}
	if got["Proj/sub/b.md"] != "b\n" {
		t.Fatalf("content = %q", got["Proj/sub/b.md"])
	}

	// An empty folder on its own downloads as a zip holding just itself.
	os.MkdirAll(filepath.Join(e.root, "alpha", "Bare"), 0o755)
	w = download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=Bare", nil))
	if w.Code != http.StatusOK || !reflect.DeepEqual(sortedKeys(zipNames(t, w.Body.Bytes())), []string{"Bare/"}) {
		t.Fatalf("empty folder: %d", w.Code)
	}

	// The namespace root excludes its own .git and .mdnest the same way.
	e.put(t, "alpha", ".mdnest/comments/x.jsonl", "{}")
	e.put(t, "alpha", ".git/HEAD", "ref")
	w = download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha", nil))
	for name := range zipNames(t, w.Body.Bytes()) {
		if strings.Contains(name, ".git/") || strings.Contains(name, ".mdnest/") || !strings.HasPrefix(name, "alpha/") {
			t.Fatalf("root zip entry %q", name)
		}
	}
}

func TestDownload_FileAndErrors(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "Notes/x.md", "hello\n")
	h := NewDownloadHandler(e.store, DefaultTreeLimits, 2)
	w := download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=Notes/x.md", nil))
	if w.Code != http.StatusOK || w.Body.String() != "hello\n" || w.Header().Get("Content-Disposition") != `attachment; filename="x.md"` {
		t.Fatalf("file: %d %q %q", w.Code, w.Body.String(), w.Header().Get("Content-Disposition"))
	}
	for url, code := range map[string]int{
		"/api/download?ns=alpha&path=nope.md":     http.StatusNotFound,
		"/api/download?ns=alpha&path=../beta":     http.StatusBadRequest,
		"/api/download?ns=alpha&path=.git/config": http.StatusBadRequest,
		"/api/download?ns=alpha&path=.mdnest":     http.StatusBadRequest,
		"/api/download?ns=gamma&path=x":           http.StatusNotFound,
		"/api/download?ns=..%2Fetc&path=passwd":   http.StatusBadRequest,
	} {
		if w := download(h, httptest.NewRequest(http.MethodGet, url, nil)); w.Code != code {
			t.Errorf("%s: got %d, want %d", url, w.Code, code)
		}
	}
}

// Case 9 (download half): the route's RequireRead sees the cleaned path, so
// a /Shared grant cannot zip /Private, and a traversal is refused.
func TestDownload_PathScopedRead(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "Shared/a.md", "a\n")
	e.put(t, "alpha", "Private/p.md", "p\n")
	pc := middleware.NewPermissionChecker(&pathGrants{grants: [][3]string{{"alpha", "/Shared", "read"}}}, fakeNsAdminStore{}, nil)
	h := pc.RequireRead(http.HandlerFunc(NewDownloadHandler(e.store, DefaultTreeLimits, 2).HandleDownload))
	user := &middleware.UserContext{ID: 1}
	for url, code := range map[string]int{
		"/api/download?ns=alpha&path=Shared":                 http.StatusOK,
		"/api/download?ns=alpha&path=Private":                http.StatusForbidden,
		"/api/download?ns=alpha&path=Shared/../Private":      http.StatusForbidden,
		"/api/download?ns=alpha":                             http.StatusForbidden,
		"/api/download?ns=alpha&path=Shared/../Private/p.md": http.StatusForbidden,
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, middleware.WithUser(httptest.NewRequest(http.MethodGet, url, nil), user))
		if w.Code != code {
			t.Errorf("%s: got %d, want %d", url, w.Code, code)
		}
	}
}

// Case 5 (download half): an oversized folder is a JSON 413 before any byte
// of zip, and takes no slot.
func TestDownload_TooLarge(t *testing.T) {
	e := newTEnv(t)
	for _, n := range []string{"a", "b", "c"} {
		e.put(t, "alpha", "F/"+n+".md", strings.Repeat(n, 10))
	}
	h := NewDownloadHandler(e.store, TreeLimits{MaxFiles: 2, MaxBytes: 1 << 20}, 2)
	w := download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=F", nil))
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != http.StatusRequestEntityTooLarge || body["error"] != "too_large" || body["files"] != float64(3) ||
		body["bytes"] != float64(30) || body["maxFiles"] != float64(2) || body["maxBytes"] != float64(1<<20) {
		t.Fatalf("got %d %v", w.Code, body)
	}
	if h.slots.inUse() != 0 {
		t.Fatal("a refused download holds a slot")
	}
}

// Case 11: any name yields a header that cannot break out, with an ASCII
// fallback and an RFC 5987 form for non-ASCII names.
func TestContentDisposition(t *testing.T) {
	cases := map[string]string{
		"notes.md":         `attachment; filename="notes.md"`,
		"ملاحظات.md":       `attachment; filename="_______.md"; filename*=UTF-8''%D9%85%D9%84%D8%A7%D8%AD%D8%B8%D8%A7%D8%AA.md`,
		`a"b\c.md`:         `attachment; filename="a_b_c.md"; filename*=UTF-8''a%22b%5Cc.md`,
		"x\r\nSet-Cookie:": `attachment; filename="x__Set-Cookie:"; filename*=UTF-8''x%0D%0ASet-Cookie%3A`,
		"😀.zip":            `attachment; filename="_.zip"; filename*=UTF-8''%F0%9F%98%80.zip`,
		"semi;colon.md":    `attachment; filename="semi;colon.md"`,
		"日本":               `attachment; filename="download"; filename*=UTF-8''%E6%97%A5%E6%9C%AC`,
	}
	for in, want := range cases {
		got := contentDisposition(in)
		if got != want {
			t.Errorf("contentDisposition(%q) =\n %s\nwant\n %s", in, got, want)
		}
		if strings.ContainsAny(got, "\r\n") {
			t.Errorf("header for %q contains a line break", in)
		}
	}
	// And through the handler, for a real non-ASCII file.
	e := newTEnv(t)
	e.put(t, "alpha", "ملاحظات.md", "x")
	w := download(NewDownloadHandler(e.store, DefaultTreeLimits, 2),
		httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=%D9%85%D9%84%D8%A7%D8%AD%D8%B8%D8%A7%D8%AA.md", nil))
	if w.Header().Get("Content-Disposition") != cases["ملاحظات.md"] {
		t.Fatalf("handler header = %q", w.Header().Get("Content-Disposition"))
	}
}

// The slots: one per user, a global cap, released exactly once.
func TestDownloadSlots(t *testing.T) {
	s := newDownloadSlots(2)
	r1, err := s.acquire("u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.acquire("u1"); err != errBusy {
		t.Fatal("the same user got a second slot")
	}
	r2, err := s.acquire("u2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.acquire("u3"); err != errBusy {
		t.Fatal("the global cap was exceeded")
	}
	r1()
	r1() // idempotent
	if s.inUse() != 1 {
		t.Fatalf("inUse = %d after one release", s.inUse())
	}
	r2()
	if s.inUse() != 0 {
		t.Fatal("slots leaked")
	}

	// Two API tokens of one user are one user; single mode is one key.
	a := middleware.WithUser(httptest.NewRequest(http.MethodGet, "/", nil), &middleware.UserContext{ID: 7, Username: "token-a"})
	b := middleware.WithUser(httptest.NewRequest(http.MethodGet, "/", nil), &middleware.UserContext{ID: 7, Username: "token-b"})
	if slotKey(a) != slotKey(b) {
		t.Fatal("two tokens of one user got different slot keys")
	}
	if slotKey(httptest.NewRequest(http.MethodGet, "/", nil)) != slotKey(httptest.NewRequest(http.MethodGet, "/", nil)) {
		t.Fatal("single mode is not one user")
	}
}

// A second zip from the same user while one streams is a 429 with Retry-After.
func TestDownload_BusyIs429(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", "F/a.md", "a")
	h := NewDownloadHandler(e.store, DefaultTreeLimits, 2)
	release, _ := h.slots.acquire("single")
	defer release()
	w := download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=F", nil))
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" || !strings.Contains(w.Body.String(), `"busy"`) {
		t.Fatalf("got %d %q", w.Code, w.Body.String())
	}
	// A single file is not a zip and is not slot-limited.
	e.put(t, "alpha", "x.md", "x")
	if w := download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=x.md", nil)); w.Code != http.StatusOK {
		t.Fatalf("file download while busy: %d", w.Code)
	}
}

// countingStore counts Opens and cancels the request after the first one.
type countingStore struct {
	storage.Storage
	opens  atomic.Int32
	cancel context.CancelFunc
}

func (c *countingStore) Open(ctx context.Context, ns, rel string) (io.ReadCloser, error) {
	if c.opens.Add(1) == 1 {
		c.cancel()
	}
	return c.Storage.Open(ctx, ns, rel)
}

// Case 14: cancelling a zip download stops the walk and compression promptly
// and releases both slots.
func TestDownload_CancelStopsAndReleases(t *testing.T) {
	e := newTEnv(t)
	for i := 0; i < 50; i++ {
		e.put(t, "alpha", "F/n"+string(rune('a'+i%26))+string(rune('a'+i/26))+".md", strings.Repeat("x", 4096))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cs := &countingStore{Storage: e.store, cancel: cancel}
	h := NewDownloadHandler(cs, DefaultTreeLimits, 1)
	done := make(chan struct{})
	go func() {
		download(h, httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=F", nil).WithContext(ctx))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the download did not stop after cancellation")
	}
	if n := cs.opens.Load(); n == 0 {
		t.Fatal("the download never started, so cancellation was not exercised")
	} else if n > 2 {
		t.Fatalf("kept reading after cancel: %d of 50 files opened", n)
	}
	if h.slots.inUse() != 0 {
		t.Fatal("a cancelled download kept its slot")
	}
	// Both slots really are free: the same user can start again at once.
	if w := download(NewDownloadHandler(e.store, DefaultTreeLimits, 1), httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=F", nil)); w.Code != http.StatusOK {
		t.Fatalf("download after cancel: %d", w.Code)
	}
	r, err := h.slots.acquire("single")
	if err != nil {
		t.Fatal("the user's slot was not released")
	}
	r()
}

// Case 18: ?detail=1 reports canWrite exactly as CheckWrite at the root; the
// plain list is unchanged.
func TestNamespaces_Detail(t *testing.T) {
	e := newTEnv(t)
	os.MkdirAll(filepath.Join(e.root, "gamma"), 0o755)
	grants := &pathGrants{grants: [][3]string{
		{"alpha", "/", "write"},
		{"beta", "/", "read"},
		{"gamma", "/Sub", "write"},
	}}
	pc := middleware.NewPermissionChecker(grants, fakeNsAdminStore{}, nil)
	h := NewNamespaceHandler(e.store, pc, nil)
	user := &middleware.UserContext{ID: 1}

	w := httptest.NewRecorder()
	h.ListNamespaces(w, middleware.WithUser(httptest.NewRequest(http.MethodGet, "/api/namespaces", nil), user))
	if strings.TrimSpace(w.Body.String()) != `["alpha","beta","gamma"]` {
		t.Fatalf("plain list changed: %s", w.Body.String())
	}

	w = httptest.NewRecorder()
	req := middleware.WithUser(httptest.NewRequest(http.MethodGet, "/api/namespaces?detail=1", nil), user)
	h.ListNamespaces(w, req)
	var got []NamespaceDetail
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("detail = %+v", got)
	}
	for _, d := range got {
		if d.CanWrite != pc.CheckWrite(req, d.Name, "/") || d.CanRead != pc.CheckRead(req, d.Name, "/") {
			t.Fatalf("%s: %+v disagrees with CheckRead/CheckWrite", d.Name, d)
		}
	}
	if got[0].CanWrite != true || got[1].CanWrite != false || got[2].CanWrite != false {
		t.Fatalf("detail = %+v", got)
	}

	// Single mode: everything, all true.
	w = httptest.NewRecorder()
	NewNamespaceHandler(e.store, nil, nil).ListNamespaces(w, httptest.NewRequest(http.MethodGet, "/api/namespaces?detail=1", nil))
	if !strings.Contains(w.Body.String(), `{"name":"beta","canRead":true,"canWrite":true}`) {
		t.Fatalf("single mode detail: %s", w.Body.String())
	}
}

// The walk stops once past a limit (a huge namespace is not walked in full
// just to be refused), and folders count toward an entry cap.
func TestPlanTree_StopsEarly(t *testing.T) {
	e := newTEnv(t)
	for i := 0; i < 50; i++ {
		e.put(t, "alpha", fmt.Sprintf("F/n%02d.md", i), "x")
	}
	for i := 0; i < 50; i++ {
		os.MkdirAll(filepath.Join(e.root, "alpha", "D", fmt.Sprintf("d%02d", i)), 0o755)
	}
	l := TreeLimits{MaxFiles: 5, MaxBytes: 1 << 20}
	cw := &countingWalk{Storage: e.store}
	p, err := planTree(context.Background(), cw, "alpha", "F", l)
	if err != nil || !p.partial || !p.tooLarge(l) || len(p.entries) > 10 {
		t.Fatalf("files: err=%v partial=%v entries=%d", err, p.partial, len(p.entries))
	}
	if cw.visits > 10 {
		t.Fatalf("the walk visited %d of 51 entries after passing a limit of 5", cw.visits)
	}
	l = TreeLimits{MaxFiles: 1, MaxBytes: 1 << 20} // entry cap = 1*4+1000
	p, _ = planTree(context.Background(), e.store, "alpha", "D", l)
	if p.partial {
		t.Fatal("51 folders tripped the entry cap meant for thousands")
	}
}

// A zip entry name never carries a backslash: Windows extractors read it as
// a separator, so a crafted name could unpack outside the folder.
func TestDownload_ZipNamesHaveNoBackslash(t *testing.T) {
	e := newTEnv(t)
	e.put(t, "alpha", `F/a\..\..\evil.bat`, "x")
	w := download(NewDownloadHandler(e.store, DefaultTreeLimits, 2), httptest.NewRequest(http.MethodGet, "/api/download?ns=alpha&path=F", nil))
	for name := range zipNames(t, w.Body.Bytes()) {
		if strings.Contains(name, `\`) {
			t.Fatalf("zip entry %q contains a backslash", name)
		}
	}
}

// countingWalk counts how many entries a Walk actually visits.
type countingWalk struct {
	storage.Storage
	visits int
}

func (c *countingWalk) Walk(ctx context.Context, ns, root string, fn storage.WalkFunc) error {
	return c.Storage.Walk(ctx, ns, root, func(rel string, info storage.FileInfo) error {
		c.visits++
		return fn(rel, info)
	})
}
