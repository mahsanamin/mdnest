package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPagesGit_FlipStorage(t *testing.T) {
	h, external := pagesFixture(t)
	if w := publish(h, "alpha", "old", "text/html", []byte("<title>Old</title><p>outside</p>")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	old := idOf(t, external, "alpha", "old")
	h.cfg.InGit = true
	if w := publish(h, "alpha", "new", "text/html", []byte("<title>New</title><p>inside</p>")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	id := idOf(t, external, "alpha", "new")
	hidden := filepath.Join(notesOf(external), "alpha", ".mdnest", "pages", id, "index.html")
	if _, err := os.Stat(hidden); err != nil {
		t.Fatalf("new publish is not in the namespace: %v", err)
	}
	if _, err := os.Stat(filepath.Join(external, "alpha", id)); !os.IsNotExist(err) {
		t.Fatal("git publish also wrote to external store")
	}
	for _, on := range []bool{false, true, false} {
		h.cfg.InGit = on
		for _, name := range []string{"old", "new"} {
			if w := view(h, passURL(t, h, "alpha", name)); w.Code != http.StatusOK {
				t.Fatalf("flag %v: view %s: %d", on, name, w.Code)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(external, "alpha", old, "index.html")); err != nil {
		t.Fatal("flipping flag moved old page")
	}
	h.cfg.InGit = true
	if w := publish(h, "alpha", "old", "text/html", []byte("<p>republished</p>")); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(external, "alpha", old)); !os.IsNotExist(err) {
		t.Fatal("republish did not clean unreferenced old page")
	}
	h.cfg.InGit = false
	os.Remove(filepath.Join(notesOf(external), "alpha", "new.page.md"))
	if got := h.unlinked("alpha", nil); len(got) != 2 {
		t.Fatalf("both stores should be listed without references: %+v", got)
	}
	if !h.removeStored("alpha", id) {
		t.Fatal("flag off cannot remove hidden page")
	}
	if _, err := os.Stat(hidden); !os.IsNotExist(err) {
		t.Fatal("hidden page survived delete")
	}
}

func TestPagesGit_CarryAcrossStores(t *testing.T) {
	h, external := pagesFixture(t)
	os.MkdirAll(filepath.Join(notesOf(external), "beta"), 0755)
	for _, inGit := range []bool{false, true} {
		h.cfg.InGit = inGit
		if w := publish(h, "alpha", "carry", "text/html", []byte("<title>Carry</title><p>asset</p>")); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		id := idOf(t, external, "alpha", "carry")
		h.cfg.InGit = !inGit
		copied, ok, err := h.CarryPage("alpha", id, "beta")
		if err != nil || !ok {
			t.Fatalf("carry: %v %v", ok, err)
		}
		if data, err := os.ReadFile(filepath.Join(h.pageDir("beta", copied), "index.html")); err != nil || !strings.Contains(string(data), "asset") {
			t.Fatalf("carried files: %q %v", data, err)
		}
		h.UndoCarry("beta", copied)
		if h.pageStored("beta", copied) {
			t.Fatal("rollback left page")
		}
	}
}

func TestPagesGit_CarryChecksMetadataPathBeforeCopying(t *testing.T) {
	for _, inGit := range []bool{false, true} {
		h, external := pagesFixture(t, func(c *PagesConfig) { c.InGit = inGit })
		os.MkdirAll(filepath.Join(notesOf(external), "beta"), 0755)
		if w := publish(h, "alpha", "carry", "text/html", []byte("<p>carry</p>")); w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		id := idOf(t, external, "alpha", "carry")
		root := h.nsDir("beta")
		os.MkdirAll(root, 0755)
		if err := os.Symlink(t.TempDir(), filepath.Join(root, pagesMetaDir)); err != nil {
			t.Fatal(err)
		}
		original := copyPageFiles
		copied := false
		copyPageFiles = func(string, string) error { copied = true; return os.ErrPermission }
		_, ok, err := h.CarryPage("alpha", id, "beta")
		copyPageFiles = original
		if err == nil || ok {
			t.Fatal("unsafe metadata folder was accepted")
		}
		if copied {
			t.Fatal("carry started copying before checking its metadata path")
		}
	}
}

func TestPagesGit_RejectHiddenSymlinks(t *testing.T) {
	for _, segment := range []string{".mdnest", ".mdnest/pages"} {
		t.Run(strings.ReplaceAll(segment, "/", "-"), func(t *testing.T) {
			h, external := pagesFixture(t)
			h.cfg.InGit = true
			target := filepath.Join(notesOf(external), "alpha", segment)
			os.MkdirAll(filepath.Dir(target), 0755)
			outside := t.TempDir()
			if err := os.Symlink(outside, target); err != nil {
				t.Fatal(err)
			}
			if w := publish(h, "alpha", "escape", "text/html", []byte("<p>no</p>")); w.Code == 200 {
				t.Fatal("published through a hidden-folder symlink")
			}
			entries, _ := os.ReadDir(outside)
			if len(entries) != 0 {
				t.Fatal("wrote outside namespace")
			}
		})
	}
}
