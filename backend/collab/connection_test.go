package collab

import (
	"encoding/json"
	"testing"
	"time"
)

// A connection that serves a whole visit and moves between notes with join
// messages (v4.8.13). The check itself is the caller's Authorizer; these pin
// what the connection does with its answer, and that rooms and budgets stay
// right when one socket moves.

func allowAll(ns, p string) (string, bool, string) { return p, false, "" }

func sessionConn(id int, name string, auth Authorizer) *Conn {
	c := newTestConn(id, name)
	c.Authorize = auth
	return c
}

func joinMsg(ns, path string, seq int) []byte {
	b, _ := json.Marshal(map[string]any{"type": "join", "ns": ns, "path": path, "seq": seq})
	return b
}

// noteMsgs returns the join answers and note-left messages queued for c.
func noteMsgs(c *Conn) (out []noteMsg) {
	for _, data := range c.TakeQueued() {
		var m noteMsg
		if len(data) > 0 && data[0] == '{' && json.Unmarshal(data, &m) == nil {
			switch m.Type {
			case "joined", "join-error", "note-left":
				out = append(out, m)
			}
		}
	}
	return out
}

func TestConnJoinMovesBetweenNotesAndRooms(t *testing.T) {
	h := sharedHub()
	a := sessionConn(1, "a", allowAll)
	a.handle(h, false, joinMsg("ns", "a.md", 1))
	if ms := noteMsgs(a); len(ms) != 1 || ms[0].Type != "joined" || ms[0].Seq != 1 {
		t.Fatalf("join answer: %+v", ms)
	}
	a.handle(h, false, []byte(`{"type":"yjs-hello"}`))
	a.handle(h, true, upd(1, 2, 3))
	h.HandleMessage("ns", "a.md", a, false, []byte(`{"type":"yjs-saved","recv":1}`))
	if h.yjsBytes != 3 || h.userBytes[1] != 3 {
		t.Fatalf("budget after one update: total %d, user %d", h.yjsBytes, h.userBytes[1])
	}

	// Moving to another note leaves the old room: a saved room is freed and
	// its bytes go back to both budgets.
	a.handle(h, false, joinMsg("ns", "b.md", 2))
	if _, ok := h.roomStats("ns", "a.md"); ok {
		t.Fatal("the old room was kept after its only member moved on")
	}
	if h.yjsBytes != 0 || len(h.userBytes) != 0 {
		t.Fatalf("budget not returned: total %d, per user %v", h.yjsBytes, h.userBytes)
	}
	if ns, p, ok := a.Note(); !ok || ns != "ns" || p != "b.md" {
		t.Fatalf("note after the switch: %s %s %v", ns, p, ok)
	}
	// Frames now go to b.md's room, never to a.md's.
	a.handle(h, false, []byte(`{"type":"yjs-hello"}`))
	a.handle(h, true, upd(7))
	if st, ok := h.roomStats("ns", "b.md"); !ok || st.Entries != 1 || st.Members != 1 {
		t.Fatalf("b.md room: %+v %v", st, ok)
	}

	// An unsaved room stays for its grace period, still counted, and is
	// freed after it.
	old := yjsUnsavedGrace
	yjsUnsavedGrace = 50 * time.Millisecond
	defer func() { yjsUnsavedGrace = old }()
	a.handle(h, false, joinMsg("ns", "c.md", 3))
	if st, ok := h.roomStats("ns", "b.md"); !ok || st.Members != 0 {
		t.Fatalf("an unsaved room was not kept: %+v %v", st, ok)
	}
	time.Sleep(150 * time.Millisecond)
	h.ymu.Lock()
	total, user := h.yjsBytes, h.userBytes[1]
	h.ymu.Unlock()
	if total != 0 || user != 0 {
		t.Fatalf("budget held after the grace period: total %d, user %d", total, user)
	}
}

func TestConnMessagesOutsideANoteAreIgnored(t *testing.T) {
	h := sharedHub()
	other := newTestConn(2, "b")
	h.Join("ns", "a.md", other)
	hello(h, other)
	other.TakeQueued()
	a := sessionConn(1, "a", allowAll)
	a.handle(h, false, []byte(`{"type":"content","content":"X"}`))
	a.handle(h, false, []byte(`{"type":"yjs-hello"}`))
	a.handle(h, true, upd(1))
	if q := other.TakeQueued(); len(q) != 0 {
		t.Fatalf("a socket in no note reached a note: %d messages", len(q))
	}
}

func TestConnRefusedJoinLeavesTheOldNote(t *testing.T) {
	h := NewHub()
	auth := func(ns, p string) (string, bool, string) {
		if p == "secret.md" {
			return "", false, "forbidden"
		}
		return p, false, ""
	}
	a := sessionConn(1, "a", auth)
	a.handle(h, false, joinMsg("ns", "a.md", 1))
	a.handle(h, false, joinMsg("ns", "secret.md", 2))
	ms := noteMsgs(a)
	if len(ms) != 2 || ms[1].Type != "join-error" || ms[1].Error != "forbidden" || ms[1].Seq != 2 {
		t.Fatalf("answers: %+v", ms)
	}
	if _, _, ok := a.Note(); ok {
		t.Fatal("still in the old note after a refused join")
	}
	if n := h.countUsers(noteKey("ns", "a.md")); n != 0 {
		t.Fatalf("a.md still counts %d users", n)
	}
	// A nil Authorize refuses every join.
	b := newTestConn(2, "b")
	b.handle(h, false, joinMsg("ns", "a.md", 3))
	if ms := noteMsgs(b); len(ms) != 1 || ms[0].Type != "join-error" {
		t.Fatalf("a connection with no checker joined: %+v", ms)
	}
}

func TestConnJoinsAreRateLimited(t *testing.T) {
	h := NewHub()
	a := sessionConn(1, "a", allowAll)
	refused := 0
	for i := 0; i < 50; i++ {
		a.handle(h, false, joinMsg("ns", []string{"a.md", "b.md"}[i%2], i+1))
	}
	for _, m := range noteMsgs(a) {
		if m.Type == "join-error" && m.Error == "rate" {
			refused++
		}
	}
	if refused < 20 {
		t.Fatalf("only %d of 50 joins in a burst were refused", refused)
	}
	time.Sleep(200 * time.Millisecond)
	a.handle(h, false, joinMsg("ns", "c.md", 99))
	if ms := noteMsgs(a); len(ms) != 1 || ms[0].Type != "joined" {
		t.Fatalf("a join after a pause: %+v", ms)
	}
}

func TestConnDropUsersLeavesOnlyThatNote(t *testing.T) {
	h := NewHub()
	a := sessionConn(1, "a", allowAll)
	a.handle(h, false, joinMsg("ns", "chat.md", 1))
	noteMsgs(a)
	h.DropUsers("ns", "chat.md", func(int) bool { return false })
	ms := noteMsgs(a)
	if len(ms) != 1 || ms[0].Type != "note-left" || ms[0].Path != "chat.md" {
		t.Fatalf("after DropUsers: %+v", ms)
	}
	if _, _, ok := a.Note(); ok {
		t.Fatal("still in the note")
	}
	a.handle(h, false, joinMsg("ns", "other.md", 2))
	if ms := noteMsgs(a); len(ms) != 1 || ms[0].Type != "joined" {
		t.Fatalf("the socket could not go on to another note: %+v", ms)
	}
}

func TestConnRecheckAfterAccessChanged(t *testing.T) {
	h := NewHub()
	allowed := true
	auth := func(ns, p string) (string, bool, string) {
		if !allowed {
			return "", false, "forbidden"
		}
		return p, false, ""
	}
	a := sessionConn(1, "a", auth)
	h.addConn(a)
	a.handle(h, false, joinMsg("ns", "a.md", 1))
	noteMsgs(a)
	h.RecheckAccess()
	if ms := noteMsgs(a); len(ms) != 0 {
		t.Fatalf("a recheck with access unchanged moved the socket: %+v", ms)
	}
	allowed = false
	h.RecheckAccess()
	if ms := noteMsgs(a); len(ms) != 1 || ms[0].Type != "note-left" || ms[0].Reason != "access" {
		t.Fatalf("after access was removed: %+v", ms)
	}
}

func TestConnRefusesJoinsAfterTheTokenExpires(t *testing.T) {
	h := NewHub()
	a := sessionConn(1, "a", allowAll)
	a.Expires = time.Now().Add(-time.Second)
	a.handle(h, false, joinMsg("ns", "a.md", 1))
	if ms := noteMsgs(a); len(ms) != 1 || ms[0].Type != "join-error" || ms[0].Error != "expired" {
		t.Fatalf("a join after expiry: %+v", ms)
	}
	if _, _, ok := a.Note(); ok {
		t.Fatal("joined after expiry")
	}
}

// DropUsers checks again, through Authorize, every connection that ended up
// in the note, so a join that passed the old member list cannot stay.
func TestConnDropUsersRechecksThroughAuthorize(t *testing.T) {
	h := NewHub()
	member := true
	auth := func(ns, p string) (string, bool, string) {
		if p == "chat.md" && !member {
			return "", false, "forbidden"
		}
		return p, false, ""
	}
	a := sessionConn(1, "a", auth)
	h.addConn(a)
	a.handle(h, false, joinMsg("ns", "chat.md", 1))
	noteMsgs(a)
	member = false
	// keep says yes (the stale list the caller read), Authorize says no.
	h.DropUsers("ns", "chat.md", func(int) bool { return true })
	if ms := noteMsgs(a); len(ms) != 1 || ms[0].Type != "note-left" {
		t.Fatalf("a connection the checker refuses stayed in the note: %+v", ms)
	}
}
