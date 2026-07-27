package collab

import (
	"encoding/json"
	"testing"
)

// linkBackplane wires two hubs together synchronously in-memory, mimicking a
// Redis pub/sub bus (each publish is delivered to the peer AND echoed back to
// the sender, whose onRemote filters its own Origin). It lets us exercise the
// cross-instance fan-out and presence merge without a real Redis.
type linkBackplane struct {
	selfDeliver func(wireMsg)
	peer        *linkBackplane
}

func (b *linkBackplane) Publish(m wireMsg) {
	if b.peer != nil && b.peer.selfDeliver != nil {
		b.peer.selfDeliver(m)
	}
	if b.selfDeliver != nil {
		b.selfDeliver(m) // echo, like Redis; onRemote drops Origin == self
	}
}
func (b *linkBackplane) Start(deliver func(wireMsg)) { b.selfDeliver = deliver }
func (b *linkBackplane) Close() error                { return nil }

// linkHubs connects two hubs through a synchronous in-memory backplane.
func linkHubs(a, b *Hub) {
	ba, bb := &linkBackplane{}, &linkBackplane{}
	ba.peer, bb.peer = bb, ba
	a.bp, b.bp = ba, bb
	ba.Start(a.onRemote)
	bb.Start(b.onRemote)
}

// newTestConn builds a Conn with a buffered send channel and no real
// WebSocket; Send only writes to the channel, which we inspect in tests.
func newTestConn(userID int, username string) *Conn {
	return NewConn(nil, userID, username)
}

// lastPresenceUsers drains a conn's send buffer and returns the Users of the
// most recent presence message it received (if any).
func lastPresenceUsers(c *Conn) ([]UserInfo, bool) {
	var users []UserInfo
	found := false
	for {
		select {
		case data := <-c.send:
			var m OutgoingMessage
			if json.Unmarshal(data, &m) == nil && m.Type == "presence" {
				users = m.Users
				found = true
			}
		default:
			return users, found
		}
	}
}

// hasMessageOfType reports whether the conn received a message of the given
// type, draining its buffer.
func hasMessageOfType(c *Conn, typ string) bool {
	found := false
	for {
		select {
		case data := <-c.send:
			var m OutgoingMessage
			if json.Unmarshal(data, &m) == nil && m.Type == typ {
				found = true
			}
		default:
			return found
		}
	}
}

func userIDs(users []UserInfo) map[int]bool {
	ids := make(map[int]bool, len(users))
	for _, u := range users {
		ids[u.ID] = true
	}
	return ids
}

// TestSingleInstancePresenceUnchanged verifies the default (nopBackplane) hub
// still reports only its local user — no behavior change when Redis is off.
func TestSingleInstancePresenceUnchanged(t *testing.T) {
	h := NewHub()
	cA := newTestConn(1, "alice")
	h.Join("ns", "note", cA)

	users, ok := lastPresenceUsers(cA)
	if !ok {
		t.Fatal("expected a presence message on join")
	}
	if len(users) != 1 || !userIDs(users)[1] {
		t.Fatalf("expected only alice present, got %+v", users)
	}
}

// TestCrossInstancePresenceMerge verifies option B: a user on instance A and a
// user on instance B, both on the same note, see each other in the merged
// participant list.
func TestCrossInstancePresenceMerge(t *testing.T) {
	h1, h2 := NewHub(), NewHub()
	linkHubs(h1, h2)

	cA := newTestConn(1, "alice") // on instance 1
	cB := newTestConn(2, "bob")   // on instance 2

	h1.Join("ns", "note", cA)
	h2.Join("ns", "note", cB)

	usersA, okA := lastPresenceUsers(cA)
	if !okA {
		t.Fatal("alice received no presence message")
	}
	idsA := userIDs(usersA)
	if !idsA[1] || !idsA[2] {
		t.Fatalf("alice should see both users, got %+v", usersA)
	}

	usersB, okB := lastPresenceUsers(cB)
	if !okB {
		t.Fatal("bob received no presence message")
	}
	idsB := userIDs(usersB)
	if !idsB[1] || !idsB[2] {
		t.Fatalf("bob should see both users, got %+v", usersB)
	}
}

// TestCrossInstanceFileChanged verifies a file-changed event on one instance
// reaches a connection on another instance (same note).
func TestCrossInstanceFileChanged(t *testing.T) {
	h1, h2 := NewHub(), NewHub()
	linkHubs(h1, h2)

	cA := newTestConn(1, "alice")
	cB := newTestConn(2, "bob")
	h1.Join("ns", "note", cA)
	h2.Join("ns", "note", cB)

	// Clear presence/join traffic buffered so far.
	_, _ = lastPresenceUsers(cA)
	_, _ = lastPresenceUsers(cB)

	h1.BroadcastFileChanged("ns", "note", 1, "alice", "etag123", "", "")

	if !hasMessageOfType(cB, "file-changed") {
		t.Fatal("bob (instance 2) did not receive the file-changed event")
	}
}

// TestCrossInstanceLeaveClearsPresence verifies that when the last local conn
// of a user leaves one instance, the peer drops that user from presence.
func TestCrossInstanceLeaveClearsPresence(t *testing.T) {
	h1, h2 := NewHub(), NewHub()
	linkHubs(h1, h2)

	cA := newTestConn(1, "alice")
	cB := newTestConn(2, "bob")
	h1.Join("ns", "note", cA)
	h2.Join("ns", "note", cB)
	_, _ = lastPresenceUsers(cB)

	h1.Leave("ns", "note", cA)

	usersB, ok := lastPresenceUsers(cB)
	if !ok {
		t.Fatal("bob received no presence update after alice left")
	}
	if userIDs(usersB)[1] {
		t.Fatalf("alice should be gone from bob's presence, got %+v", usersB)
	}
	if !userIDs(usersB)[2] {
		t.Fatalf("bob should still be present, got %+v", usersB)
	}
}
