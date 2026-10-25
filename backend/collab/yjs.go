package collab

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"strings"
	"time"
)

// Shared editing rooms (Yjs).
//
// When shared editing is on, the browsers editing a markdown note keep one
// Yjs document between them. The server never parses Yjs: it relays opaque
// binary updates between the people in a note, and keeps the updates it has
// seen so someone who joins later gets the whole document. Files stay the
// source of truth: one browser per room (the "saver") writes the markdown
// through the ordinary PUT /api/note.
//
// Frames, client to server (binary websocket messages):
//
//	[1][update]                 a Yjs document update
//	[2][awareness]              a cursor/selection (awareness) update, relayed only
//	[3][ackSeq u64][snapshot]   the saver's compacted state, covering every
//	                            update up to ackSeq; replaces those log entries
//
// Frames, server to client:
//
//	[1][seq u64][update]        a relayed update and its position in the log
//	[2][userID u32][awareness]  a relayed awareness update, stamped with the
//	                            sender's account id by the server: clients
//	                            label a cursor from that id, never from the
//	                            name inside the update, which the sender wrote
//	[4][lastSeq u64]{[len u32][update]}*   the whole log, sent once on join
//
// Control messages are JSON text frames: yjs-hello, yjs-saved and yjs-leave
// from the client; yjs-seed, yjs-role, yjs-ready, yjs-compact, yjs-error and
// yjs-closed from the server.
//
// Single box only: rooms live in this process's memory. Several backend
// replicas would each keep their own room for the same note, so shared
// editing is switched off on MDNEST_ROLE=app and in a multi-replica Helm
// install (see docs/architecture.md).

const (
	yjsTagUpdate    byte = 1
	yjsTagAwareness byte = 2
	yjsTagSnapshot  byte = 3
	yjsTagState     byte = 4
)

// Room limits. Package variables so tests can shrink them.
var (
	// YjsMaxRoomConns caps how many connections can share one note.
	YjsMaxRoomConns = 32
	// YjsMaxLogBytes is the most update data one room keeps. An update that
	// would pass it is refused; the saver is asked to compact well before.
	YjsMaxLogBytes = 32 << 20
	// YjsMaxTotalBytes caps update data across every room on the server,
	// so many rooms (or rooms kept after everyone left) cannot add up to an
	// unbounded amount of memory.
	YjsMaxTotalBytes = 256 << 20
	// YjsMaxUserBytes caps what one account's updates may hold across all
	// rooms, so one person cannot use up the server-wide budget for everyone.
	YjsMaxUserBytes = 64 << 20
	// YjsMaxFrameBytes is the largest single frame accepted (a big paste or a
	// snapshot). The websocket read limit is set to this for every
	// connection when shared editing is on.
	YjsMaxFrameBytes int64 = 8 << 20
	// yjsCompactMin: below this the log is never compacted.
	yjsCompactMin = 1 << 20
	// yjsSaverIdle: the saver role moves to whoever is typing once the
	// current saver has not typed for this long. Two people typing at once
	// do not flip it on every keystroke.
	yjsSaverIdle = 5 * time.Second
	// yjsSaverStuck: an update no save has confirmed this long after it
	// arrived means the saver is not saving (a socket the tab lost but the
	// server still holds, a frozen or throttled background tab). The role
	// then moves to another writer, whose tab saves the room's text. Typing
	// alone never moved it here: a tab that reconnected within yjsSaverIdle
	// of its old socket's last edit left the old socket as the saver, and
	// nothing was ever written (the file kept the old text, and the room
	// showed the new text on every return until it was dropped).
	yjsSaverStuck = 10 * time.Second
	// yjsUnsavedGrace: how long an empty room with unsaved updates is kept,
	// so a reload or a quick return can still save them.
	yjsUnsavedGrace = 2 * time.Minute
)

type yjsEntry struct {
	seq  uint64
	data []byte
	from *Conn // nil for a snapshot
	uid  int   // account the bytes are counted against (roomUID for a snapshot)
	own  int   // 1-based count of `from`'s own updates up to this one
	// saved: a yjs-saved has confirmed the file holds this update.
	saved bool
	// at: when it arrived (for a snapshot, its oldest unsaved update's).
	at time.Time
}

// roomUID is the budget bucket of a snapshot. A snapshot holds everyone's
// text, so it counts toward the room and server caps but not toward the
// saver's own share.
const roomUID = -1

type yjsMember struct {
	joined     time.Time
	lastUpdate time.Time
	ownSent    int // updates this connection has sent
}

type yjsRoom struct {
	key       string
	members   map[*Conn]*yjsMember
	log       []yjsEntry
	bytes     int
	seq       uint64
	seeded    bool
	seeder    *Conn
	saver     *Conn
	compacted int    // size of the last snapshot
	snapSeq   uint64 // ack of the last snapshot; a new one must not go back
	asked     bool
	freeTimer *time.Timer
	// stuckTimer runs while the log holds an unsaved update (saverCheck).
	stuckTimer *time.Timer
	// stuck: connections that lost the role for not saving. They are not
	// handed it again until they send something (an update, a yjs-saved),
	// so the role does not go back and forth with a socket that is gone.
	stuck map[*Conn]bool
	// saverSince: when the current saver got the role. A saver is judged
	// from then, not from when an update arrived: after everyone dropped and
	// came back, the unsaved updates are old, and the new saver (merging the
	// file before it binds) would lose the role at once.
	saverSince time.Time
}

type yjsControl struct {
	Type string `json:"type"`
	// Saver is always present on yjs-role, so false clearly means "you no
	// longer save". Seeding is its own message (yjs-seed).
	Saver  bool   `json:"saver"`
	Seeded bool   `json:"seeded,omitempty"`
	Error  string `json:"error,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// EnableSharedEditing turns on the Yjs rooms. Off, every yjs message is
// ignored and clients keep the whole-file path.
func (h *Hub) EnableSharedEditing() {
	h.shared = true
	h.saverStuck = yjsSaverStuck
}

// SharedEditing reports whether Yjs rooms are on.
func (h *Hub) SharedEditing() bool { return h != nil && h.shared }

func sendControl(c *Conn, m yjsControl) {
	data, err := json.Marshal(m)
	if err == nil {
		c.SendReliable(data)
	}
}

// YjsHello adds conn to the note's room and sends it the room's state.
func (h *Hub) YjsHello(ns, path string, c *Conn) {
	if !h.shared {
		sendControl(c, yjsControl{Type: "yjs-error", Error: "off"})
		return
	}
	key := noteKey(ns, path)
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		// A room only for a note that exists: joining needs read access to
		// the path, but not that a file is there, and an empty room for any
		// made-up path would still cost memory once someone writes to it.
		if h.noteExists != nil && !h.noteExists(ns, path) {
			sendControl(c, yjsControl{Type: "yjs-error", Error: "missing"})
			return
		}
		r = &yjsRoom{key: key, members: make(map[*Conn]*yjsMember)}
		h.rooms[key] = r
	}
	if r.freeTimer != nil {
		r.freeTimer.Stop()
		r.freeTimer = nil
	}
	if _, ok := r.members[c]; ok {
		return
	}
	if len(r.members) >= YjsMaxRoomConns {
		sendControl(c, yjsControl{Type: "yjs-error", Error: "room-full"})
		if len(r.members) == 0 {
			delete(h.rooms, key)
		}
		return
	}
	r.members[c] = &yjsMember{joined: time.Now()}

	seed := false
	if !r.seeded && r.seeder == nil && !c.ReadOnly {
		r.seeder = c
		seed = true
	}
	becameSaver := false
	if r.saver == nil && !c.ReadOnly {
		r.saver = c
		r.saverSince = time.Now()
		becameSaver = true
	}
	c.SendReliable(r.stateFrame())
	if seed {
		sendControl(c, yjsControl{Type: "yjs-seed"})
	}
	sendControl(c, yjsControl{Type: "yjs-role", Saver: becameSaver})
	sendControl(c, yjsControl{Type: "yjs-ready", Seeded: r.seeded})
}

// stateFrame packs the whole log into one frame, so a long log cannot
// overflow the connection's send buffer one entry at a time.
func (r *yjsRoom) stateFrame() []byte {
	n := 9
	for _, e := range r.log {
		n += 4 + len(e.data)
	}
	buf := make([]byte, 9, n)
	buf[0] = yjsTagState
	binary.BigEndian.PutUint64(buf[1:9], r.seq)
	var l [4]byte
	for _, e := range r.log {
		binary.BigEndian.PutUint32(l[:], uint32(len(e.data)))
		buf = append(buf, l[:]...)
		buf = append(buf, e.data...)
	}
	return buf
}

// YjsFrame handles one binary frame from conn. Frames from a read-only
// connection, or from one that has not joined the room, are dropped: they are
// never relayed and never stored.
func (h *Hub) YjsFrame(ns, path string, c *Conn, data []byte) {
	if !h.shared || c.ReadOnly || len(data) < 1 {
		return
	}
	key := noteKey(ns, path)
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		return
	}
	m, ok := r.members[c]
	if !ok {
		return
	}
	switch data[0] {
	case yjsTagUpdate:
		upd := data[1:]
		if len(upd) == 0 {
			return
		}
		if r.bytes+len(upd) > YjsMaxLogBytes {
			log.Printf("collab: %s: room full (%d bytes), refusing an update from %s", key, r.bytes, c.User.Username)
			sendControl(c, yjsControl{Type: "yjs-error", Error: "room-too-big"})
			return
		}
		if h.yjsBytes+len(upd) > YjsMaxTotalBytes || h.userBytes[c.User.ID]+len(upd) > YjsMaxUserBytes {
			log.Printf("collab: shared editing memory budget reached (%d bytes in %d rooms, %d for %s), refusing an update",
				h.yjsBytes, len(h.rooms), h.userBytes[c.User.ID], c.User.Username)
			sendControl(c, yjsControl{Type: "yjs-error", Error: "server-full"})
			return
		}
		h.account(c.User.ID, len(upd))
		r.seq++
		m.ownSent++
		m.lastUpdate = time.Now()
		r.log = append(r.log, yjsEntry{seq: r.seq, data: upd, from: c, uid: c.User.ID, own: m.ownSent, at: m.lastUpdate})
		delete(r.stuck, c)
		h.watchSaverLocked(key, r)
		r.bytes += len(upd)
		r.seeded = true
		r.seeder = nil

		frame := make([]byte, 9+len(upd))
		frame[0] = yjsTagUpdate
		binary.BigEndian.PutUint64(frame[1:9], r.seq)
		copy(frame[9:], upd)
		for o := range r.members {
			if o != c {
				o.SendReliable(frame)
			}
		}
		r.pickSaver(c)
		if !r.asked && r.saver != nil && r.bytes > yjsCompactMin && r.bytes > 4*r.compacted {
			r.asked = true
			sendControl(r.saver, yjsControl{Type: "yjs-compact"})
		}
	case yjsTagAwareness:
		frame := make([]byte, 5+len(data)-1)
		frame[0] = yjsTagAwareness
		binary.BigEndian.PutUint32(frame[1:5], uint32(c.User.ID))
		copy(frame[5:], data[1:])
		for o := range r.members {
			if o != c {
				o.SendReliable(frame)
			}
		}
	case yjsTagSnapshot:
		// Trusted from the saver only: the same trust as its PUT of the file.
		// And only when asked, and never larger than the updates the room
		// holds now, so a snapshot cannot be used to hold more memory than
		// the updates (each counted against its author) already did.
		if c != r.saver || !r.asked {
			return
		}
		if len(data) < 10 || len(data)-9 > r.bytes {
			r.asked = false // ask again once the log grows
			return
		}
		ack := binary.BigEndian.Uint64(data[1:9])
		if ack > r.seq || ack < r.snapSeq {
			return
		}
		snap := append([]byte(nil), data[9:]...)
		snapSaved := true
		var snapAt time.Time
		for _, e := range r.log {
			if e.seq <= ack && !e.saved {
				if snapSaved || e.at.Before(snapAt) {
					snapAt = e.at
				}
				snapSaved = false
			}
		}
		kept := []yjsEntry{{seq: ack, data: snap, uid: roomUID, saved: snapSaved, at: snapAt}}
		size := len(snap)
		var dropped []yjsEntry
		for _, e := range r.log {
			// Later entries stay. Some may already be in the snapshot;
			// applying a Yjs update twice changes nothing.
			if e.seq > ack {
				kept = append(kept, e)
				size += len(e.data)
			} else {
				dropped = append(dropped, e)
			}
		}
		// A snapshot is held to the room and server caps, like the updates
		// it replaces.
		dropBytes := 0
		for _, e := range dropped {
			dropBytes += len(e.data)
		}
		if size > YjsMaxLogBytes || h.yjsBytes-dropBytes+len(snap) > YjsMaxTotalBytes {
			log.Printf("collab: %s: refusing a %d-byte snapshot from %s (over a cap)", key, len(snap), c.User.Username)
			r.asked = false // ask again once the log grows
			return
		}
		for _, e := range dropped {
			h.account(e.uid, -len(e.data))
		}
		h.account(roomUID, len(snap))
		log.Printf("collab: %s: compacted %d entries / %d bytes into %d bytes (+%d later entries)",
			key, len(r.log), r.bytes, len(snap), len(kept)-1)
		r.log, r.bytes, r.compacted, r.asked, r.snapSeq = kept, size, len(snap), false, ack
	}
}

// pickSaver gives the saver role to `typist` when there is no saver, or the
// current one has gone quiet. Caller holds ymu.
func (r *yjsRoom) pickSaver(typist *Conn) {
	if r.saver == typist {
		return
	}
	if r.saver != nil {
		if sm, ok := r.members[r.saver]; ok && time.Since(sm.lastUpdate) < yjsSaverIdle {
			return
		}
	}
	r.setSaver(typist)
}

// watchSaverLocked makes sure saverCheck runs while the room holds an update
// no save has confirmed. Caller holds ymu.
func (h *Hub) watchSaverLocked(key string, r *yjsRoom) {
	if r.stuckTimer != nil {
		return
	}
	room := r
	r.stuckTimer = time.AfterFunc(h.saverStuck, func() { h.saverCheck(key, room) })
}

// saverCheck moves the saver role away from a saver that has not saved an
// update yjsSaverStuck after it arrived, to the writer who was active most
// recently. It runs again while anything stays unsaved, so a writer who
// comes back to the note later still gets the role and saves.
func (h *Hub) saverCheck(key string, r *yjsRoom) {
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r.stuckTimer = nil
	if h.rooms[key] != r {
		return
	}
	var oldest time.Time
	for _, e := range r.log {
		if !e.saved && (oldest.IsZero() || e.at.Before(oldest)) {
			oldest = e.at
		}
	}
	if oldest.IsZero() {
		return // all saved; the next update starts the watch again
	}
	if r.saverSince.After(oldest) {
		oldest = r.saverSince
	}
	wait := h.saverStuck - time.Since(oldest)
	if wait <= 0 {
		if next := r.latestWritableExcept(r.saver); next != nil {
			log.Printf("collab: %s: the saver has not saved for %s; handing the role to %s", key, h.saverStuck, next.User.Username)
			if r.saver != nil {
				if r.stuck == nil {
					r.stuck = make(map[*Conn]bool)
				}
				r.stuck[r.saver] = true
			}
			r.setSaver(next)
		}
		wait = h.saverStuck
	}
	room := r
	r.stuckTimer = time.AfterFunc(wait, func() { h.saverCheck(key, room) })
}

func (r *yjsRoom) setSaver(c *Conn) {
	old := r.saver
	r.saver = c
	if old != c {
		r.asked = false // a pending compaction request went to the old saver
		r.saverSince = time.Now()
	}
	if old != nil && old != c {
		if _, still := r.members[old]; still {
			sendControl(old, yjsControl{Type: "yjs-role", Saver: false})
		}
	}
	if c != nil && c != old {
		sendControl(c, yjsControl{Type: "yjs-role", Saver: true})
	}
}

// YjsSaved records that the saver wrote the file. recv is the highest log seq
// the saver had applied when it took the text, own the number of its own
// updates it had sent by then.
func (h *Hub) YjsSaved(ns, path string, c *Conn, recv uint64, own int) {
	if !h.shared || c.ReadOnly {
		return
	}
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[noteKey(ns, path)]
	if r == nil {
		return
	}
	if _, ok := r.members[c]; !ok {
		return
	}
	delete(r.stuck, c)
	for i := range r.log {
		e := &r.log[i]
		if e.seq <= recv || (e.from == c && e.own <= own) {
			e.saved = true
		}
	}
}

// hasUnsaved reports whether the log holds an update no save has covered.
// Conservative: anything not proven saved counts as unsaved.
func (r *yjsRoom) hasUnsaved() bool {
	for _, e := range r.log {
		if !e.saved {
			return true
		}
	}
	return false
}

// YjsLeave removes conn from the note's room (it also runs on disconnect).
func (h *Hub) YjsLeave(ns, path string, c *Conn) {
	key := noteKey(ns, path)
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		return
	}
	if _, ok := r.members[c]; !ok {
		return
	}
	delete(r.members, c)
	delete(r.stuck, c)
	if r.seeder == c {
		r.seeder = nil
		if !r.seeded {
			if next := r.oldestWritable(); next != nil {
				r.seeder = next
				sendControl(next, yjsControl{Type: "yjs-seed"})
			}
		}
	}
	if r.saver == c {
		// The new saver saves whatever the old one had not: its document
		// holds every update, and it compares against the last saved text.
		r.saver = nil
		r.setSaver(r.latestWritable())
	}
	if len(r.members) > 0 {
		return
	}
	if !r.hasUnsaved() {
		h.dropRoomLocked(key, r)
		return
	}
	log.Printf("collab: WARNING %s: the last person left with unsaved updates (%d bytes); keeping the room %s for someone to save it",
		key, r.bytes, yjsUnsavedGrace)
	room := r
	r.freeTimer = time.AfterFunc(yjsUnsavedGrace, func() {
		h.ymu.Lock()
		defer h.ymu.Unlock()
		if h.rooms[key] == room && len(room.members) == 0 {
			h.dropRoomLocked(key, room)
			log.Printf("collab: WARNING %s: dropped a room with unsaved updates after %s; the file holds the last saved text", key, yjsUnsavedGrace)
		}
	})
}

func (r *yjsRoom) oldestWritable() *Conn {
	var best *Conn
	var at time.Time
	for c, m := range r.members {
		if c.ReadOnly {
			continue
		}
		if best == nil || m.joined.Before(at) {
			best, at = c, m.joined
		}
	}
	return best
}

func (r *yjsRoom) latestWritable() *Conn { return r.latestWritableExcept(nil) }

// latestWritableExcept is latestWritable leaving out skip and every
// connection that lost the role for not saving.
func (r *yjsRoom) latestWritableExcept(skip *Conn) *Conn {
	var best *Conn
	var at time.Time
	for c, m := range r.members {
		if c.ReadOnly || c == skip || r.stuck[c] {
			continue
		}
		t := m.lastUpdate
		if t.IsZero() {
			t = m.joined
		}
		if best == nil || t.After(at) {
			best, at = c, t
		}
	}
	return best
}

// CloseMissingRooms closes the rooms in ns whose note no longer exists (moved,
// renamed or deleted). Its people get yjs-closed and fall back to the app's
// missing-note handling; nothing in a closed room is saved again.
func (h *Hub) CloseMissingRooms(ns string, exists func(path string) bool) {
	if !h.SharedEditing() {
		return
	}
	prefix := ns + ":"
	h.ymu.Lock()
	var check []string
	for key := range h.rooms {
		if len(key) > len(prefix) && key[:len(prefix)] == prefix {
			check = append(check, key)
		}
	}
	h.ymu.Unlock()
	for _, key := range check {
		if exists(key[len(prefix):]) {
			continue
		}
		h.closeRoom(key, "missing")
	}
}

func (h *Hub) closeRoom(key, reason string) {
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		return
	}
	if r.freeTimer != nil {
		r.freeTimer.Stop()
	}
	h.dropRoomLocked(key, r)
	for c := range r.members {
		sendControl(c, yjsControl{Type: "yjs-closed", Reason: reason})
	}
	log.Printf("collab: %s: room closed (%s)", key, reason)
}

// YjsMember reports whether conn has joined the note's room. Its old-style
// whole-document "content" messages are ignored then.
func (h *Hub) YjsMember(ns, path string, c *Conn) bool {
	if !h.shared {
		return false
	}
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[noteKey(ns, path)]
	if r == nil {
		return false
	}
	_, ok := r.members[c]
	return ok
}

// yjsRoomStats is for tests and logs.
type yjsRoomStats struct {
	Members, Entries, Bytes int
	Seeded                  bool
	Saver                   *Conn
}

func (h *Hub) roomStats(ns, path string) (yjsRoomStats, bool) {
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[noteKey(ns, path)]
	if r == nil {
		return yjsRoomStats{}, false
	}
	return yjsRoomStats{Members: len(r.members), Entries: len(r.log), Bytes: r.bytes, Seeded: r.seeded, Saver: r.saver}, true
}

// HandleMessage dispatches one websocket message from conn. Split out of the
// read loop so tests can drive it without a socket.
func (h *Hub) HandleMessage(ns, path string, c *Conn, binaryFrame bool, data []byte) {
	if binaryFrame {
		h.YjsFrame(ns, path, c, data) // drops read-only frames itself
		return
	}
	var msg IncomingMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	// A read-only viewer may join a room to receive it, and nothing else.
	switch msg.Type {
	case "yjs-hello":
		h.YjsHello(ns, path, c)
		return
	case "yjs-leave":
		h.YjsLeave(ns, path, c)
		return
	}
	if c.ReadOnly {
		return
	}
	switch msg.Type {
	case "yjs-saved":
		h.YjsSaved(ns, path, c, msg.Recv, msg.Own)
	case "cursor":
		h.BroadcastCursor(ns, path, c, msg)
	case "selection":
		h.BroadcastSelection(ns, path, c, msg)
	case "content":
		// The whole-document message belongs to the old path. In a shared
		// room it would push one person's copy over everyone's.
		if !h.YjsMember(ns, path, c) {
			h.BroadcastContent(ns, path, c, msg.Content)
		}
	}
}

// SharedEditingEnabled decides SHARED_EDITING (read only when live collab is
// on). On by default. Always off on MDNEST_ROLE=app: rooms live in one
// process's memory, so replicas would each hold a different room for the
// same note. A multi-replica Helm install sets SHARED_EDITING=false for the
// same reason.
func SharedEditingEnabled(setting, role string) bool {
	if role == "app" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "false", "0", "no", "off":
		return false
	}
	return true
}

// dropRoomLocked removes a room and returns its bytes to the server budget.
// Caller holds ymu.
func (h *Hub) dropRoomLocked(key string, r *yjsRoom) {
	if r.stuckTimer != nil {
		r.stuckTimer.Stop()
		r.stuckTimer = nil
	}
	if h.rooms[key] == r {
		delete(h.rooms, key)
		for _, e := range r.log {
			h.account(e.uid, -len(e.data))
		}
	}
}

// account adds (or with a negative n, returns) bytes to the server-wide and
// per-account budgets. Caller holds ymu.
func (h *Hub) account(uid, n int) {
	h.yjsBytes += n
	if h.userBytes == nil {
		h.userBytes = make(map[int]int)
	}
	h.userBytes[uid] += n
	if h.userBytes[uid] <= 0 {
		delete(h.userBytes, uid)
	}
}

// SetNoteExists lets the hub refuse a room for a note that is not there.
func (h *Hub) SetNoteExists(fn func(ns, path string) bool) { h.noteExists = fn }
