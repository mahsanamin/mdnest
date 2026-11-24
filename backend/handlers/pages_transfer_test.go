package handlers

// A page handle moved or copied to another namespace takes its page along
// (transfer.go + pages_handles.go CarryPage), all or nothing.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pagesTEnv is a transfer environment (alpha, beta) with pages on.
func pagesTEnv(t *testing.T) (*tenv, *PagesHandler, string) {
	t.Helper()
	e := newTEnv(t)
	pagesDir := filepath.Join(t.TempDir(), "pages")
	os.MkdirAll(pagesDir, 0o755)
	h := NewPagesHandler(PagesConfig{Dir: pagesDir, MaxBytes: 1 << 20, MaxFiles: 50, Secret: []byte(pagesTestSecret), SingleUser: "admin"}, e.store, nil)
	e.h.SetPages(h)
	return e, h, pagesDir
}

// handleID reads the id a handle in a transfer env names.
func handleID(t *testing.T, e *tenv, ns, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.root, ns, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("handle %s:%s: %v", ns, rel, err)
	}
	id, ok := ParsePageHandle(string(b))
	if !ok || !ValidPageID(id) {
		t.Fatalf("handle %s:%s holds no id: %q", ns, rel, b)
	}
	return id
}

// viewBody opens the page a handle names, through a pass, and returns its
// index.html (or the error status).
func viewBody(t *testing.T, h *PagesHandler, ns, rel string) (int, string) {
	t.Helper()
	w := callPass(h, ns, rel)
	if w.Code != http.StatusOK {
		return w.Code, w.Body.String()
	}
	var resp struct{ URL string }
	jsonUnmarshal(w.Body.Bytes(), &resp)
	v := view(h, resp.URL)
	return v.Code, v.Body.String()
}

func TestPages_TransferCarriesThePage(t *testing.T) {
	e, h, pagesDir := pagesTEnv(t)
	stored := func(ns, id string) bool { _, err := os.Stat(filepath.Join(pagesDir, ns, id)); return err == nil }
	publish(h, "alpha", "Proj/report", "text/html", []byte("<p>REPORT</p>"))
	id := handleID(t, e, "alpha", "Proj/report.page.md")

	// Copy: both namespaces hold the page, under the same id.
	if code, _, body := doTransfer(t, e.h, transferReq("copy", "alpha", "Proj/report.page.md", "beta", "In/report.page.md"), false, nil); code != 200 {
		t.Fatalf("copy: %d %s", code, body)
	}
	if got := handleID(t, e, "beta", "In/report.page.md"); got != id || !stored("beta", id) || !stored("alpha", id) {
		t.Fatalf("copy: beta id %s, want %s; stored alpha=%v beta=%v", got, id, stored("alpha", id), stored("beta", id))
	}
	for _, ns := range []string{"alpha", "beta"} {
		rel := map[string]string{"alpha": "Proj/report.page.md", "beta": "In/report.page.md"}[ns]
		if code, b := viewBody(t, h, ns, rel); code != 200 || !strings.Contains(b, "REPORT") {
			t.Fatalf("view after copy in %s: %d %s", ns, code, b)
		}
	}

	// Copy again: beta already has that id, so the copy gets a new one and
	// its handle is rewritten; the first copy is untouched.
	if code, _, body := doTransfer(t, e.h, transferReq("copy", "alpha", "Proj/report.page.md", "beta", "In/second.page.md"), false, nil); code != 200 {
		t.Fatalf("second copy: %d %s", code, body)
	}
	id2 := handleID(t, e, "beta", "In/second.page.md")
	if id2 == id || !stored("beta", id2) || handleID(t, e, "beta", "In/report.page.md") != id {
		t.Fatalf("id clash: second copy id %s (first %s)", id2, id)
	}
	if code, b := viewBody(t, h, "beta", "In/second.page.md"); code != 200 || !strings.Contains(b, "REPORT") {
		t.Fatalf("view the renamed copy: %d %s", code, b)
	}
	hb, _ := os.ReadFile(filepath.Join(e.root, "beta", "In", "second.page.md"))
	if !strings.Contains(string(hb), "HTML page, open it in mdnest.") || strings.Contains(string(hb), id) {
		t.Fatalf("rewritten handle: %q", hb)
	}

	// Move: the page leaves alpha with its handle.
	publish(h, "alpha", "Proj/moving", "text/html", []byte("<p>MOVING</p>"))
	mid := handleID(t, e, "alpha", "Proj/moving.page.md")
	if code, _, body := doTransfer(t, e.h, transferReq("move", "alpha", "Proj/moving.page.md", "beta", "In/moving.page.md"), false, nil); code != 200 {
		t.Fatalf("move: %d %s", code, body)
	}
	if stored("alpha", mid) || !stored("beta", mid) {
		t.Fatalf("move: stored alpha=%v beta=%v", stored("alpha", mid), stored("beta", mid))
	}
	if code, b := viewBody(t, h, "beta", "In/moving.page.md"); code != 200 || !strings.Contains(b, "MOVING") {
		t.Fatalf("view after move: %d %s", code, b)
	}
}

func TestPages_TransferAFolderOfHandles(t *testing.T) {
	e, h, pagesDir := pagesTEnv(t)
	stored := func(ns, id string) bool { _, err := os.Stat(filepath.Join(pagesDir, ns, id)); return err == nil }
	publish(h, "alpha", "Proj/a", "text/html", []byte("<p>A</p>"))
	publish(h, "alpha", "Proj/sub/b", "text/html", []byte("<p>B</p>"))
	e.put(t, "alpha", "Proj/notes.md", "# notes\n")
	ida, idb := handleID(t, e, "alpha", "Proj/a.page.md"), handleID(t, e, "alpha", "Proj/sub/b.page.md")
	// A second handle for B stays behind in alpha: B is copied, not moved.
	hb, _ := os.ReadFile(filepath.Join(e.root, "alpha", "Proj", "sub", "b.page.md"))
	e.put(t, "alpha", "Elsewhere/b-link.page.md", string(hb))

	if code, _, body := doTransfer(t, e.h, transferReq("move", "alpha", "Proj", "beta", "Proj"), false, nil); code != 200 {
		t.Fatalf("folder move: %d %s", code, body)
	}
	if stored("alpha", ida) || !stored("beta", ida) {
		t.Fatalf("A: stored alpha=%v beta=%v", stored("alpha", ida), stored("beta", ida))
	}
	if !stored("alpha", idb) || !stored("beta", idb) {
		t.Fatalf("B is still named in alpha, so it must stay there too: alpha=%v beta=%v", stored("alpha", idb), stored("beta", idb))
	}
	for rel, want := range map[string]string{"Proj/a.page.md": "<p>A</p>", "Proj/sub/b.page.md": "<p>B</p>"} {
		if code, b := viewBody(t, h, "beta", rel); code != 200 || b != want {
			t.Fatalf("view %s in beta: %d %s", rel, code, b)
		}
	}
	if code, b := viewBody(t, h, "alpha", "Elsewhere/b-link.page.md"); code != 200 || b != "<p>B</p>" {
		t.Fatalf("the handle left in alpha: %d %s", code, b)
	}
}

func TestPages_TransferRollsBackWhenThePageCannotBeCarried(t *testing.T) {
	e, h, pagesDir := pagesTEnv(t)
	publish(h, "alpha", "Proj/a", "text/html", []byte("<p>A</p>"))
	publish(h, "alpha", "Proj/b", "text/html", []byte("<p>B</p>"))
	ida, idb := handleID(t, e, "alpha", "Proj/a.page.md"), handleID(t, e, "alpha", "Proj/b.page.md")

	// The second page copy fails, after the first succeeded.
	real := copyPageFiles
	calls := 0
	copyPageFiles = func(src, dst string) error {
		calls++
		if calls == 2 {
			return errors.New("disk full")
		}
		return real(src, dst)
	}
	defer func() { copyPageFiles = real }()

	for _, mode := range []string{"move", "copy"} {
		calls = 0
		code, _, body := doTransfer(t, e.h, transferReq(mode, "alpha", "Proj", "beta", "Proj"), false, nil)
		if code != http.StatusInternalServerError || !strings.Contains(body, "could not carry the HTML page") || !strings.Contains(body, "nothing was changed") {
			t.Fatalf("%s: %d %s", mode, code, body)
		}
		// Nothing half-done: no handle, no page and no temp folder in beta;
		// alpha exactly as before.
		if _, err := os.Stat(filepath.Join(e.root, "beta", "Proj")); !os.IsNotExist(err) {
			entries, _ := os.ReadDir(filepath.Join(e.root, "beta", "Proj"))
			if len(entries) > 0 {
				t.Fatalf("%s: beta/Proj kept %d entries", mode, len(entries))
			}
		}
		if entries, _ := os.ReadDir(filepath.Join(pagesDir, "beta")); len(entries) > 1 {
			names := []string{}
			for _, en := range entries {
				names = append(names, en.Name())
			}
			t.Fatalf("%s: beta pages left behind: %v", mode, names)
		}
		for _, id := range []string{ida, idb} {
			if _, err := os.Stat(filepath.Join(pagesDir, "alpha", id)); err != nil {
				t.Fatalf("%s: alpha lost page %s", mode, id)
			}
		}
		for _, rel := range []string{"Proj/a.page.md", "Proj/b.page.md"} {
			if code, _ := viewBody(t, h, "alpha", rel); code != 200 {
				t.Fatalf("%s: alpha %s no longer opens: %d", mode, rel, code)
			}
		}
	}
}

func TestPages_SameNamespaceTransferSharesThePage(t *testing.T) {
	e, h, pagesDir := pagesTEnv(t)
	publish(h, "alpha", "Proj/a", "text/html", []byte("<p>A</p>"))
	id := handleID(t, e, "alpha", "Proj/a.page.md")
	if code, _, body := doTransfer(t, e.h, transferReq("copy", "alpha", "Proj/a.page.md", "alpha", "Other/a.page.md"), false, nil); code != 200 {
		t.Fatalf("copy: %d %s", code, body)
	}
	if handleID(t, e, "alpha", "Other/a.page.md") != id {
		t.Fatal("a copy in the same namespace names the same page")
	}
	entries, _ := os.ReadDir(filepath.Join(pagesDir, "alpha"))
	if len(entries) != 2 { // the page and .pages-meta
		t.Fatalf("a copy in the same namespace stored the page twice: %d entries", len(entries))
	}
	if code, _, body := doTransfer(t, e.h, transferReq("move", "alpha", "Proj/a.page.md", "alpha", "Moved/a.page.md"), false, nil); code != 200 {
		t.Fatalf("move: %d %s", code, body)
	}
	if code, b := viewBody(t, h, "alpha", "Moved/a.page.md"); code != 200 || b != "<p>A</p>" {
		t.Fatalf("moved handle: %d %s", code, b)
	}
}

func callPass(h *PagesHandler, ns, rel string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.HandlePass(w, httptest.NewRequest(http.MethodPost, "/api/pages/pass?ns="+ns+"&path="+url.QueryEscape(rel), nil))
	return w
}

func jsonUnmarshal(b []byte, v any) { json.Unmarshal(b, v) }
