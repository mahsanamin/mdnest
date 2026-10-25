package collab

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// Drains a conn's queue into binary frames and JSON control messages.
func drain(c *Conn) (frames [][]byte, ctrl []yjsControl) {
	for {
		select {
		case data := <-c.send:
			var m yjsControl
			if len(data) > 0 && data[0] == '{' && json.Unmarshal(data, &m) == nil {
				ctrl = append(ctrl, m)
			} else {
				frames = append(frames, data)
			}
		default:
			return
		}
	}
}

func roles(ctrl []yjsControl) (seed, saver, gotSaverMsg bool) {
	for _, m := range ctrl {
		if m.Type == "yjs-seed" {
			seed = true
		}
		if m.Type == "yjs-role" {
			saver = m.Saver
			gotSaverMsg = true
		}
	}
	return
}

func hasCtrl(ctrl []yjsControl, typ, errOrReason string) bool {
	for _, m := range ctrl {
		if m.Type == typ && (errOrReason == "" || m.Error == errOrReason || m.Reason == errOrReason) {
			return true
		}
	}
	return false
}

// Decodes a [4][lastSeq][len][data]... state frame.
func decodeState(t *testing.T, f []byte) (uint64, [][]byte) {
	t.Helper()
	if len(f) < 9 || f[0] != yjsTagState {
		t.Fatalf("not a state frame: %v", f)
	}
	last := binary.BigEndian.Uint64(f[1:9])
	var out [][]byte
	for p := 9; p < len(f); {
		n := int(binary.BigEndian.Uint32(f[p : p+4]))
		out = append(out, f[p+4:p+4+n])
		p += 4 + n
	}
	return last, out
}

func upd(b ...byte) []byte { return append([]byte{yjsTagUpdate}, b...) }

func sharedHub() *Hub {
	h := NewHub()
	h.EnableSharedEditing()
	return h
}

func hello(h *Hub, c *Conn) { h.HandleMessage("ns", "a.md", c, false, []byte(`{"type":"yjs-hello"}`)) }

func TestYjsFirstWriterSeedsAndSaves(t *testing.T) {
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	_, ctrl := drain(a)
	if seed, saver, _ := roles(ctrl); !seed || !saver {
		t.Fatalf("first writer should seed and save: %+v", ctrl)
	}
	hello(h, b)
	_, ctrl = drain(b)
	if seed, saver, _ := roles(ctrl); seed || saver {
		t.Fatalf("second joiner must not seed or save while the first is there: %+v", ctrl)
	}
	if !hasCtrl(ctrl, "yjs-ready", "") {
		t.Fatal("no yjs-ready")
	}
}

func TestYjsJoinGetsTheWholeLog(t *testing.T) {
	h := sharedHub()
	a := newTestConn(1, "a")
	hello(h, a)
	h.HandleMessage("ns", "a.md", a, true, upd(1, 2, 3))
	h.HandleMessage("ns", "a.md", a, true, upd(4))
	drain(a)

	b := newTestConn(2, "b")
	hello(h, b)
	frames, ctrl := drain(b)
	if len(frames) != 1 {
		t.Fatalf("want one state frame, got %d", len(frames))
	}
	last, entries := decodeState(t, frames[0])
	if last != 2 || len(entries) != 2 || !bytes.Equal(entries[0], []byte{1, 2, 3}) || !bytes.Equal(entries[1], []byte{4}) {
		t.Fatalf("state: last=%d entries=%v", last, entries)
	}
	for _, m := range ctrl {
		if m.Type == "yjs-ready" && !m.Seeded {
			t.Fatal("a room with updates must report seeded")
		}
	}
}

func TestYjsUpdatesAreRelayedWithSeq(t *testing.T) {
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	drain(a)
	drain(b)
	h.HandleMessage("ns", "a.md", a, true, upd(9, 9))
	fb, _ := drain(b)
	if len(fb) != 1 || fb[0][0] != yjsTagUpdate || binary.BigEndian.Uint64(fb[0][1:9]) != 1 || !bytes.Equal(fb[0][9:], []byte{9, 9}) {
		t.Fatalf("relay to b: %v", fb)
	}
	if fa, _ := drain(a); len(fa) != 0 {
		t.Fatalf("the sender must not get its own update back: %v", fa)
	}
	// Awareness is relayed stamped with the sender's account id (clients
	// name cursors from it, not from the update), and never stored.
	h.HandleMessage("ns", "a.md", a, true, []byte{yjsTagAwareness, 7})
	if fb, _ := drain(b); len(fb) != 1 || !bytes.Equal(fb[0], []byte{yjsTagAwareness, 0, 0, 0, 1, 7}) {
		t.Fatalf("awareness relay: %v", fb)
	}
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 1 {
		t.Fatalf("awareness was stored: %d entries", st.Entries)
	}
}

func TestYjsReadOnlyUpdatesAreDropped(t *testing.T) {
	h := sharedHub()
	w, ro := newTestConn(1, "w"), newTestConn(2, "ro")
	ro.ReadOnly = true
	hello(h, ro)
	_, ctrl := drain(ro)
	if seed, saver, _ := roles(ctrl); seed || saver {
		t.Fatalf("a read-only viewer must never seed or save: %+v", ctrl)
	}
	hello(h, w)
	drain(w)

	h.HandleMessage("ns", "a.md", ro, true, upd(6, 6, 6))
	h.HandleMessage("ns", "a.md", ro, true, []byte{yjsTagAwareness, 1})
	h.HandleMessage("ns", "a.md", ro, true, append([]byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 0}, 5))
	h.HandleMessage("ns", "a.md", ro, false, []byte(`{"type":"yjs-saved","recv":99}`))
	if fw, _ := drain(w); len(fw) != 0 {
		t.Fatalf("read-only frames were relayed: %v", fw)
	}
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 0 || st.Seeded {
		t.Fatalf("read-only update was stored: %+v", st)
	}
	// It still receives what writers send.
	h.HandleMessage("ns", "a.md", w, true, upd(1))
	if fr, _ := drain(ro); len(fr) != 1 {
		t.Fatalf("read-only viewer should receive updates: %v", fr)
	}
}

func TestYjsNonMemberAndOffAreIgnored(t *testing.T) {
	h := sharedHub()
	a, stranger := newTestConn(1, "a"), newTestConn(2, "s")
	hello(h, a)
	drain(a)
	h.HandleMessage("ns", "a.md", stranger, true, upd(1))
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 0 {
		t.Fatal("an update from a connection that never joined was stored")
	}

	off := NewHub()
	c := newTestConn(3, "c")
	off.HandleMessage("ns", "a.md", c, false, []byte(`{"type":"yjs-hello"}`))
	_, ctrl := drain(c)
	if !hasCtrl(ctrl, "yjs-error", "off") {
		t.Fatalf("shared editing off must say so: %+v", ctrl)
	}
	off.HandleMessage("ns", "a.md", c, true, upd(1))
	if _, ok := off.roomStats("ns", "a.md"); ok {
		t.Fatal("a room exists with shared editing off")
	}
}

func TestYjsRoomConnCap(t *testing.T) {
	defer func(n int) { YjsMaxRoomConns = n }(YjsMaxRoomConns)
	YjsMaxRoomConns = 2
	h := sharedHub()
	a, b, c := newTestConn(1, "a"), newTestConn(2, "b"), newTestConn(3, "c")
	hello(h, a)
	hello(h, b)
	hello(h, c)
	_, ctrl := drain(c)
	if !hasCtrl(ctrl, "yjs-error", "room-full") {
		t.Fatalf("third joiner should be refused: %+v", ctrl)
	}
	h.HandleMessage("ns", "a.md", c, true, upd(1))
	if st, _ := h.roomStats("ns", "a.md"); st.Members != 2 || st.Entries != 0 {
		t.Fatalf("refused joiner got in: %+v", st)
	}
}

func TestYjsRoomByteCap(t *testing.T) {
	defer func(n int) { YjsMaxLogBytes = n }(YjsMaxLogBytes)
	YjsMaxLogBytes = 10
	h := sharedHub()
	a := newTestConn(1, "a")
	hello(h, a)
	drain(a)
	h.HandleMessage("ns", "a.md", a, true, upd(make([]byte, 8)...))
	h.HandleMessage("ns", "a.md", a, true, upd(make([]byte, 8)...))
	_, ctrl := drain(a)
	if !hasCtrl(ctrl, "yjs-error", "room-too-big") {
		t.Fatalf("update past the cap should be refused: %+v", ctrl)
	}
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 1 || st.Bytes != 8 {
		t.Fatalf("stats after cap: %+v", st)
	}
}

func TestYjsRoomFreedOnLeave(t *testing.T) {
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	h.HandleMessage("ns", "a.md", a, true, upd(1))
	// The saver says it saved everything it had.
	h.HandleMessage("ns", "a.md", a, false, []byte(`{"type":"yjs-saved","recv":0,"own":1}`))
	h.YjsLeave("ns", "a.md", a)
	if _, ok := h.roomStats("ns", "a.md"); !ok {
		t.Fatal("room freed while b is still in it")
	}
	h.YjsLeave("ns", "a.md", b)
	if _, ok := h.roomStats("ns", "a.md"); ok {
		t.Fatal("room not freed after the last person left with nothing unsaved")
	}
}

func TestYjsUnsavedRoomIsKeptThenFreed(t *testing.T) {
	defer func(d time.Duration) { yjsUnsavedGrace = d }(yjsUnsavedGrace)
	yjsUnsavedGrace = 50 * time.Millisecond
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	h.HandleMessage("ns", "a.md", a, true, upd(1))
	h.HandleMessage("ns", "a.md", a, false, []byte(`{"type":"yjs-saved","recv":0,"own":1}`))
	h.HandleMessage("ns", "a.md", b, true, upd(2)) // never saved
	h.YjsLeave("ns", "a.md", a)
	h.YjsLeave("ns", "a.md", b)
	if _, ok := h.roomStats("ns", "a.md"); !ok {
		t.Fatal("a room with unsaved updates was freed at once")
	}
	// Someone coming back inside the grace keeps it alive.
	c := newTestConn(3, "c")
	hello(h, c)
	frames, ctrl := drain(c)
	if _, entries := decodeState(t, frames[0]); len(entries) != 2 {
		t.Fatalf("returning user should get the unsaved state, got %d entries", len(entries))
	}
	if _, saver, _ := roles(ctrl); !saver {
		t.Fatal("returning writer should be the saver, so it saves the pending text")
	}
	h.YjsLeave("ns", "a.md", c)
	time.Sleep(150 * time.Millisecond)
	if _, ok := h.roomStats("ns", "a.md"); ok {
		t.Fatal("room with unsaved updates never freed after the grace")
	}
}

func TestYjsSaverHandover(t *testing.T) {
	defer func(d time.Duration) { yjsSaverIdle = d }(yjsSaverIdle)
	yjsSaverIdle = time.Hour
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	drain(a)
	drain(b)
	// a types, then b types: a is not idle, so a stays the saver.
	h.HandleMessage("ns", "a.md", a, true, upd(1))
	h.HandleMessage("ns", "a.md", b, true, upd(2))
	if _, _, got := roles(func() []yjsControl { _, c := drain(b); return c }()); got {
		t.Fatal("saver flipped to b while a was still typing")
	}
	// a goes quiet: the next update from b takes the role.
	yjsSaverIdle = 0
	h.HandleMessage("ns", "a.md", b, true, upd(3))
	_, cb := drain(b)
	_, ca := drain(a)
	if _, saver, got := roles(cb); !got || !saver {
		t.Fatalf("b should become the saver: %+v", cb)
	}
	if _, saver, got := roles(ca); !got || saver {
		t.Fatalf("a should be told it no longer saves: %+v", ca)
	}
	// b leaves: a takes over and is told so.
	h.YjsLeave("ns", "a.md", b)
	_, ca = drain(a)
	if _, saver, got := roles(ca); !got || !saver {
		t.Fatalf("a should take over saving when b leaves: %+v", ca)
	}
}

func TestYjsSeederLeavingHandsSeedOn(t *testing.T) {
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	drain(b)
	h.YjsLeave("ns", "a.md", a)
	_, ctrl := drain(b)
	if seed, _, _ := roles(ctrl); !seed {
		t.Fatalf("b should be asked to seed after the seeder left unseeded: %+v", ctrl)
	}
}

func TestYjsSnapshotReplacesTheLog(t *testing.T) {
	defer func(n int) { yjsCompactMin = n }(yjsCompactMin)
	yjsCompactMin = 4
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	for i := 0; i < 3; i++ {
		h.HandleMessage("ns", "a.md", a, true, upd(1, 1, 1))
	}
	_, ca := drain(a)
	if !hasCtrl(ca, "yjs-compact", "") {
		t.Fatalf("saver not asked to compact: %+v", ca)
	}
	// One more update lands after the saver took its snapshot at seq 3.
	h.HandleMessage("ns", "a.md", b, true, upd(2))
	snap := []byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 3, 'S'}
	// Only the saver's snapshot counts.
	h.HandleMessage("ns", "a.md", b, true, snap)
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 4 {
		t.Fatalf("a non-saver's snapshot was accepted: %+v", st)
	}
	h.HandleMessage("ns", "a.md", a, true, snap)
	c := newTestConn(3, "c")
	hello(h, c)
	frames, _ := drain(c)
	last, entries := decodeState(t, frames[0])
	if last != 4 || len(entries) != 2 || string(entries[0]) != "S" || !bytes.Equal(entries[1], []byte{2}) {
		t.Fatalf("after compaction: last=%d entries=%q", last, entries)
	}
	// A snapshot claiming more than the log has is refused.
	h.HandleMessage("ns", "a.md", a, true, []byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 99, 'X'})
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 2 {
		t.Fatalf("bad snapshot accepted: %+v", st)
	}
}

func TestYjsContentIgnoredForMembers(t *testing.T) {
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	h.Join("ns", "a.md", a)
	h.Join("ns", "a.md", b)
	hello(h, a)
	drain(a)
	drain(b)
	h.HandleMessage("ns", "a.md", a, false, []byte(`{"type":"content","content":"whole doc"}`))
	_, cb := drain(b)
	for _, m := range cb {
		if m.Type == "content" {
			t.Fatal("a shared-room member's whole-document content was relayed")
		}
	}
	// Someone on the old path still relays.
	c := newTestConn(3, "c")
	h.Join("ns", "a.md", c)
	drain(b)
	h.HandleMessage("ns", "a.md", c, false, []byte(`{"type":"content","content":"x"}`))
	got := false
	for {
		select {
		case d := <-b.send:
			if bytes.Contains(d, []byte(`"type":"content"`)) {
				got = true
			}
			continue
		default:
		}
		break
	}
	if !got {
		t.Fatal("old-path content no longer relayed")
	}
}

func TestYjsCloseMissingRooms(t *testing.T) {
	h := sharedHub()
	a := newTestConn(1, "a")
	hello(h, a)
	drain(a)
	h.CloseMissingRooms("ns", func(p string) bool { return p != "a.md" })
	_, ctrl := drain(a)
	if !hasCtrl(ctrl, "yjs-closed", "missing") {
		t.Fatalf("members of a moved note's room not told: %+v", ctrl)
	}
	if _, ok := h.roomStats("ns", "a.md"); ok {
		t.Fatal("room for a missing note still open")
	}
	// Updates after the close go nowhere.
	h.HandleMessage("ns", "a.md", a, true, upd(1))
	if _, ok := h.roomStats("ns", "a.md"); ok {
		t.Fatal("an update re-created a closed room")
	}
}

func TestSharedEditingEnabled(t *testing.T) {
	cases := []struct {
		set, role string
		want      bool
	}{
		{"", "single", true}, {"true", "single", true}, {"false", "single", false},
		{"off", "writer", false}, {"", "app", false}, {"true", "app", false},
	}
	for _, c := range cases {
		if got := SharedEditingEnabled(c.set, c.role); got != c.want {
			t.Errorf("SharedEditingEnabled(%q,%q)=%v want %v", c.set, c.role, got, c.want)
		}
	}
}

func TestYjsFramesGoOutAsBinary(t *testing.T) {
	h := sharedHub()
	a := newTestConn(1, "a")
	hello(h, a)
	h.HandleMessage("ns", "a.md", a, true, upd(0xff, 0xfe))
	b := newTestConn(2, "b")
	hello(h, b)
	frames, _ := drain(b)
	if frameType(frames[0]) != websocket.MessageBinary {
		t.Fatal("a state frame would be written as text; browsers drop the connection on invalid UTF-8")
	}
	if frameType([]byte(`{"type":"presence"}`)) != websocket.MessageText {
		t.Fatal("JSON must stay a text frame")
	}
}

func TestYjsNoRoomForAMissingNote(t *testing.T) {
	h := sharedHub()
	h.SetNoteExists(func(ns, p string) bool { return p == "real.md" })
	c := newTestConn(1, "c")
	h.HandleMessage("ns", "made-up.md", c, false, []byte(`{"type":"yjs-hello"}`))
	_, ctrl := drain(c)
	if !hasCtrl(ctrl, "yjs-error", "missing") {
		t.Fatalf("a room was offered for a note that does not exist: %+v", ctrl)
	}
	if _, ok := h.roomStats("ns", "made-up.md"); ok {
		t.Fatal("room created for a missing note")
	}
	h.HandleMessage("ns", "real.md", c, false, []byte(`{"type":"yjs-hello"}`))
	if _, ok := h.roomStats("ns", "real.md"); !ok {
		t.Fatal("no room for a real note")
	}
}

func TestYjsServerWideBudget(t *testing.T) {
	defer func(n int) { YjsMaxTotalBytes = n }(YjsMaxTotalBytes)
	YjsMaxTotalBytes = 10
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	h.HandleMessage("ns", "one.md", a, false, []byte(`{"type":"yjs-hello"}`))
	h.HandleMessage("ns", "two.md", b, false, []byte(`{"type":"yjs-hello"}`))
	h.HandleMessage("ns", "one.md", a, true, upd(make([]byte, 8)...))
	h.HandleMessage("ns", "two.md", b, true, upd(make([]byte, 8)...))
	_, cb := drain(b)
	if !hasCtrl(cb, "yjs-error", "server-full") {
		t.Fatalf("second room's update should hit the server budget: %+v", cb)
	}
	// Freeing a room gives its bytes back.
	h.HandleMessage("ns", "one.md", a, false, []byte(`{"type":"yjs-saved","recv":0,"own":1}`))
	h.YjsLeave("ns", "one.md", a)
	h.HandleMessage("ns", "two.md", b, true, upd(make([]byte, 8)...))
	if st, _ := h.roomStats("ns", "two.md"); st.Entries != 1 {
		t.Fatalf("budget not returned when a room was freed: %+v", st)
	}
}

func TestYjsPerUserBudget(t *testing.T) {
	defer func(n int) { YjsMaxUserBytes = n }(YjsMaxUserBytes)
	YjsMaxUserBytes = 10
	h := sharedHub()
	a1, a2, b := newTestConn(1, "a"), newTestConn(1, "a"), newTestConn(2, "b")
	h.HandleMessage("ns", "one.md", a1, false, []byte(`{"type":"yjs-hello"}`))
	h.HandleMessage("ns", "two.md", a2, false, []byte(`{"type":"yjs-hello"}`))
	h.HandleMessage("ns", "two.md", b, false, []byte(`{"type":"yjs-hello"}`))
	h.HandleMessage("ns", "one.md", a1, true, upd(make([]byte, 8)...))
	h.HandleMessage("ns", "two.md", a2, true, upd(make([]byte, 8)...))
	_, ca := drain(a2)
	if !hasCtrl(ca, "yjs-error", "server-full") {
		t.Fatalf("one account passed its share across rooms: %+v", ca)
	}
	// Someone else is not affected.
	h.HandleMessage("ns", "two.md", b, true, upd(make([]byte, 8)...))
	if st, _ := h.roomStats("ns", "two.md"); st.Entries != 1 {
		t.Fatalf("another account was refused: %+v", st)
	}
}

func TestYjsSnapshotIsHeldToTheCaps(t *testing.T) {
	defer func(n, m int) { YjsMaxLogBytes, yjsCompactMin = n, m }(YjsMaxLogBytes, yjsCompactMin)
	yjsCompactMin = 1
	h := sharedHub()
	a := newTestConn(1, "a")
	hello(h, a)
	h.HandleMessage("ns", "a.md", a, true, upd(1))
	h.HandleMessage("ns", "a.md", a, true, upd(2))
	YjsMaxLogBytes = 4
	h.HandleMessage("ns", "a.md", a, true, append([]byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 2}, make([]byte, 10)...))
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 2 {
		t.Fatalf("an oversized snapshot replaced the log: %+v", st)
	}
	YjsMaxLogBytes = 1 << 20
	// The refusal re-arms the request; the next update asks again.
	h.HandleMessage("ns", "a.md", a, true, upd(3))
	h.HandleMessage("ns", "a.md", a, true, []byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 3, 'S'})
	// A later snapshot may not claim an older point than the last one.
	h.HandleMessage("ns", "a.md", a, true, []byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 1, 'T'})
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 1 || st.Bytes != 1 {
		t.Fatalf("snapshots piled up: %+v", st)
	}
	if h.yjsBytes != 1 || h.userBytes[1] != 0 || h.userBytes[roomUID] != 1 {
		t.Fatalf("budget not kept in step with compaction: total=%d user=%d", h.yjsBytes, h.userBytes[1])
	}
}

func TestYjsRefusedSnapshotIsAskedForAgain(t *testing.T) {
	defer func(n, m int) { yjsCompactMin, YjsMaxLogBytes = n, m }(yjsCompactMin, YjsMaxLogBytes)
	yjsCompactMin = 2
	h := sharedHub()
	a := newTestConn(1, "a")
	hello(h, a)
	h.HandleMessage("ns", "a.md", a, true, upd(1, 1, 1))
	_, ctrl := drain(a)
	if !hasCtrl(ctrl, "yjs-compact", "") {
		t.Fatal("not asked to compact")
	}
	YjsMaxLogBytes = 5
	h.HandleMessage("ns", "a.md", a, true, append([]byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 1}, make([]byte, 9)...))
	YjsMaxLogBytes = 1 << 20
	h.HandleMessage("ns", "a.md", a, true, upd(2))
	_, ctrl = drain(a)
	if !hasCtrl(ctrl, "yjs-compact", "") {
		t.Fatal("after a refused snapshot the saver is never asked again")
	}
}

func TestYjsSnapshotOnlyWhenAskedAndNoBigger(t *testing.T) {
	defer func(n int) { yjsCompactMin = n }(yjsCompactMin)
	h := sharedHub()
	a := newTestConn(1, "a")
	hello(h, a)
	h.HandleMessage("ns", "a.md", a, true, upd(1, 1, 1, 1))
	// Not asked yet (the log is under the compaction threshold).
	h.HandleMessage("ns", "a.md", a, true, []byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 1, 'S'})
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 1 || st.Bytes != 4 {
		t.Fatalf("an unrequested snapshot was taken: %+v", st)
	}
	yjsCompactMin = 2
	h.HandleMessage("ns", "a.md", a, true, upd(2))
	drain(a)
	// Asked, but bigger than the 5 bytes the room holds.
	h.HandleMessage("ns", "a.md", a, true, append([]byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 2}, make([]byte, 6)...))
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 2 {
		t.Fatalf("a snapshot bigger than the log was taken: %+v", st)
	}
	h.HandleMessage("ns", "a.md", a, true, upd(3)) // asks again
	h.HandleMessage("ns", "a.md", a, true, []byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 3, 'S'})
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 1 {
		t.Fatalf("the requested snapshot was refused: %+v", st)
	}
	// One request, one snapshot.
	h.HandleMessage("ns", "a.md", a, true, []byte{yjsTagSnapshot, 0, 0, 0, 0, 0, 0, 0, 3, 'T'})
	if st, _ := h.roomStats("ns", "a.md"); st.Entries != 1 || st.Bytes != 1 {
		t.Fatalf("a second snapshot without a request was taken: %+v", st)
	}
}

// A saver that never saves (a socket the tab lost but the server still holds,
// a frozen tab) loses the role once an update has gone unsaved for
// yjsSaverStuck, even though nobody typed after the idle window. Before this
// the reconnected tab typed within yjsSaverIdle of the old socket's last
// edit, the old socket stayed the saver, and nothing reached the file.
func TestYjsStuckSaverLosesTheRole(t *testing.T) {
	defer func(i, s time.Duration) { yjsSaverIdle, yjsSaverStuck = i, s }(yjsSaverIdle, yjsSaverStuck)
	yjsSaverIdle, yjsSaverStuck = time.Hour, 80*time.Millisecond
	h := sharedHub()
	ghost, tab := newTestConn(1, "a"), newTestConn(1, "a")
	hello(h, ghost)
	h.HandleMessage("ns", "a.md", ghost, true, upd(1))
	h.YjsSaved("ns", "a.md", ghost, 1, 1)
	hello(h, tab)
	drain(ghost)
	drain(tab)
	h.HandleMessage("ns", "a.md", ghost, true, upd(2)) // its last edit; then it goes silent
	h.HandleMessage("ns", "a.md", tab, true, upd(3))
	if _, _, got := roles(func() []yjsControl { _, c := drain(tab); return c }()); got {
		t.Fatal("the role moved before the saver was stuck")
	}
	time.Sleep(3 * yjsSaverStuck)
	if _, saver, got := roles(func() []yjsControl { _, c := drain(tab); return c }()); !got || !saver {
		t.Fatal("a saver that never saved kept the role")
	}
	if _, saver, got := roles(func() []yjsControl { _, c := drain(ghost); return c }()); !got || saver {
		t.Fatal("the stuck saver was not told it no longer saves")
	}
	// The new saver saves: the watch stops, and the role stays where it is.
	h.YjsSaved("ns", "a.md", tab, 3, 1)
	time.Sleep(3 * yjsSaverStuck)
	if _, _, got := roles(func() []yjsControl { _, c := drain(ghost); return c }()); got {
		t.Fatal("the role moved again after everything was saved")
	}
	h.ymu.Lock()
	timer := h.rooms[noteKey("ns", "a.md")].stuckTimer
	h.ymu.Unlock()
	if timer != nil {
		t.Error("the watch kept running with nothing unsaved")
	}
}

// The writer whose text went unsaved left the note before the check ran, and
// comes back later: the check keeps running while the text is unsaved, so the
// returning tab gets the role and saves it.
func TestYjsStuckSaverHandsOverToAWriterWhoComesBack(t *testing.T) {
	defer func(i, s time.Duration) { yjsSaverIdle, yjsSaverStuck = i, s }(yjsSaverIdle, yjsSaverStuck)
	yjsSaverIdle, yjsSaverStuck = time.Hour, 80*time.Millisecond
	h := sharedHub()
	ghost, tab := newTestConn(1, "a"), newTestConn(1, "a")
	hello(h, ghost)
	hello(h, tab)
	h.HandleMessage("ns", "a.md", ghost, true, upd(1))
	h.HandleMessage("ns", "a.md", tab, true, upd(2))
	h.YjsLeave("ns", "a.md", tab)
	time.Sleep(3 * yjsSaverStuck)
	back := newTestConn(1, "a")
	hello(h, back)
	drain(back)
	time.Sleep(3 * yjsSaverStuck)
	if _, saver, got := roles(func() []yjsControl { _, c := drain(back); return c }()); !got || !saver {
		t.Fatal("the returning writer never got the role to save the unsaved text")
	}
}

// A saver that saves keeps the role, however long others type.
func TestYjsHealthySaverKeepsTheRole(t *testing.T) {
	defer func(i, s time.Duration) { yjsSaverIdle, yjsSaverStuck = i, s }(yjsSaverIdle, yjsSaverStuck)
	yjsSaverIdle, yjsSaverStuck = time.Hour, 80*time.Millisecond
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	h.HandleMessage("ns", "a.md", a, true, upd(1))
	drain(a)
	drain(b)
	for i := byte(0); i < 6; i++ {
		h.HandleMessage("ns", "a.md", b, true, upd(10+i))
		h.YjsSaved("ns", "a.md", a, uint64(2+i), 1)
		time.Sleep(yjsSaverStuck / 2)
	}
	if _, _, got := roles(func() []yjsControl { _, c := drain(b); return c }()); got {
		t.Fatal("the role left a saver that was saving")
	}
}

// Everyone dropped and came back: the unsaved updates are older than
// yjsSaverStuck, but the writer who came back first only just got the role
// (it merges the file before it binds), so it keeps it for a full
// yjsSaverStuck. Judging it from the updates' age took the role away
// mid-join (live-never-blocks (h), throttled).
func TestYjsNewSaverGetsAFullWindow(t *testing.T) {
	defer func(i, s time.Duration) { yjsSaverIdle, yjsSaverStuck = i, s }(yjsSaverIdle, yjsSaverStuck)
	yjsSaverIdle, yjsSaverStuck = time.Hour, 150*time.Millisecond
	h := sharedHub()
	a, b := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a)
	hello(h, b)
	h.HandleMessage("ns", "a.md", a, true, upd(1))
	h.HandleMessage("ns", "a.md", b, true, upd(2))
	h.YjsLeave("ns", "a.md", a)
	h.YjsLeave("ns", "a.md", b)
	time.Sleep(2 * yjsSaverStuck) // the updates are now old and unsaved
	a2, b2 := newTestConn(1, "a"), newTestConn(2, "b")
	hello(h, a2) // first back: the saver
	hello(h, b2)
	drain(a2)
	time.Sleep(yjsSaverStuck / 2)
	if _, _, got := roles(func() []yjsControl { _, c := drain(a2); return c }()); got {
		t.Fatal("the saver who just came back lost the role before its window was up")
	}
}
