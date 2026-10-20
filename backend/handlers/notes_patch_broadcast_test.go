package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/storage"
)

// `mdnest append` / `prepend` (and an agent's append) are a PATCH. It used to
// write the file without telling anyone, so a browser with the note open did
// not show the new text until it reloaded. It must broadcast file-changed
// with the etag a GET of the new text returns, like PUT does.
func TestPatchNote_BroadcastsFileChanged(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "alpha", "n.md"), []byte("# Note\n\nfirst\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	hub := collab.NewHub()
	h := NewNoteHandler(stg)
	h.SetCollabHub(hub)
	viewer := collab.NewProbeConn(7, "viewer")
	hub.Join("alpha", "n.md", viewer)
	viewer.TakeQueued() // presence

	for _, pos := range []string{"bottom", "top"} {
		w := httptest.NewRecorder()
		h.Handle(w, httptest.NewRequest(http.MethodPatch, "/api/note?ns=alpha&path=n.md&position="+pos, strings.NewReader("added "+pos)))
		if w.Code != http.StatusOK {
			t.Fatalf("PATCH %s: %d %s", pos, w.Code, w.Body.String())
		}
		var got *collab.OutgoingMessage
		for _, raw := range viewer.TakeQueued() {
			var m collab.OutgoingMessage
			if json.Unmarshal(raw, &m) == nil && m.Type == "file-changed" {
				got = &m
			}
		}
		if got == nil {
			t.Fatalf("PATCH %s did not broadcast file-changed to a viewer of the note", pos)
		}
		g := httptest.NewRecorder()
		h.Handle(g, httptest.NewRequest(http.MethodGet, "/api/note?ns=alpha&path=n.md", nil))
		if etag := g.Header().Get("ETag"); got.ETag == "" || got.ETag != etag {
			t.Fatalf("PATCH %s broadcast etag %q, GET returns %q", pos, got.ETag, etag)
		}
		if w.Header().Get("ETag") != got.ETag {
			t.Fatalf("PATCH %s response etag %q differs from the broadcast %q", pos, w.Header().Get("ETag"), got.ETag)
		}
	}
}
