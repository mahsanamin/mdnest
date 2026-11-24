package handlers

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func gzipTar(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	gz.Write(makeTar(t, entries...))
	gz.Close()
	return b.Bytes()
}
func backupManifest(t *testing.T, entries ...pageBackupEntry) string {
	t.Helper()
	b, err := json.Marshal(pagesManifest{Version: 1, Namespace: "alpha", Pages: entries})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func exportPages(h *PagesHandler) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.HandleExport(w, httptest.NewRequest("GET", "/api/pages/export?ns=alpha", nil))
	return w
}
func importPages(h *PagesHandler, data []byte) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.HandleImport(w, httptest.NewRequest("POST", "/api/pages/import?ns=alpha", bytes.NewReader(data)))
	return w
}
func manifestFrom(t *testing.T, data []byte) pagesManifest {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	hdr, err := tr.Next()
	if err != nil || hdr.Name != "manifest.json" {
		t.Fatalf("manifest first: %v %v", hdr, err)
	}
	b, _ := io.ReadAll(tr)
	var m pagesManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPagesBackup_RoundTripBothStoresAndConflicts(t *testing.T) {
	for _, inGit := range []bool{false, true} {
		t.Run(map[bool]string{false: "external", true: "git"}[inGit], func(t *testing.T) {
			h, dir := pagesFixture(t, func(c *PagesConfig) { c.InGit = inGit })
			html := `<title>Q3 report</title><meta name="description" content="Revenue by region"><p>Report text</p>`
			for _, name := range []string{"Reports/q3", "skip-note", "missing", "orphan"} {
				w := publish(h, "alpha", name, "application/gzip", gzipTar(t, tarEntry{name: "index.html", body: html}, tarEntry{name: "img/x.svg", body: "IMAGE"}))
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			old := idOf(t, dir, "alpha", "Reports/q3")
			os.Remove(filepath.Join(notesOf(dir), "alpha", "orphan.page.md"))
			missing := idOf(t, dir, "alpha", "missing")
			os.RemoveAll(h.pageDir("alpha", missing))
			out := exportPages(h)
			if out.Code != 200 {
				t.Fatalf("export: %d %s", out.Code, out.Body.String())
			}
			m := manifestFrom(t, out.Body.Bytes())
			if len(m.Pages) != 2 || len(m.Skipped) != 1 || m.Skipped[0].Path != "missing.page.md" || m.Skipped[0].Reason != "files missing" {
				t.Fatalf("manifest: %+v", m)
			}
			if out.Header().Get("X-Mdnest-Pages-Exported") != "2" || out.Header().Get("X-Mdnest-Pages-Skipped") != "1" {
				t.Fatal(out.Header())
			}
			// One conflict is a normal note; another is a page handle to republish.
			note := filepath.Join(notesOf(dir), "alpha", "skip-note.page.md")
			os.WriteFile(note, []byte("ORDINARY NOTE"), 0644)
			h.cfg.InGit = !inGit
			w := importPages(h, out.Body.Bytes())
			if w.Code != 200 {
				t.Fatalf("import: %d %s", w.Code, w.Body.String())
			}
			var result struct {
				Restored, Skipped int
				Results           []pageBackupResult
			}
			json.Unmarshal(w.Body.Bytes(), &result)
			if result.Restored != 1 || result.Skipped != 2 || len(result.Results) != 3 {
				t.Fatalf("restore summary: %s", w.Body.String())
			}
			fresh := idOf(t, dir, "alpha", "Reports/q3")
			if old == fresh {
				t.Fatal("restore reused id")
			}
			data, err := os.ReadFile(filepath.Join(h.pageDir("alpha", fresh), "img", "x.svg"))
			if err != nil || string(data) != "IMAGE" {
				t.Fatalf("asset: %q %v", data, err)
			}
			meta, err := h.readMeta("alpha", fresh)
			if err != nil || meta.Title != "Q3 report" || meta.Description != "Revenue by region" {
				t.Fatalf("metadata: %+v %v", meta, err)
			}
			if data, _ := os.ReadFile(note); string(data) != "ORDINARY NOTE" {
				t.Fatal("restore overwrote ordinary note")
			}
			if got := view(h, passURL(t, h, "alpha", "Reports/q3")); got.Code != 200 || !strings.Contains(got.Body.String(), "Report text") {
				t.Fatal(got.Body.String())
			}
		})
	}
}

func TestPagesBackup_ValidatesWholeArchiveBeforePublishing(t *testing.T) {
	entry := pageBackupEntry{Key: "000000", Path: "safe.page.md", Title: "Restored title", Description: "Restored description"}
	good := []tarEntry{{name: "manifest.json", body: backupManifest(t, entry)}, {name: "pages/000000/index.html", body: "<p>OK</p>"}}
	cases := map[string][]tarEntry{}
	for _, p := range []string{"../outside", "/outside", "pages/000000/../../outside", ".mdnest/pages/evil", "pages/000000/.git/config", "pages/000000/a\\b"} {
		cases[p] = append(append([]tarEntry{}, good...), tarEntry{name: p, body: "bad"})
	}
	for _, kind := range []byte{tar.TypeSymlink, tar.TypeLink, tar.TypeFifo, tar.TypeChar} {
		cases[string(kind)] = append(append([]tarEntry{}, good...), tarEntry{name: "pages/000000/unsafe", typeflag: kind, link: "/outside"})
	}
	cases["duplicate file"] = append(append([]tarEntry{}, good...), good[1])
	cases["unlisted page"] = append(append([]tarEntry{}, good...), tarEntry{name: "pages/000001/index.html", body: "bad"})
	for _, p := range []string{"../evil.page.md", "/evil.page.md", ".mdnest/evil.page.md", "other/../../evil.page.md", "ordinary.md"} {
		e := entry
		e.Path = p
		cases["handle "+p] = []tarEntry{{name: "manifest.json", body: backupManifest(t, e)}, good[1]}
	}
	dup := entry
	dup.Key = "000001"
	cases["duplicate handle"] = []tarEntry{{name: "manifest.json", body: backupManifest(t, entry, dup)}, good[1], {name: "pages/000001/index.html", body: "bad"}}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			h, dir := pagesFixture(t)
			w := importPages(h, gzipTar(t, entries...))
			if w.Code < 400 {
				t.Fatalf("unsafe archive accepted: %s", w.Body.String())
			}
			if _, err := os.Stat(filepath.Join(notesOf(dir), "alpha", "safe.page.md")); !os.IsNotExist(err) {
				t.Fatal("archive partly published before validation")
			}
			if ids := h.storedIDs("alpha"); len(ids) != 0 {
				t.Fatalf("rejected archive stored pages: %v", ids)
			}
		})
	}
	// All pages are checked before publishing, including the last page's limits.
	for _, filesLimit := range []bool{false, true} {
		h, dir := pagesFixture(t)
		e2 := entry
		e2.Key = "000001"
		e2.Path = "second.page.md"
		entries := []tarEntry{{name: "manifest.json", body: backupManifest(t, entry, e2)}, good[1], {name: "pages/000001/index.html", body: strings.Repeat("x", 100)}, {name: "pages/000001/style.css", body: "x"}}
		if filesLimit {
			h.cfg.MaxFiles = 1
		} else {
			h.cfg.MaxBytes = 50
		}
		w := importPages(h, gzipTar(t, entries...))
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("page limits: %d %s", w.Code, w.Body.String())
		}
		if _, err := os.Stat(filepath.Join(notesOf(dir), "alpha", "safe.page.md")); !os.IsNotExist(err) {
			t.Fatal("first page published before last page validation")
		}
	}
}

func TestPagesBackup_PageDeletedDuringSnapshotIsSkippedCompletely(t *testing.T) {
	h, dir := pagesFixture(t)
	if w := publish(h, "alpha", "disappears", "application/gzip", gzipTar(t, tarEntry{name: "index.html", body: "<p>deleted</p>"}, tarEntry{name: "img/x.svg", body: "PARTIAL-ASSET"})); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := publish(h, "alpha", "healthy", "text/html", []byte("<p>healthy</p>")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	id := idOf(t, dir, "alpha", "disappears")
	original := snapshotPageFiles
	defer func() { snapshotPageFiles = original }()
	snapshotPageFiles = func(ctx context.Context, src, dst string, files []pageBackupFile) error {
		if filepath.Base(src) == id {
			if err := original(ctx, src, dst, files[:1]); err != nil {
				return err
			}
			os.RemoveAll(src)
			return original(ctx, src, dst, files[1:])
		}
		return original(ctx, src, dst, files)
	}
	out := exportPages(h)
	if out.Code != 200 {
		t.Fatalf("concurrent delete failed export: %d %s", out.Code, out.Body.String())
	}
	m := manifestFrom(t, out.Body.Bytes())
	if len(m.Pages) != 1 || m.Pages[0].Path != "healthy.page.md" || len(m.Skipped) != 1 || m.Skipped[0].Path != "disappears.page.md" {
		t.Fatalf("manifest: %+v", m)
	}
	gz, _ := gzip.NewReader(bytes.NewReader(out.Body.Bytes()))
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(hdr.Name, "img/") {
			t.Fatalf("half-copied page entered archive: %s", hdr.Name)
		}
	}
	if w := importPages(h, out.Body.Bytes()); w.Code != 200 || !strings.Contains(w.Body.String(), `"restored":1`) {
		t.Fatalf("partial backup cannot restore: %d %s", w.Code, w.Body.String())
	}
}

type blockedBackupWriter struct {
	header           http.Header
	started, release chan struct{}
	once             sync.Once
}

func (w *blockedBackupWriter) Header() http.Header { return w.header }
func (w *blockedBackupWriter) WriteHeader(int)     {}
func (w *blockedBackupWriter) Write(b []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.release
	return len(b), nil
}

func TestPagesBackup_SlowDownloadDoesNotLockPageMutations(t *testing.T) {
	h, _ := pagesFixture(t)
	if w := publish(h, "alpha", "report", "text/html", []byte("<p>report</p>")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w := &blockedBackupWriter{header: make(http.Header), started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.HandleExport(w, httptest.NewRequest("GET", "/api/pages/export?ns=alpha", nil))
	}()
	defer func() { close(w.release); <-done }()
	select {
	case <-w.started:
	case <-time.After(3 * time.Second):
		t.Fatal("export never wrote")
	}
	changed := make(chan *httptest.ResponseRecorder, 1)
	go func() { changed <- publish(h, "alpha", "report", "text/html", []byte("<p>new</p>")) }()
	select {
	case response := <-changed:
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("slow export blocked publish")
	}
}

type signaledPageBody struct {
	io.ReadCloser
	started chan struct{}
	once    sync.Once
}

func (r *signaledPageBody) Read(b []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	return r.ReadCloser.Read(b)
}

func TestPagesBackup_SlowPublishDoesNotLockOrOverwriteNewNote(t *testing.T) {
	h, dir := pagesFixture(t)
	reader, writer := io.Pipe()
	body := &signaledPageBody{ReadCloser: reader, started: make(chan struct{})}
	defer reader.Close()
	defer writer.Close()
	req := httptest.NewRequest("PUT", "/api/pages?ns=alpha&path=concurrent.page.md", nil)
	req.Header.Set("Content-Type", "text/html")
	req.Body = body
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); h.Handle(w, req); done <- w }()
	<-body.started
	created := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		NewNoteHandler(h.store).Handle(w, httptest.NewRequest("POST", "/api/note?ns=alpha&path=concurrent.page.md", strings.NewReader("ORDINARY NOTE")))
		created <- w
	}()
	select {
	case w := <-created:
		if w.Code != 201 {
			t.Fatal(w.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("upload locked note creation")
	}
	writer.Write([]byte("<p>page</p>"))
	writer.Close()
	if w := <-done; w.Code != 409 {
		t.Fatalf("publish overwrote concurrent note: %d %s", w.Code, w.Body.String())
	}
	data, _ := os.ReadFile(filepath.Join(notesOf(dir), "alpha/concurrent.page.md"))
	if !strings.Contains(string(data), "ORDINARY NOTE") {
		t.Fatalf("note was overwritten: %q", data)
	}
}

func TestPagesBackup_RejectsTotalSizeAndBrokenGzip(t *testing.T) {
	h, _ := pagesFixture(t)
	// A huge declared file is rejected before decompressing or allocating it.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "pages/000000/index.html", Typeflag: tar.TypeReg, Mode: 0644, Size: maxPagesBackupBytes + 1})
	gz.Close()
	if w := importPages(h, buf.Bytes()); w.Code != 413 {
		t.Fatalf("total limit: %d %s", w.Code, w.Body.String())
	}
	good := gzipTar(t, tarEntry{name: "manifest.json", body: backupManifest(t)}, tarEntry{name: "pages", typeflag: tar.TypeDir})
	good[len(good)-8] ^= 1
	if w := importPages(h, good); w.Code < 400 {
		t.Fatal("bad gzip checksum accepted")
	}
	if w := importPages(h, []byte("not gzip")); w.Code < 400 {
		t.Fatal("invalid gzip accepted")
	}
}
