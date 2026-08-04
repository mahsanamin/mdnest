package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// commentsStore roots a local storage backend with a single namespace holding
// one note, so resolveNoteID can read/inject a marker.
func commentsStore(t *testing.T) storage.Storage {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "alpha")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "note.md"), []byte("# Hello\n"), 0o644); err != nil {
		t.Fatalf("write note: %v", err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatalf("new local storage: %v", err)
	}
	return stg
}

func commentReq(h *CommentsHandler, method, query, body string, uc *middleware.UserContext) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, "/api/comments?"+query, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, "/api/comments?"+query, nil)
	}
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	h.Handle(w, r)
	return w
}

func TestUpdateCommentBodyIsAuthorOnly(t *testing.T) {
	h := NewCommentsHandler(commentsStore(t))
	alice := &middleware.UserContext{ID: 1, Username: "alice", Role: "collaborator"}
	bob := &middleware.UserContext{ID: 2, Username: "bob", Role: "collaborator"}
	q := "ns=alpha&path=" + url.QueryEscape("note.md")

	// Alice creates a comment.
	w := commentReq(h, http.MethodPost, q, `{"body":"original"}`, alice)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var created Comment
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	idQ := q + "&id=" + url.QueryEscape(created.ID)

	// Bob cannot edit Alice's words.
	w = commentReq(h, http.MethodPatch, idQ, `{"body":"tampered"}`, bob)
	if w.Code != http.StatusForbidden {
		t.Fatalf("bob edit: want 403, got %d (%s)", w.Code, w.Body.String())
	}

	// Bob can still resolve it (moderation stays open).
	w = commentReq(h, http.MethodPatch, idQ, `{"resolved":true}`, bob)
	if w.Code != http.StatusOK {
		t.Fatalf("bob resolve: want 200, got %d (%s)", w.Code, w.Body.String())
	}

	// Alice can edit her own; editedAt is stamped.
	w = commentReq(h, http.MethodPatch, idQ, `{"body":"revised"}`, alice)
	if w.Code != http.StatusOK {
		t.Fatalf("alice edit: want 200, got %d (%s)", w.Code, w.Body.String())
	}

	// A blank body is rejected.
	w = commentReq(h, http.MethodPatch, idQ, `{"body":"   "}`, alice)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("blank edit: want 400, got %d (%s)", w.Code, w.Body.String())
	}

	// Read back: body revised, editedAt present, still resolved.
	w = commentReq(h, http.MethodGet, q, "", alice)
	if w.Code != http.StatusOK {
		t.Fatalf("list: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var list []Comment
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1 comment, got %d", len(list))
	}
	got := list[0]
	if got.Body != "revised" {
		t.Fatalf("body: want %q, got %q", "revised", got.Body)
	}
	if got.EditedAt == nil || *got.EditedAt == "" {
		t.Fatalf("editedAt should be stamped after an edit")
	}
	if !got.Resolved {
		t.Fatalf("comment should remain resolved after Bob resolved it")
	}
}
