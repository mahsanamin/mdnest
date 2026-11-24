package handlers

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/middleware"
)

const pagesTestSecret = "pages-test-secret"

type tarEntry struct {
	name     string
	body     string
	typeflag byte
	link     string
}

func makeTar(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		tf := e.typeflag
		if tf == 0 {
			tf = tar.TypeReg
		}
		hdr := &tar.Header{Name: e.name, Mode: 0644, Typeflag: tf, Linkname: e.link}
		if tf == tar.TypeReg {
			hdr.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if tf == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	return buf.Bytes()
}

// pagesFixture: notes root with namespace "alpha", an empty PAGES_DIR beside
// it, and a static-mode handler with small limits.
func pagesFixture(t *testing.T, mutate ...func(*PagesConfig)) (*PagesHandler, string) {
	t.Helper()
	root := t.TempDir()
	notes := filepath.Join(root, "notes")
	os.MkdirAll(filepath.Join(notes, "alpha"), 0o755)
	pagesDir := filepath.Join(root, "pages")
	os.MkdirAll(pagesDir, 0o755)
	cfg := PagesConfig{
		Dir:            pagesDir,
		MaxBytes:       64 << 10,
		MaxFiles:       5,
		FrameAncestors: "https://notes.example.com",
		Secret:         []byte(pagesTestSecret),
		SingleUser:     "admin",
	}
	for _, m := range mutate {
		m(&cfg)
	}
	return NewPagesHandler(cfg, localStore(t, notes), nil), pagesDir
}

// handlePath turns a short test name into a handle path ("rep" becomes
// "rep.page.md"); a name that already ends in .page.md is used as it is.
func handlePath(name string) string {
	if strings.HasSuffix(name, PageHandleSuffix) {
		return name
	}
	return name + PageHandleSuffix
}

func publish(h *PagesHandler, ns, name, ct string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPut, "/api/pages?ns="+ns+"&path="+url.QueryEscape(handlePath(name)), bytes.NewReader(body))
	r.Header.Set("Content-Type", ct)
	w := httptest.NewRecorder()
	h.Handle(w, r)
	return w
}

func passURL(t *testing.T, h *PagesHandler, ns, name string) string {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/pages/pass?ns="+ns+"&path="+url.QueryEscape(handlePath(name)), nil)
	w := httptest.NewRecorder()
	h.HandlePass(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("pass: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		URL     string `json:"url"`
		Scripts bool   `json:"scripts"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	return resp.URL
}

// notesOf is the notes root of a pagesFixture.
func notesOf(pagesDir string) string { return filepath.Join(filepath.Dir(pagesDir), "notes") }

// idOf reads the page id from a handle on disk.
func idOf(t *testing.T, pagesDir, ns, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(notesOf(pagesDir), ns, handlePath(name)))
	if err != nil {
		t.Fatalf("handle %s: %v", name, err)
	}
	id, ok := ParsePageHandle(string(b))
	if !ok || !ValidPageID(id) {
		t.Fatalf("handle %s holds no valid id: %q", name, b)
	}
	return id
}

func view(h *PagesHandler, url string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, url, nil)
	w := httptest.NewRecorder()
	h.HandleStaticView(w, r)
	return w
}

func TestPages_PublishListViewText(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	page := makeTar(t,
		tarEntry{name: "./", typeflag: tar.TypeDir},
		tarEntry{name: "./index.html", body: `<html><head><title>Q3 report</title><style>.x{}</style></head><body><h1>Revenue</h1><p>grew by 12%</p><script>var secretCode=1</script><img src="img/chart.png"></body></html>`},
		tarEntry{name: "./img/", typeflag: tar.TypeDir},
		tarEntry{name: "./img/chart.png", body: "PNGDATA"},
		tarEntry{name: "./.DS_Store", body: "junk"},
	)
	if w := publish(h, "alpha", "ProjA/q3-report", "application/x-tar", page); w.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", w.Code, w.Body.String())
	}
	// The handle is a small note in the tree: front matter only, the page
	// files are not.
	hb, _ := os.ReadFile(filepath.Join(notesOf(pagesDir), "alpha", "ProjA", "q3-report.page.md"))
	for _, want := range []string{"---\npage: ", "\ntitle: \"Q3 report\"\n", "\nauthor: \"admin\"\n", "\npublished: ", "HTML page, open it in mdnest."} {
		if !strings.Contains(string(hb), want) {
			t.Fatalf("handle lacks %q:\n%s", want, hb)
		}
	}
	id := idOf(t, pagesDir, "alpha", "ProjA/q3-report")
	if len(id) < 26 {
		t.Fatalf("id %q is too short to be unguessable", id)
	}
	if entries, _ := os.ReadDir(filepath.Join(notesOf(pagesDir), "alpha", "ProjA")); len(entries) != 1 {
		t.Fatalf("only the handle belongs in the notes tree, found %d entries", len(entries))
	}

	// List: one row, title from <title>, author from MDNEST_USER in single mode.
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha", nil))
	var list struct{ Pages []PageMeta }
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Pages) != 1 || list.Pages[0].Title != "Q3 report" || list.Pages[0].Author != "admin" || list.Pages[0].Files != 2 || list.Pages[0].Path != "ProjA/q3-report.page.md" {
		t.Fatalf("list = %+v", list.Pages)
	}
	if list.Pages[0].Text != "" {
		t.Fatal("the list must not carry the page text")
	}
	if list.Pages[0].Description != "" {
		t.Fatalf("a page without a description meta has description %q", list.Pages[0].Description)
	}
	publish(h, "alpha", "ProjA/described", "text/html", []byte(`<title>D</title><meta name="description" content="A page about widgets"><p>x</p>`))
	w = httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha&q=widgets", nil))
	if !strings.Contains(w.Body.String(), `"description":"A page about widgets"`) || !strings.Contains(w.Body.String(), "described.page.md") {
		t.Fatalf("description in list and search: %s", w.Body.String())
	}
	os.Remove(filepath.Join(notesOf(pagesDir), "alpha", "ProjA", "described.page.md"))

	// Search runs on the stored text, never on script content.
	for q, want := range map[string]int{"revenue": 1, "grew 12%": 1, "secretCode": 0, "nothing-here": 0} {
		w := httptest.NewRecorder()
		h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha&q="+strings.ReplaceAll(q, " ", "+"), nil))
		var l struct{ Pages []PageMeta }
		json.Unmarshal(w.Body.Bytes(), &l)
		if len(l.Pages) != want {
			t.Errorf("q=%q: %d results, want %d", q, len(l.Pages), want)
		}
	}

	// TSV for the CLI: one line per page, no tabs inside fields.
	w = httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha&format=tsv", nil))
	if lines := strings.Split(strings.TrimSpace(w.Body.String()), "\n"); len(lines) != 1 || len(strings.Split(lines[0], "\t")) != 6 || !strings.HasPrefix(lines[0], "ProjA/q3-report.page.md\tQ3 report\tadmin\t") {
		t.Fatalf("tsv = %q", w.Body.String())
	}

	// Text: extracted once, without HTML or script.
	w = httptest.NewRecorder()
	h.HandleText(w, httptest.NewRequest(http.MethodGet, "/api/pages/text?ns=alpha&path=ProjA/q3-report.page.md", nil))
	var m PageMeta
	json.Unmarshal(w.Body.Bytes(), &m)
	if m.Text != "Revenue grew by 12%" {
		t.Fatalf("text = %q", m.Text)
	}

	// View through a pass: index, then a file in a subfolder.
	u := passURL(t, h, "alpha", "ProjA/q3-report")
	if !strings.HasPrefix(u, "/api/pages/view/") || !strings.HasSuffix(u, "/") {
		t.Fatalf("static pass url = %q", u)
	}
	w = view(h, u)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<h1>Revenue</h1>") {
		t.Fatalf("index: %d %s", w.Code, w.Body.String())
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.HasSuffix(csp, "; sandbox") || strings.Contains(csp, "allow-scripts") || strings.Contains(csp, "script-src") {
		t.Fatalf("static CSP must turn scripts off: %q", csp)
	}
	if !strings.Contains(csp, "frame-ancestors https://notes.example.com") {
		t.Fatalf("static CSP must name the frontend as the only framer: %q", csp)
	}
	for k, v := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"Cache-Control":          "private, no-store",
		"Content-Type":           "text/html; charset=utf-8",
	} {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	// mdnest's own origin never allows cross-origin reads of page files:
	// that header belongs to the pages listener alone. Served through the
	// main server's CORS middleware, as in main.go.
	mw := httptest.NewRecorder()
	middleware.NewCORSMiddleware("https://notes.example.com").Wrap(http.HandlerFunc(h.HandleStaticView)).ServeHTTP(mw, httptest.NewRequest(http.MethodGet, u, nil))
	if mw.Code != http.StatusOK || mw.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("static view through the CORS middleware: %d, Access-Control-Allow-Origin %q", mw.Code, mw.Header().Get("Access-Control-Allow-Origin"))
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("static view sends Access-Control-Allow-Origin %q on the main origin", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("static view sends Access-Control-Allow-Credentials %q", got)
	}
	if w = view(h, u+"img/chart.png"); w.Code != http.StatusOK || w.Body.String() != "PNGDATA" {
		t.Fatalf("image: %d %q", w.Code, w.Body.String())
	}
	// The hidden file was never stored.
	if w = view(h, u+".DS_Store"); w.Code != http.StatusNotFound {
		t.Fatalf(".DS_Store: %d", w.Code)
	}
	// Without the trailing slash relative links would break: redirect.
	if w = view(h, strings.TrimSuffix(u, "/")); w.Code != http.StatusFound || w.Header().Get("Location") != u {
		t.Fatalf("no-slash: %d %q", w.Code, w.Header().Get("Location"))
	}
}

func TestPages_SingleHTMLFileAndRepublishReplaces(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	page := makeTar(t, tarEntry{name: "index.html", body: "<p>one</p>"}, tarEntry{name: "old.css", body: "x"})
	if w := publish(h, "alpha", "rep", "application/x-tar", page); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	first := idOf(t, pagesDir, "alpha", "rep")
	if w := publish(h, "alpha", "rep", "text/html; charset=utf-8", []byte("<title>Two</title><p>two</p>")); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	id := idOf(t, pagesDir, "alpha", "rep")
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", id, "old.css")); !os.IsNotExist(err) {
		t.Fatal("republishing must replace the page, not merge into it")
	}
	b, _ := os.ReadFile(filepath.Join(pagesDir, "alpha", id, "index.html"))
	if string(b) != "<title>Two</title><p>two</p>" {
		t.Fatalf("index = %q", b)
	}
	// Every publish is a new id; the old page goes once nothing names it.
	if id == first {
		t.Fatal("republishing kept the id")
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", first)); !os.IsNotExist(err) {
		t.Fatal("the old page was kept although no handle names it")
	}
	// No temp or old folders left behind.
	entries, _ := os.ReadDir(filepath.Join(pagesDir, "alpha"))
	for _, e := range entries {
		if e.Name() != id && e.Name() != pagesMetaDir {
			t.Errorf("left behind: %s", e.Name())
		}
	}
	// Delete removes files and details.
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodDelete, "/api/pages?ns=alpha&path=rep.page.md", nil))
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", id)); !os.IsNotExist(err) {
		t.Fatal("page folder still there")
	}
	if _, err := os.Stat(filepath.Join(notesOf(pagesDir), "alpha", "rep.page.md")); !os.IsNotExist(err) {
		t.Fatal("handle still there")
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", pagesMetaDir, id+".json")); !os.IsNotExist(err) {
		t.Fatal("page details still there")
	}
}

func TestPages_HandlePathRules(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	put := func(raw string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPut, "/api/pages?ns=alpha&path="+url.QueryEscape(raw), strings.NewReader("<p>x</p>"))
		r.Header.Set("Content-Type", "text/html")
		w := httptest.NewRecorder()
		h.Handle(w, r)
		return w
	}
	for _, raw := range []string{"", "x.md", "x.html", ".page.md", "dir/.page.md", "../x.page.md", "/x.page.md", ".hidden/x.page.md", "a/.git/x.page.md", ".mdnest/x.page.md"} {
		if w := put(raw); w.Code != http.StatusBadRequest {
			t.Errorf("publish to %q: %d %s", raw, w.Code, w.Body.String())
		}
	}
	// A note that happens to end in .page.md but is not a handle is never
	// overwritten.
	note := filepath.Join(notesOf(pagesDir), "alpha", "mine.page.md")
	os.WriteFile(note, []byte("# My own note\n"), 0o644)
	if w := put("mine.page.md"); w.Code != http.StatusConflict {
		t.Fatalf("publish over a plain note: %d %s", w.Code, w.Body.String())
	}
	if b, _ := os.ReadFile(note); string(b) != "# My own note\n" {
		t.Fatalf("the plain note was changed: %q", b)
	}
	// Nothing was stored for any refused publish.
	entries, _ := os.ReadDir(filepath.Join(pagesDir, "alpha"))
	for _, e := range entries {
		if e.Name() != pagesMetaDir {
			t.Errorf("refused publish left %s", e.Name())
		}
	}
	for _, id := range []string{"", "short", "UPPERCASEUPPERCASEUPPERCASE1", "../aaaaaaaaaaaaaaaaaaaaaaaaaa", ".aaaaaaaaaaaaaaaaaaaaaaaaaa", strings.Repeat("a", 65)} {
		if ValidPageID(id) {
			t.Errorf("ValidPageID(%q) = true", id)
		}
	}
	if id := newPageID(); !ValidPageID(id) || len(id) != 32 || id == newPageID() {
		t.Errorf("newPageID = %q", id)
	}
}

func TestPages_HandleWithMissingPage(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	notes := notesOf(pagesDir)
	call := func(f func(http.ResponseWriter, *http.Request), method, p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		f(w, httptest.NewRequest(method, p, nil))
		return w
	}
	// A hand-edited handle naming an id nobody published: 404, files missing.
	os.WriteFile(filepath.Join(notes, "alpha", "ghost.page.md"), []byte("---\npage: "+newPageID()+"\n---\n"), 0o644)
	for _, w := range []*httptest.ResponseRecorder{
		call(h.HandlePass, http.MethodPost, "/api/pages/pass?ns=alpha&path=ghost.page.md"),
		call(h.HandleText, http.MethodGet, "/api/pages/text?ns=alpha&path=ghost.page.md"),
		call(h.HandleArchive, http.MethodGet, "/api/pages/archive?ns=alpha&path=ghost.page.md"),
	} {
		if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), errPageFilesMissing) {
			t.Fatalf("ghost handle: %d %s", w.Code, w.Body.String())
		}
	}
	// A handle copied by hand from another namespace: the id exists there,
	// not here, and the message says so. Nothing crosses the boundary.
	os.MkdirAll(filepath.Join(notes, "beta"), 0o755)
	publish(h, "beta", "theirs", "text/html", []byte("<p>BETA-ONLY</p>"))
	b, _ := os.ReadFile(filepath.Join(notes, "beta", "theirs.page.md"))
	os.WriteFile(filepath.Join(notes, "alpha", "copied.page.md"), b, 0o644)
	w := call(h.HandlePass, http.MethodPost, "/api/pages/pass?ns=alpha&path=copied.page.md")
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), errPageOtherNamespace) {
		t.Fatalf("copied handle: %d %s", w.Code, w.Body.String())
	}
	// Listed, marked missing, so it can be found and fixed.
	w = call(h.Handle, http.MethodGet, "/api/pages?ns=alpha")
	if !strings.Contains(w.Body.String(), `"path":"copied.page.md"`) || !strings.Contains(w.Body.String(), `"missing":true`) {
		t.Fatalf("list: %s", w.Body.String())
	}
	// A plain note is not a handle.
	os.WriteFile(filepath.Join(notes, "alpha", "plain.page.md"), []byte("# hi\n"), 0o644)
	if w := call(h.HandlePass, http.MethodPost, "/api/pages/pass?ns=alpha&path=plain.page.md"); w.Code != http.StatusBadRequest {
		t.Fatalf("plain note as a handle: %d", w.Code)
	}
}

func TestPages_DeleteHookAndUnlinked(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	notes := notesOf(pagesDir)
	noteDel := h.DeleteHook(http.HandlerFunc(NewNoteHandler(h.store).Handle))
	del := func(p string) int {
		w := httptest.NewRecorder()
		noteDel.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/note?ns=alpha&path="+url.QueryEscape(p), nil))
		return w.Code
	}
	stored := func(id string) bool { _, err := os.Stat(filepath.Join(pagesDir, "alpha", id)); return err == nil }

	// Two handles naming one page: deleting one keeps the page, deleting the
	// last one deletes it.
	publish(h, "alpha", "A/shared", "text/html", []byte("<p>S</p>"))
	id := idOf(t, pagesDir, "alpha", "A/shared")
	b, _ := os.ReadFile(filepath.Join(notes, "alpha", "A", "shared.page.md"))
	os.MkdirAll(filepath.Join(notes, "alpha", "B"), 0o755)
	os.WriteFile(filepath.Join(notes, "alpha", "B", "copy.page.md"), b, 0o644)
	if del("A/shared.page.md") != http.StatusOK || !stored(id) {
		t.Fatal("deleting one of two handles deleted the page")
	}
	if del("B/copy.page.md") != http.StatusOK || stored(id) {
		t.Fatal("deleting the last handle kept the page")
	}

	// A folder of handles: their pages go with it.
	publish(h, "alpha", "F/one", "text/html", []byte("<p>1</p>"))
	publish(h, "alpha", "F/sub/two", "text/html", []byte("<p>2</p>"))
	id1, id2 := idOf(t, pagesDir, "alpha", "F/one"), idOf(t, pagesDir, "alpha", "F/sub/two")
	if del("F") != http.StatusOK || stored(id1) || stored(id2) {
		t.Fatal("deleting a folder kept its pages")
	}

	// A failed delete deletes nothing.
	publish(h, "alpha", "keep", "text/html", []byte("<p>K</p>"))
	kid := idOf(t, pagesDir, "alpha", "keep")
	if del("nope.page.md") != http.StatusNotFound || !stored(kid) {
		t.Fatal("a failed delete touched a page")
	}

	// A handle removed behind mdnest's back (git-sync) leaves the page
	// unlinked: listed for root writers, never deleted on its own.
	os.Remove(filepath.Join(notes, "alpha", "keep.page.md"))
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha", nil))
	var list struct {
		Pages    []PageMeta
		Unlinked []PageMeta
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Unlinked) != 1 || list.Unlinked[0].ID != kid || !stored(kid) {
		t.Fatalf("unlinked = %+v", list.Unlinked)
	}
	w = httptest.NewRecorder()
	h.HandleUnlinked(w, httptest.NewRequest(http.MethodDelete, "/api/pages/unlinked?ns=alpha&id="+kid, nil))
	if w.Code != http.StatusOK || stored(kid) {
		t.Fatalf("delete unlinked: %d %s", w.Code, w.Body.String())
	}
	// An unlinked delete refuses a page a handle still names.
	publish(h, "alpha", "live", "text/html", []byte("<p>L</p>"))
	w = httptest.NewRecorder()
	h.HandleUnlinked(w, httptest.NewRequest(http.MethodDelete, "/api/pages/unlinked?ns=alpha&id="+idOf(t, pagesDir, "alpha", "live"), nil))
	if w.Code != http.StatusConflict {
		t.Fatalf("delete a linked page as unlinked: %d", w.Code)
	}
}

func TestPages_RepublishRotatesTheID(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	notes := notesOf(pagesDir)
	publish(h, "alpha", "A/page", "text/html", []byte("<p>v1</p>"))
	id1 := idOf(t, pagesDir, "alpha", "A/page")
	oldPass := passURL(t, h, "alpha", "A/page")
	b, _ := os.ReadFile(filepath.Join(notes, "alpha", "A", "page.page.md"))
	os.MkdirAll(filepath.Join(notes, "alpha", "B"), 0o755)
	os.WriteFile(filepath.Join(notes, "alpha", "B", "copy.page.md"), b, 0o644)

	// Single mode writes everywhere: both handles move to the new id and the
	// old page goes, with every pass made for it.
	publish(h, "alpha", "A/page", "text/html", []byte("<p>v2</p>"))
	id2 := idOf(t, pagesDir, "alpha", "A/page")
	if id2 == id1 || idOf(t, pagesDir, "alpha", "B/copy") != id2 {
		t.Fatalf("ids: first %s, then %s, copy %s", id1, id2, idOf(t, pagesDir, "alpha", "B/copy"))
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", id1)); !os.IsNotExist(err) {
		t.Fatal("the old page was kept although no handle names it")
	}
	if w := view(h, oldPass); w.Code != http.StatusForbidden {
		t.Fatalf("a pass for the old version: %d", w.Code)
	}
	if w := view(h, passURL(t, h, "alpha", "B/copy")); w.Body.String() != "<p>v2</p>" {
		t.Fatalf("the rewritten copy shows %q", w.Body.String())
	}
	// The rewritten handle keeps everything else it had.
	if nb, _ := os.ReadFile(filepath.Join(notes, "alpha", "B", "copy.page.md")); !strings.Contains(string(nb), "HTML page, open it in mdnest.") {
		t.Fatalf("rewritten copy: %q", nb)
	}
}

func TestPages_MovingAHandleKeepsThePage(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	publish(h, "alpha", "old/place", "text/html", []byte("<p>MOVED-OK</p>"))
	notes := notesOf(pagesDir)
	os.MkdirAll(filepath.Join(notes, "alpha", "new"), 0o755)
	if err := h.store.Rename(context.Background(), "alpha", "old/place.page.md", "new/renamed.page.md"); err != nil {
		t.Fatal(err)
	}
	if w := view(h, passURL(t, h, "alpha", "new/renamed")); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "MOVED-OK") {
		t.Fatalf("moved handle: %d %s", w.Code, w.Body.String())
	}
}

func TestPages_NamespaceMustExist(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	if w := publish(h, "nope", "x", "text/html", []byte("<p>x</p>")); w.Code != http.StatusNotFound {
		t.Fatalf("unknown namespace: %d", w.Code)
	}
	if w := publish(h, "..", "x", "text/html", []byte("<p>x</p>")); w.Code != http.StatusBadRequest {
		t.Fatalf("namespace ..: %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "nope")); !os.IsNotExist(err) {
		t.Fatal("pages must never create a namespace folder for an unknown namespace")
	}
}

func TestPages_TarIsPlainFilesOnly(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	index := tarEntry{name: "index.html", body: "<p>x</p>"}
	cases := map[string][]tarEntry{
		"dotdot":      {index, {name: "../escape.html", body: "x"}},
		"deep-dotdot": {index, {name: "a/../../escape.html", body: "x"}},
		"absolute":    {index, {name: "/etc/escape.html", body: "x"}},
		"git":         {index, {name: ".git/config", body: "x"}},
		"deep-git":    {index, {name: "a/.git/hooks/x", body: "y"}},
		"symlink":     {index, {name: "link", typeflag: tar.TypeSymlink, link: "/etc/passwd"}},
		"hardlink":    {index, {name: "hard", typeflag: tar.TypeLink, link: "index.html"}},
		"chardev":     {index, {name: "dev", typeflag: tar.TypeChar}},
		"blockdev":    {index, {name: "blk", typeflag: tar.TypeBlock}},
		"fifo":        {index, {name: "pipe", typeflag: tar.TypeFifo}},
		"duplicate":   {index, {name: "a.css", body: "1"}, {name: "./a.css", body: "2"}},
		"no-index":    {{name: "other.html", body: "x"}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			w := publish(h, "alpha", "p-"+name, "application/x-tar", makeTar(t, entries...))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d %s", w.Code, w.Body.String())
			}
			if _, err := os.Stat(filepath.Join(notesOf(pagesDir), "alpha", "p-"+name+PageHandleSuffix)); !os.IsNotExist(err) {
				t.Fatal("a refused page left a handle")
			}
			if entries, _ := os.ReadDir(filepath.Join(pagesDir, "alpha")); len(entries) > 1 {
				t.Fatalf("a refused page was stored: %d entries", len(entries))
			}
		})
	}
	// Nothing landed outside the namespace's pages folder.
	for _, p := range []string{filepath.Join(pagesDir, "escape.html"), filepath.Join(pagesDir, "alpha", "escape.html"), filepath.Join(filepath.Dir(pagesDir), "escape.html")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("escaped write: %s", p)
		}
	}
}

func TestPages_Limits(t *testing.T) {
	h, pagesDir := pagesFixture(t) // 64 KB, 5 files
	index := tarEntry{name: "index.html", body: "<p>x</p>"}

	big := strings.Repeat("a", 65<<10)
	if w := publish(h, "alpha", "big-html", "text/html", []byte(big)); w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "PAGES_MAX_MB") {
		t.Fatalf("big html: %d %s", w.Code, w.Body.String())
	}
	if w := publish(h, "alpha", "big-tar", "application/x-tar", makeTar(t, index, tarEntry{name: "a.bin", body: big})); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("big tar: %d %s", w.Code, w.Body.String())
	}
	many := []tarEntry{index}
	for i := 0; i < 5; i++ {
		many = append(many, tarEntry{name: "f" + string(rune('a'+i)) + ".txt", body: "x"})
	}
	if w := publish(h, "alpha", "many", "application/x-tar", makeTar(t, many...)); w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "PAGES_MAX_FILES") {
		t.Fatalf("too many files: %d %s", w.Code, w.Body.String())
	}

	// A gzip bomb: tiny on the wire, 200 MB inflated, with a header that lies
	// about its size. The decompressed bytes are counted, so it stops at the
	// limit instead of filling the disk.
	var raw bytes.Buffer
	tw := tar.NewWriter(&raw)
	tw.WriteHeader(&tar.Header{Name: "index.html", Mode: 0644, Size: 200 << 20, Typeflag: tar.TypeReg})
	zero := make([]byte, 1<<20)
	var gz bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	zw.Write(raw.Bytes())
	for i := 0; i < 200; i++ {
		zw.Write(zero)
	}
	zw.Close()
	if gz.Len() > 1<<20 {
		t.Fatalf("bomb is %d bytes on the wire, test is wrong", gz.Len())
	}
	start := time.Now()
	if w := publish(h, "alpha", "bomb", "application/gzip", gz.Bytes()); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("gzip bomb: %d %s", w.Code, w.Body.String())
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("gzip bomb took too long: limit not applied while inflating")
	}
	// Same bomb with an honest header but a small limit: stops while copying.
	if _, err := os.Stat(filepath.Join(notesOf(pagesDir), "alpha", "bomb.page.md")); !os.IsNotExist(err) {
		t.Fatal("bomb left a handle")
	}

	// An unknown content type is refused.
	if w := publish(h, "alpha", "zip", "application/zip", []byte("PK")); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("zip: %d", w.Code)
	}
}

// Folders count against PAGES_MAX_FILES too (finding F2): a tar of empty
// folder entries, or one deeply nested file, must not create folders
// without limit.
func TestPages_FolderCap(t *testing.T) {
	h, pagesDir := pagesFixture(t) // MaxFiles 5
	index := tarEntry{name: "index.html", body: "<p>x</p>"}

	dirsOnly := []tarEntry{index}
	for i := 0; i < 6; i++ {
		dirsOnly = append(dirsOnly, tarEntry{name: fmt.Sprintf("d%d/", i), typeflag: tar.TypeDir})
	}
	if w := publish(h, "alpha", "dirs", "application/x-tar", makeTar(t, dirsOnly...)); w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "folders") {
		t.Fatalf("6 folder entries with a cap of 5: %d %s", w.Code, w.Body.String())
	}
	deep := makeTar(t, index, tarEntry{name: "a/b/c/d/e/f/x.css", body: "p{}"})
	if w := publish(h, "alpha", "deep", "application/x-tar", deep); w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "folders") {
		t.Fatalf("one file six folders deep with a cap of 5: %d %s", w.Code, w.Body.String())
	}
	for _, name := range []string{"dirs", "deep"} {
		if _, err := os.Stat(filepath.Join(notesOf(pagesDir), "alpha", handlePath(name))); !os.IsNotExist(err) {
			t.Fatalf("%s: a refused upload left a handle", name)
		}
	}

	// Within the cap: folders named by entries and by file paths, shared
	// parents counted once.
	ok := makeTar(t, index, tarEntry{name: "css/", typeflag: tar.TypeDir}, tarEntry{name: "css/a.css", body: "p{}"},
		tarEntry{name: "img/icons/x.svg", body: "<svg/>"}, tarEntry{name: "img/y.svg", body: "<svg/>"})
	if w := publish(h, "alpha", "ok", "application/x-tar", ok); w.Code != http.StatusOK {
		t.Fatalf("three folders with a cap of 5: %d %s", w.Code, w.Body.String())
	}
}

func TestPages_PassRules(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	publish(h, "alpha", "one", "text/html", []byte("<p>ONE</p>"))
	publish(h, "alpha", "two", "text/html", []byte("<p>TWO</p>"))
	u := passURL(t, h, "alpha", "one")
	pass := strings.TrimSuffix(strings.TrimPrefix(u, "/api/pages/view/"), "/")

	// A pass is never a login.
	if _, err := middleware.ParseSessionToken([]byte(pagesTestSecret), pass); err == nil {
		t.Fatal("a page pass was accepted as a session token")
	}
	// A session token is never a pass.
	session, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "admin", "ns": "alpha", "id": idOf(t, pagesDir, "alpha", "one"), "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(pagesTestSecret))
	if w := view(h, "/api/pages/view/"+session+"/"); w.Code != http.StatusForbidden {
		t.Fatalf("session token as pass: %d", w.Code)
	}

	// The pass names one page; there is no way to name another through it.
	if w := view(h, u+"../two/index.html"); strings.Contains(w.Body.String(), "TWO") {
		t.Fatal("pass for one served page two")
	}

	var c0 pageClaims
	jwt.ParseWithClaims(pass, &c0, func(*jwt.Token) (any, error) { return []byte(pagesTestSecret), nil })
	if c0.Version == "" {
		t.Fatal("pass carries no version")
	}
	mint := func(claims jwt.MapClaims, secret string) string {
		s, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
		return s
	}
	base := jwt.MapClaims{"purpose": "page", "ns": "alpha", "id": c0.ID, "v": c0.Version}
	with := func(k string, v any) jwt.MapClaims {
		c := jwt.MapClaims{}
		for a, b := range base {
			c[a] = b
		}
		c[k] = v
		return c
	}
	withExp := func(k string, v any) jwt.MapClaims {
		c := with(k, v)
		c["exp"] = time.Now().Add(time.Hour).Unix()
		return c
	}
	// Control: a correct hand-made pass opens the page, so each case below
	// fails for its own reason only.
	if w := view(h, "/api/pages/view/"+mint(withExp("v", c0.Version), pagesTestSecret)+"/"); w.Code != http.StatusOK {
		t.Fatalf("control pass: %d", w.Code)
	}
	cases := map[string]string{
		"expired":       mint(with("exp", time.Now().Add(-time.Minute).Unix()), pagesTestSecret),
		"no-expiry":     mint(base, pagesTestSecret),
		"wrong-secret":  mint(with("exp", time.Now().Add(time.Hour).Unix()), "other"),
		"bad-id":        mint(withExp("id", "../alpha"), pagesTestSecret),
		"other-ns":      mint(withExp("ns", "beta"), pagesTestSecret),
		"no-version":    mint(withExp("v", ""), pagesTestSecret),
		"wrong-version": mint(withExp("v", "0000"), pagesTestSecret),
		"tampered":      pass[:len(pass)-2] + "xx",
	}
	for name, p := range cases {
		w := view(h, "/api/pages/view/"+p+"/")
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: %d", name, w.Code)
		}
		if w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: error response missing safety headers", name)
		}
	}
	// A pass is bound to the version it was made for: after a republish it
	// no longer opens the page, and a new pass does.
	if w := view(h, u); w.Code != http.StatusOK {
		t.Fatalf("pass before republish: %d", w.Code)
	}
	publish(h, "alpha", "one", "text/html", []byte("<p>ONE v2</p>"))
	if w := view(h, u); w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "v2") {
		t.Fatalf("old pass after republish: %d %s", w.Code, w.Body.String())
	}
	if w := view(h, passURL(t, h, "alpha", "one")); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "v2") {
		t.Fatalf("new pass after republish: %d", w.Code)
	}
	// ...and after a delete and a new page with the same name.
	u2 := passURL(t, h, "alpha", "two")
	dw := httptest.NewRecorder()
	h.Handle(dw, httptest.NewRequest(http.MethodDelete, "/api/pages?ns=alpha&path=two.page.md", nil))
	publish(h, "alpha", "two", "text/html", []byte("<p>NEW TWO</p>"))
	if w := view(h, u2); w.Code != http.StatusForbidden {
		t.Fatalf("old pass after delete and recreate: %d", w.Code)
	}
	// The version never shows in an API response.
	lw := httptest.NewRecorder()
	h.Handle(lw, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha", nil))
	if strings.Contains(lw.Body.String(), "version") {
		t.Fatalf("list leaks the version: %s", lw.Body.String())
	}

	// A fresh pass lasts 30 minutes by default.
	var c pageClaims
	jwt.ParseWithClaims(pass, &c, func(*jwt.Token) (any, error) { return []byte(pagesTestSecret), nil })
	if left := time.Until(c.ExpiresAt.Time); left < 29*time.Minute || left > 31*time.Minute {
		t.Fatalf("pass lifetime %v, want 30m", left)
	}
	// Only GET and HEAD.
	r := httptest.NewRequest(http.MethodPost, u, nil)
	w := httptest.NewRecorder()
	h.HandleStaticView(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST view: %d", w.Code)
	}
}

func TestPages_ScriptModeHeaders(t *testing.T) {
	for _, network := range []string{"strict", "open"} {
		t.Run(network, func(t *testing.T) {
			h, _ := pagesFixture(t, func(c *PagesConfig) {
				c.Origin = "https://pages.example.com"
				c.Network = network
			})
			publish(h, "alpha", "p", "text/html", []byte("<script>1</script>"))
			u := passURL(t, h, "alpha", "p")
			if !strings.HasPrefix(u, "https://pages.example.com/") {
				t.Fatalf("script-mode url = %q", u)
			}
			srv := httptest.NewServer(h.SiteHandler())
			defer srv.Close()
			path := strings.TrimPrefix(u, "https://pages.example.com")
			resp, err := http.Get(srv.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 200 || string(body) != "<script>1</script>" {
				t.Fatalf("%d %q", resp.StatusCode, body)
			}
			csp := resp.Header.Get("Content-Security-Policy")
			if !strings.HasSuffix(csp, "; sandbox allow-scripts") || strings.Contains(csp, "allow-same-origin") {
				t.Fatalf("csp = %q", csp)
			}
			for _, must := range []string{"frame-ancestors https://notes.example.com", "base-uri 'none'", "form-action 'none'", "object-src 'none'"} {
				if !strings.Contains(csp, must) {
					t.Errorf("csp missing %q: %q", must, csp)
				}
			}
			if network == "strict" && (strings.Contains(csp, "https:;") || strings.Contains(csp, "https: ") || !strings.Contains(csp, "connect-src https://pages.example.com")) {
				t.Errorf("strict csp lets the page reach other sites: %q", csp)
			}
			if network == "open" && !strings.Contains(csp, "https:") {
				t.Errorf("open csp = %q", csp)
			}
			if resp.Header.Get("Referrer-Policy") != "no-referrer" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
				t.Error("missing safety headers")
			}
			// The page's own fetch() comes from an opaque origin: without this
			// a dashboard cannot load its own data file.
			if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
			}
			if resp.Header.Get("Access-Control-Allow-Credentials") != "" {
				t.Error("pages must never allow credentials")
			}
			// The pages origin serves pages and nothing else.
			for _, p := range []string{"/api/pages?ns=alpha", "/api/config", "/"} {
				resp, _ := http.Get(srv.URL + p)
				if resp.StatusCode == 200 {
					t.Errorf("pages origin answered %s with 200", p)
				}
				resp.Body.Close()
			}
		})
	}
}

// F5: a PAGES_DIR inside NOTES_DIR would turn page files into readable
// notes, so startup refuses any overlap, also through a symlink.
func TestCheckPagesDir(t *testing.T) {
	root := t.TempDir()
	notes := filepath.Join(root, "notes")
	os.MkdirAll(notes, 0o755)
	link := filepath.Join(root, "link-to-notes")
	if err := os.Symlink(notes, link); err != nil {
		t.Fatal(err)
	}
	refused := []string{
		notes,
		filepath.Join(notes, "pages"),
		filepath.Join(notes, "alpha", "pages", "not-yet"),
		filepath.Join(link, "pages"),
		root, // the notes inside the pages
	}
	for _, p := range refused {
		if err := CheckPagesDir(p, notes); err == nil {
			t.Errorf("PAGES_DIR %s with NOTES_DIR %s was accepted", p, notes)
		}
	}
	allowed := []string{
		filepath.Join(root, "pages"),
		filepath.Join(root, "notes-pages"), // a shared prefix is not "inside"
	}
	for _, p := range allowed {
		if err := CheckPagesDir(p, notes); err != nil {
			t.Errorf("PAGES_DIR %s refused: %v", p, err)
		}
	}
}

func TestResolvePagesOrigin(t *testing.T) {
	cases := []struct {
		pages, front, want string
		refused            bool
	}{
		{"", "https://notes.example.com", "", false},
		{"https://pages.example.com", "https://notes.example.com", "https://pages.example.com", false},
		{"https://notes.example.com:8443/", "https://notes.example.com", "https://notes.example.com:8443", false},
		{"https://notes.example.com", "https://notes.example.com", "", true},
		{"https://NOTES.example.com:443", "https://notes.example.com/", "", true},
		{"http://localhost:3236", "http://localhost:3236", "", true},
		{"ftp://pages", "https://notes.example.com", "", true},
		{"not a url", "https://notes.example.com", "", true},
	}
	for _, c := range cases {
		got, msg := ResolvePagesOrigin(c.pages, c.front)
		if got != c.want || (msg != "") != c.refused {
			t.Errorf("ResolvePagesOrigin(%q, %q) = %q, %q", c.pages, c.front, got, msg)
		}
	}
}

func TestExtractPageText(t *testing.T) {
	title, desc, text := ExtractPageText([]byte(`<!doctype html><html><head><title> My
	Page </title><META NAME="Description" content="  Quarterly
	numbers &amp; notes[2J "><meta name="description" content="second one ignored"><script>alert("no")</script></head><body><noscript>nojs</noscript><template>tpl</template><p>Hello&amp;bye</p><div>next</div><style>p{color:red}</style></body></html>`))
	if title != "My Page" || text != "Hello&bye next" || desc != "Quarterly numbers & notes [2J" {
		t.Fatalf("title=%q desc=%q text=%q", title, desc, text)
	}
	// No description: empty, never the start of the text.
	if _, d, _ := ExtractPageText([]byte(`<meta name="viewport" content="width=device-width"><p>Body words</p>`)); d != "" {
		t.Fatalf("description without a description meta: %q", d)
	}
	// Capped.
	if _, d, _ := ExtractPageText([]byte(`<meta name="description" content="` + strings.Repeat("é", 900) + `">`)); len([]rune(d)) != maxPageDescription {
		t.Fatalf("description length %d", len([]rune(d)))
	}
}

func TestPages_ControlCharactersNeverReachTheTerminal(t *testing.T) {
	h, _ := pagesFixture(t)
	// An ESC sequence in the title (written as a character reference, which
	// the tokenizer decodes) and a raw one in the body.
	publish(h, "alpha", "esc", "text/html", []byte("<title>A&#27;[2Jcleared&#x85;x\u2028y</title><p>b\x1b]0;pwned\x07c</p>"))
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha&format=tsv", nil))
	line := strings.TrimSuffix(w.Body.String(), "\n")
	for _, r := range line {
		if r != '\t' && (r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x2028 || r == 0x2029) {
			t.Fatalf("control character %U in the TSV: %q", r, line)
		}
	}
	tw := httptest.NewRecorder()
	h.HandleText(tw, httptest.NewRequest(http.MethodGet, "/api/pages/text?ns=alpha&path=esc.page.md", nil))
	var m PageMeta
	json.Unmarshal(tw.Body.Bytes(), &m)
	if strings.ContainsAny(m.Title+m.Text, "\x1b\x07") {
		t.Fatalf("control characters kept: %q %q", m.Title, m.Text)
	}
}

func TestPagesEnabled(t *testing.T) {
	for _, c := range []struct {
		set, role string
		want      bool
	}{{"", "single", false}, {"true", "single", true}, {"true", "app", false}, {"false", "writer", false}, {"on", "writer", true}} {
		if got := PagesEnabled(c.set, c.role); got != c.want {
			t.Errorf("PagesEnabled(%q,%q) = %v", c.set, c.role, got)
		}
	}
}
