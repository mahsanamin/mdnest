package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// countingLookup records how many times GetUserByID is called so the cache can
// be observed.
type countingLookup struct {
	calls int
	user  *store.User
}

func (c *countingLookup) GetUserByID(id int) (*store.User, error) {
	c.calls++
	return c.user, nil
}

func TestCachedIdentityResolver_CachesAndResolves(t *testing.T) {
	lk := &countingLookup{user: &store.User{ID: 7, Username: "alice", Email: "alice@x"}}
	r := NewCachedIdentityResolver(lk)

	name, email, ok := r.Resolve(7)
	if !ok || name != "alice" || email != "alice@x" {
		t.Fatalf("Resolve = (%q,%q,%v), want (alice,alice@x,true)", name, email, ok)
	}
	if _, _, _ = r.Resolve(7); lk.calls != 1 {
		t.Fatalf("second Resolve hit the store: calls = %d, want 1", lk.calls)
	}
	if _, _, ok := r.Resolve(0); ok {
		t.Fatalf("Resolve(0) should be a miss")
	}
}

// fakeActivity captures recorded saves.
type fakeActivity struct{ calls []string }

func (f *fakeActivity) Record(ns, path, noteID string, userID int, action string) error {
	f.calls = append(f.calls, fmt.Sprintf("%s|%s|%s|%d|%s", ns, path, noteID, userID, action))
	return nil
}

// fakeAttrStore is a storage.Storage (via the embedded nil interface — its data
// methods are never called here) that also records Attribute calls.
type fakeAttrStore struct {
	storage.Storage
	attrs []string
}

func (f *fakeAttrStore) Attribute(ns, path, name, email string) {
	f.attrs = append(f.attrs, fmt.Sprintf("%s|%s|%s|%s", ns, path, name, email))
}

type staticIdents struct{}

func (staticIdents) Resolve(int) (string, string, bool) { return "Alice", "alice@x", true }

func withUserCtx(userID int, username string) *http.Request {
	r := httptest.NewRequest(http.MethodPut, "/api/note", nil)
	return middleware.WithUser(r, &middleware.UserContext{ID: userID, Username: username, Role: "collaborator"})
}

func TestRecordSave_RoutesToRecorderAndAttributor(t *testing.T) {
	st := &fakeAttrStore{}
	act := &fakeActivity{}
	h := NewNoteHandler(st)
	h.SetActivity(act)
	h.SetIdentityResolver(staticIdents{})

	h.recordSave(withUserCtx(7, "bob").Context(), "team", "a.md", "note-1", store.NoteActionEdited)

	if len(act.calls) != 1 || act.calls[0] != "team|a.md|note-1|7|edited" {
		t.Fatalf("activity calls = %v", act.calls)
	}
	// The resolved identity (Alice/alice@x) wins over the raw username for the
	// git author trailer.
	if len(st.attrs) != 1 || st.attrs[0] != "team|a.md|Alice|alice@x" {
		t.Fatalf("attribute calls = %v", st.attrs)
	}
}

func TestRecordSave_FallsBackToUsernameWithoutResolver(t *testing.T) {
	st := &fakeAttrStore{}
	h := NewNoteHandler(st) // no activity, no resolver
	h.recordSave(withUserCtx(3, "carol").Context(), "team", "b.md", "", store.NoteActionCreated)
	if len(st.attrs) != 1 || st.attrs[0] != "team|b.md|carol|" {
		t.Fatalf("attribute calls = %v", st.attrs)
	}
}

func TestRecordSave_SingleModeNoop(t *testing.T) {
	st := &fakeAttrStore{}
	act := &fakeActivity{}
	h := NewNoteHandler(st)
	h.SetActivity(act)
	// No user in context = single-user mode.
	r := httptest.NewRequest(http.MethodPut, "/api/note", nil)
	h.recordSave(r.Context(), "team", "a.md", "", store.NoteActionEdited)
	if len(act.calls) != 0 || len(st.attrs) != 0 {
		t.Fatalf("single mode should record nothing: act=%v attr=%v", act.calls, st.attrs)
	}
}

// fakeSummaryStore returns a canned attribution summary.
type fakeSummaryStore struct{ att *store.NoteAttribution }

func (f *fakeSummaryStore) Record(string, string, string, int, string) error { return nil }
func (f *fakeSummaryStore) Summary(string, string) (*store.NoteAttribution, error) {
	return f.att, nil
}

func TestHandleAttribution(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	att := &store.NoteAttribution{
		Created:      &store.NoteContributor{UserID: 1, Username: "alice", At: "2026-08-01T10:00:00Z"},
		LastEdited:   &store.NoteContributor{UserID: 2, Username: "bob", At: "2026-08-01T11:00:00Z"},
		Contributors: []store.NoteContributor{{UserID: 2, Username: "bob"}, {UserID: 1, Username: "alice"}},
	}
	h := NewAttributionHandler(stg, &fakeSummaryStore{att: att})

	r := httptest.NewRequest(http.MethodGet, "/api/note/attribution?ns=team&path=a.md", nil)
	w := httptest.NewRecorder()
	h.HandleAttribution(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var got store.NoteAttribution
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Created == nil || got.Created.Username != "alice" {
		t.Errorf("created = %+v", got.Created)
	}
	if got.LastEdited == nil || got.LastEdited.Username != "bob" {
		t.Errorf("last edited = %+v", got.LastEdited)
	}
	if len(got.Contributors) != 2 {
		t.Errorf("contributors = %+v", got.Contributors)
	}
}

func TestHandleAttribution_MethodNotAllowed(t *testing.T) {
	stg, _ := storage.NewLocalStorage(t.TempDir())
	h := NewAttributionHandler(stg, &fakeSummaryStore{})
	r := httptest.NewRequest(http.MethodPost, "/api/note/attribution?ns=team&path=a.md", nil)
	w := httptest.NewRecorder()
	h.HandleAttribution(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}
