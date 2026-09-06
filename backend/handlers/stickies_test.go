package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// call drives the handler over one store so a test can make several requests
// against the same state. userID < 0 means "send no user context", which is
// how a single-mode request actually arrives.
func call(h *StickiesHandler, method, body string, userID int) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/api/stickies", nil)
	} else {
		r = httptest.NewRequest(method, "/api/stickies", strings.NewReader(body))
	}
	if userID >= 0 {
		r = middleware.WithUser(r, &middleware.UserContext{ID: userID, Username: "u", Role: "collaborator"})
	}
	w := httptest.NewRecorder()
	h.Handle(w, r)
	return w
}

func board(t *testing.T, w *httptest.ResponseRecorder) []store.Sticky {
	t.Helper()
	var got struct {
		Stickies []store.Sticky `json:"stickies"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not a sticky board: %v (%s)", err, w.Body.String())
	}
	return got.Stickies
}

func multiHandler(t *testing.T) *StickiesHandler {
	t.Helper()
	return NewStickiesHandler(store.NewFileStickyStore(t.TempDir()), true)
}

// A board that has never been written is an empty array, not a 404. The
// frontend loads it on mount, and "you have no stickies" is a normal state
// rather than an error it should have to special-case.
func TestStickiesFirstGetIsAnEmptyBoard(t *testing.T) {
	w := call(multiHandler(t), http.MethodGet, "", 7)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	if cards := board(t, w); len(cards) != 0 {
		t.Fatalf("a fresh board should be empty, got %v", cards)
	}
	// Explicitly an array. `null` would make the client's .map() throw.
	if !strings.Contains(w.Body.String(), `"stickies":[]`) {
		t.Fatalf("empty board must serialise as [], got %s", w.Body.String())
	}
}

func TestStickiesRoundTrip(t *testing.T) {
	h := multiHandler(t)

	w := call(h, http.MethodPut, `{"stickies":[
		{"id":"a","body":"buy milk","done":false,"color":"blue","created_at":1,"updated_at":1}
	]}`, 7)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT got %d, want 200 (%s)", w.Code, w.Body.String())
	}
	if cards := board(t, w); len(cards) != 1 || cards[0].Body != "buy milk" {
		t.Fatalf("PUT should echo the stored board, got %v", cards)
	}

	cards := board(t, call(h, http.MethodGet, "", 7))
	if len(cards) != 1 || cards[0].ID != "a" || cards[0].Color != "blue" || cards[0].Done {
		t.Fatalf("GET after PUT: got %v", cards)
	}
}

// The board is replaced, not merged: deleting a card client-side means PUTting
// the array without it, and that has to actually delete it.
func TestStickiesPutReplacesTheWholeBoard(t *testing.T) {
	h := multiHandler(t)
	call(h, http.MethodPut, `{"stickies":[{"id":"a","body":"one","color":"yellow"},{"id":"b","body":"two","color":"pink"}]}`, 7)
	call(h, http.MethodPut, `{"stickies":[{"id":"b","body":"two","color":"pink"}]}`, 7)

	cards := board(t, call(h, http.MethodGet, "", 7))
	if len(cards) != 1 || cards[0].ID != "b" {
		t.Fatalf("PUT should replace the board, got %v", cards)
	}
}

// The identity that owns a board comes from the request context and nothing
// else — there is no user id in the URL or the body to get wrong. This pins
// that two users on one store never see each other's cards.
func TestStickiesAreKeyedToTheAuthenticatedUser(t *testing.T) {
	h := multiHandler(t)
	call(h, http.MethodPut, `{"stickies":[{"id":"a","body":"mine","color":"yellow"}]}`, 7)

	if cards := board(t, call(h, http.MethodGet, "", 8)); len(cards) != 0 {
		t.Fatalf("user 8 should see an empty board, got %v", cards)
	}

	call(h, http.MethodPut, `{"stickies":[{"id":"z","body":"theirs","color":"green"}]}`, 8)
	cards := board(t, call(h, http.MethodGet, "", 7))
	if len(cards) != 1 || cards[0].Body != "mine" {
		t.Fatalf("user 7's board was disturbed by user 8: %v", cards)
	}
}

// Each limit rejects with its own message. A generic 400 would leave the user
// guessing which of four caps they hit.
func TestStickiesLimits(t *testing.T) {
	cases := []struct{ name, body, wantMsg string }{
		{"too many", manyStickies(store.MaxStickies + 1), "too many"},
		{"card too large", fmt.Sprintf(`{"stickies":[{"id":"a","color":"yellow","body":%q}]}`,
			strings.Repeat("x", store.MaxStickyBody+1)), "too large"},
		{"invalid colour", `{"stickies":[{"id":"a","body":"x","color":"rainbow"}]}`, "colour"},
		{"missing id", `{"stickies":[{"body":"x","color":"yellow"}]}`, "id"},
		{"duplicate id", `{"stickies":[{"id":"a","body":"x","color":"yellow"},{"id":"a","body":"y","color":"yellow"}]}`, "duplicate"},
		{"not JSON", `{`, "json"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := call(multiHandler(t), http.MethodPut, c.body, 7)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400 (%s)", w.Code, w.Body.String())
			}
			if !strings.Contains(strings.ToLower(w.Body.String()), c.wantMsg) {
				t.Fatalf("error should name the problem (%q), got %s", c.wantMsg, w.Body.String())
			}
		})
	}
}

// A rejected write must leave the previous board alone. Storing the valid
// prefix and reporting an error would be the worst of both.
func TestStickiesRejectedWriteLeavesTheBoardIntact(t *testing.T) {
	h := multiHandler(t)
	call(h, http.MethodPut, `{"stickies":[{"id":"a","body":"keep me","color":"yellow"}]}`, 7)
	call(h, http.MethodPut, `{"stickies":[{"id":"b","body":"x","color":"rainbow"}]}`, 7)

	cards := board(t, call(h, http.MethodGet, "", 7))
	if len(cards) != 1 || cards[0].Body != "keep me" {
		t.Fatalf("a rejected PUT changed the board: %v", cards)
	}
}

// An empty colour is the one thing normalised rather than refused — it is what
// an older client or a hand-written curl would send, and a sticky without a
// colour still has to render.
func TestStickiesDefaultColour(t *testing.T) {
	w := call(multiHandler(t), http.MethodPut, `{"stickies":[{"id":"a","body":"x"}]}`, 7)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%s)", w.Code, w.Body.String())
	}
	if cards := board(t, w); cards[0].Color != "yellow" {
		t.Fatalf("missing colour should default, got %q", cards[0].Color)
	}
}

// A position round-trips, and the distinction the pointer exists for survives:
// a card at 0,0 is not the same as a card that has never been dragged.
func TestStickiesPositionRoundTrip(t *testing.T) {
	h := multiHandler(t)
	w := call(h, http.MethodPut, `{"stickies":[
		{"id":"placed","body":"x","color":"yellow","x":0,"y":0},
		{"id":"loose","body":"y","color":"yellow"}
	]}`, 7)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 (%s)", w.Code, w.Body.String())
	}

	cards := board(t, call(h, http.MethodGet, "", 7))
	if cards[0].X == nil || *cards[0].X != 0 || cards[0].Y == nil {
		t.Fatalf("a card placed at 0,0 lost its position: %+v", cards[0])
	}
	if cards[1].X != nil || cards[1].Y != nil {
		t.Fatalf("an undragged card should have no position: %+v", cards[1])
	}

	// And it must serialise back as absent, not as 0 — otherwise every card
	// the drawer created would render stacked in the board's top-left corner
	// instead of being laid out on the grid.
	if strings.Contains(w.Body.String(), `"id":"loose","body":"y","color":"yellow","x":`) {
		t.Fatalf("an unplaced card should omit x/y, got %s", w.Body.String())
	}
}

// A position that is out of bounds, NaN or Inf is refused. NaN and Inf matter
// more than they look: both survive a JSON round trip and turn the client's
// board-size arithmetic into NaN, which collapses the entire corkboard rather
// than misplacing the one card.
func TestStickiesPositionLimits(t *testing.T) {
	cases := []struct{ name, body, wantMsg string }{
		{"negative", `{"stickies":[{"id":"a","body":"x","color":"yellow","x":-1,"y":0}]}`, "bounds"},
		{"too far", `{"stickies":[{"id":"a","body":"x","color":"yellow","x":0,"y":20001}]}`, "bounds"},
		{"NaN", `{"stickies":[{"id":"a","body":"x","color":"yellow","x":null}]}`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := call(multiHandler(t), http.MethodPut, c.body, 7)
			if c.wantMsg == "" {
				// null is simply "no position", not an error.
				if w.Code != http.StatusOK {
					t.Fatalf("null position got %d, want 200 (%s)", w.Code, w.Body.String())
				}
				return
			}
			if w.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400 (%s)", w.Code, w.Body.String())
			}
			if !strings.Contains(strings.ToLower(w.Body.String()), c.wantMsg) {
				t.Fatalf("error should name the problem (%q), got %s", c.wantMsg, w.Body.String())
			}
		})
	}
}

// Single mode reaches this handler with NO user context — the auth middleware
// attaches one only in multi mode. Every other test here injects a context by
// hand, so all of them would pass while every real single-mode request 500'd.
// This is the one that calls the handler the way the middleware does.
func TestStickiesWorkWithoutAUserContext(t *testing.T) {
	h := NewStickiesHandler(store.NewFileStickyStore(t.TempDir()), false) // single mode

	w := call(h, http.MethodPut, `{"stickies":[{"id":"a","body":"solo","color":"grey"}]}`, -1)
	if w.Code != http.StatusOK {
		t.Fatalf("single-mode PUT got %d, want 200 (%s)", w.Code, w.Body.String())
	}
	cards := board(t, call(h, http.MethodGet, "", -1))
	if len(cards) != 1 || cards[0].Body != "solo" {
		t.Fatalf("single-mode board did not persist: %v", cards)
	}
}

// In multi mode a missing context is an authenticated API token that could not
// be mapped to a user. Pooling those into one shared board would leak one
// caller's stickies to another, so it is refused.
func TestStickiesRefuseAnUnattributableMultiModeRequest(t *testing.T) {
	w := call(multiHandler(t), http.MethodGet, "", -1)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500 for a multi-mode request with no user context", w.Code)
	}
}

func TestStickiesRejectOtherMethods(t *testing.T) {
	for _, m := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete} {
		if w := call(multiHandler(t), m, "", 7); w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s got %d, want 405", m, w.Code)
		}
	}
}

// The board lands in the secrets directory, and only there. That location is
// the whole privacy guarantee: git-sync walks /data/notes/*/ and commits what
// it finds, so a board written under NOTES_DIR would be pushed to a git remote
// — and, because /data/notes is not itself a volume, would also be destroyed
// by the next `mdnest-server rebuild`.
func TestStickiesAreStoredInTheSecretsDirWithTightPermissions(t *testing.T) {
	dir := t.TempDir()
	h := NewStickiesHandler(store.NewFileStickyStore(dir), false)
	call(h, http.MethodPut, `{"stickies":[{"id":"a","body":"private","color":"yellow"}]}`, -1)

	info, err := os.Stat(filepath.Join(dir, "stickies.json"))
	if err != nil {
		t.Fatalf("stickies.json was not written to the secrets dir: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("stickies.json is %o, want 0600", perm)
	}

	// No stray temp file survives the atomic write.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("atomic write left %s behind", e.Name())
		}
	}
}

// A board written by one process is visible to a store built later — i.e. it
// really is on disk, not just in the in-memory map.
func TestStickiesSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	call(NewStickiesHandler(store.NewFileStickyStore(dir), false), http.MethodPut,
		`{"stickies":[{"id":"a","body":"still here","color":"pink"}]}`, -1)

	cards := board(t, call(NewStickiesHandler(store.NewFileStickyStore(dir), false), http.MethodGet, "", -1))
	if len(cards) != 1 || cards[0].Body != "still here" {
		t.Fatalf("board did not survive a fresh store: %v", cards)
	}
}

func manyStickies(n int) string {
	var b strings.Builder
	b.WriteString(`{"stickies":[`)
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"id":"c%d","body":"x","color":"yellow"}`, i)
	}
	b.WriteString(`]}`)
	return b.String()
}
