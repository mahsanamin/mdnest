package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
		// Two markers: stripping only the first would leave the second as
		// the note's identity.
		"<!-- mdnest:" + idB + " -->\nbody\n\n<!-- mdnest:" + idA + " -->\npasted\n",
	} {
		name := []string{"a.md", "b.md", "c.md", "d.md"}[i]
		w := httptest.NewRecorder()
		h.Handle(w, httptest.NewRequest(http.MethodPost, "/api/note?ns=alpha&path="+name, strings.NewReader(body)))
		if w.Code != http.StatusCreated {
			t.Fatalf("%s: %d", name, w.Code)
		}
		got := read(name)
		if strings.Contains(got, idA) || strings.Contains(got, idB) {
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

// Appended or prepended text cannot set a note's identity: a prepended marker
// would become the note's first marker, which is what readers take as its ID.
func TestPatchNote_DropsIncomingMarker(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "alpha"), 0o755)
	stg, _ := storage.NewLocalStorage(root)
	h := NewNoteHandler(stg)
	const own = "cccccccc-3333-4333-8333-333333333333"
	const victim = "aaaaaaaa-1111-4111-8111-111111111111"
	os.WriteFile(filepath.Join(root, "alpha", "n.md"), []byte(InjectNoteID("body\n", own)), 0o644)
	for _, pos := range []string{"top", "bottom"} {
		w := httptest.NewRecorder()
		h.Handle(w, httptest.NewRequest(http.MethodPatch, "/api/note?ns=alpha&path=n.md&position="+pos,
			strings.NewReader("<!-- mdnest:"+victim+" -->\nhello\n")))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d", pos, w.Code)
		}
	}
	b, _ := os.ReadFile(filepath.Join(root, "alpha", "n.md"))
	if strings.Contains(string(b), victim) {
		t.Fatalf("append/prepend planted an id: %q", b)
	}
	if id, _ := ExtractNoteID(string(b)); id != own {
		t.Fatalf("note identity changed to %q", id)
	}
	// Appending to a note that does not exist yet creates it, and must not
	// give it a chosen identity either.
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodPatch, "/api/note?ns=alpha&path=new.md", strings.NewReader("x\n\n<!-- mdnest:"+victim+" -->\n")))
	if b, _ := os.ReadFile(filepath.Join(root, "alpha", "new.md")); strings.Contains(string(b), victim) {
		t.Fatalf("append-create planted an id: %q", b)
	}
}

// StripAllNoteIDs must agree with stripping one marker at a time, and stay
// linear: a 10 MB body of markers is something any writer can send.
func TestStripAllNoteIDs_EquivalentAndLinear(t *testing.T) {
	const a = "aaaaaaaa-1111-4111-8111-111111111111"
	const b = "bbbbbbbb-2222-4222-8222-222222222222"
	slow := func(s string) (string, string) {
		first := ""
		for {
			id, clean := ExtractNoteID(s)
			if id == "" {
				return first, s
			}
			if first == "" {
				first = id
			}
			s = clean
		}
	}
	for _, in := range []string{
		"no marker\n",
		"no trailing newline",
		InjectNoteID("body\n", a),
		"<!-- mdnest:" + a + " -->\ntop\n\nbody\n",
		"x\n<!-- mdnest:" + b + " -->\nmid\n<!-- mdnest:" + a + " -->  \nend\n\n\n",
		"<!-- mdnest:" + a + " -->",
		"inline <!-- mdnest:" + a + " --> stays\n",
	} {
		f1, b1 := slow(in)
		f2, b2 := StripAllNoteIDs(in)
		if f1 != f2 || b1 != b2 {
			t.Errorf("StripAllNoteIDs(%q) = (%q, %q), want (%q, %q)", in, f2, b2, f1, b1)
		}
	}
	// Linear, not quadratic: four times the markers must cost about four
	// times the time, not sixteen. A ratio, not a wall-clock bound, so the
	// race detector's slowdown does not matter. The old one-at-a-time strip
	// measured ~16x here.
	timeIt := func(n int) time.Duration {
		big := strings.Repeat("<!-- mdnest:a -->\n", n)
		best := time.Duration(1 << 62)
		for i := 0; i < 3; i++ {
			start := time.Now()
			id, body := StripAllNoteIDs(big)
			if d := time.Since(start); d < best {
				best = d
			}
			if id != "a" || strings.Contains(body, "mdnest:") {
				t.Fatalf("n=%d: id=%q, %d bytes left", n, id, len(body))
			}
		}
		return best
	}
	small, large := timeIt(5000), timeIt(20000)
	if ratio := float64(large) / float64(small); ratio > 9 {
		t.Fatalf("4x the markers took %.1fx the time (%v vs %v); the strip is not linear", ratio, large, small)
	}
}
