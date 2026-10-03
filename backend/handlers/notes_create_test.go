package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
)

// Case 13: a created note never keeps an incoming marker — however the
// client sends it — so two notes cannot share a comment thread.
func TestCreateNote_DropsIncomingMarker(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	h := NewNoteHandler(stg)
	read := func(name string) string {
		b, _ := os.ReadFile(filepath.Join(root, "alpha", name))
		return string(b)
	}
	put := func(name, content string) {
		if err := os.WriteFile(filepath.Join(root, "alpha", name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const idA = "aaaaaaaa-1111-4111-8111-111111111111"
	const idB = "bbbbbbbb-2222-4222-8222-222222222222"
	marked := InjectNoteID
	for i, body := range []string{
		marked("pasted\n", idA),
		"pasted\n\n<!-- mdnest:" + idA + " -->",
		"<!-- mdnest:" + idA + " -->\npasted at the top\n",
	} {
		name := []string{"a.md", "b.md", "c.md"}[i]
		w := httptest.NewRecorder()
		h.Handle(w, httptest.NewRequest(http.MethodPost, "/api/note?ns=alpha&path="+name, strings.NewReader(body)))
		if w.Code != http.StatusCreated {
			t.Fatalf("%s: %d", name, w.Code)
		}
		got := read(name)
		if strings.Contains(got, idA) {
			t.Fatalf("%s kept the incoming id: %q", name, got)
		}
		if !strings.Contains(got, "pasted") {
			t.Fatalf("%s lost its content: %q", name, got)
		}
	}
	// A body with no marker is stored byte for byte, as before.
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodPost, "/api/note?ns=alpha&path=plain.md", strings.NewReader("no trailing newline")))
	if got := read("plain.md"); got != "no trailing newline" {
		t.Fatalf("plain create changed: %q", got)
	}
	// An update (PUT) still keeps the note's own id, which restores rely on.
	put("kept.md", marked("v1\n", idB))
	w = httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodPut, "/api/note?ns=alpha&path=kept.md", strings.NewReader("v2\n")))
	if got := read("kept.md"); !strings.Contains(got, idB) {
		t.Fatalf("PUT lost the id: %q", got)
	}
}
