package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// On a git-native HA app replica the git tree lives only on the writer, so the
// history endpoints must delegate to the writer proxy rather than reading a
// (nonexistent) local .git/ and reporting that history is unavailable.
func TestHistoryDelegatesToWriterProxy(t *testing.T) {
	h := NewHistoryHandler("/nonexistent")
	var gotPath string
	h.SetWriterProxy(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusTeapot)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/note/history?ns=alpha&path=a.md", nil)
	rec := httptest.NewRecorder()
	h.HandleHistory(rec, req)

	if rec.Code != http.StatusTeapot || gotPath != "/api/note/history" {
		t.Fatalf("expected history delegation to proxy, got code=%d path=%q", rec.Code, gotPath)
	}
}

func TestNoteAtDelegatesToWriterProxy(t *testing.T) {
	h := NewHistoryHandler("/nonexistent")
	var gotPath string
	h.SetWriterProxy(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusTeapot)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/note/at?ns=alpha&path=a.md&ref=abc1234", nil)
	rec := httptest.NewRecorder()
	h.HandleNoteAt(rec, req)

	if rec.Code != http.StatusTeapot || gotPath != "/api/note/at" {
		t.Fatalf("expected note-at delegation to proxy, got code=%d path=%q", rec.Code, gotPath)
	}
}

// Without a writer proxy (single/writer role) and with no local .git/, both
// endpoints report history is unavailable rather than delegating.
func TestHistoryNoProxyNoGitReturns404(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := NewHistoryHandler(dir)

	req := httptest.NewRequest(http.MethodGet, "/api/note/history?ns=alpha&path=a.md", nil)
	rec := httptest.NewRecorder()
	h.HandleHistory(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 without git or proxy, got %d", rec.Code)
	}
}
