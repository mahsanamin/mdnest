package collab

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const (
	writeTimeout = 5 * time.Second
	pingInterval = 15 * time.Second
)

// Join limits per connection: a burst of joinBurst, then joinRate a second.
// Switching notes is a click; this only stops one socket churning rooms.
const (
	joinBurst = 20.0
	joinRate  = 20.0
)

// Authorizer decides whether a connection may be in a note. It cleans the
// path the same way the handshake does and returns the cleaned path, whether
// the user may only read, and an error code ("invalid-namespace",
// "invalid-path", "forbidden") when they may not be there at all.
type Authorizer func(ns, rawPath string) (path string, readOnly bool, errCode string)

// Conn wraps a WebSocket connection with user identity.
//
// One connection serves a whole visit: the client moves it from note to note
// with "join" messages, and every join goes through Authorize again. A
// connection opened with ns and path in the URL (a tab from before v4.8.13)
// starts in that note.
type Conn struct {
	User UserInfo
	// ReadOnly marks a viewer without write access to the current note: it
	// receives the room's events but its own cursor, selection and content
	// messages are dropped, so a reader can neither push text into a
	// writer's editor nor pose as an editor. Written only by the read loop,
	// while the connection is in no note and no room.
	ReadOnly bool
	// Authorize checks every join. Nil refuses every join.
	Authorize Authorizer
	// Expires is when the session token the socket opened with runs out.
	// A visit socket lives long, so after this it joins nothing and closes;
	// the client opens a new one with its current token. Zero: no expiry.
	Expires time.Time
	ws      *websocket.Conn
	send    chan []byte
	// dropped is set when a reliable send could not be queued; the
	// connection is closed so the client reconnects and syncs again.
	dropped bool

	// mu guards the current note. The read loop holds it while it handles a
	// message, so a note cannot be left under a message being handled for it.
	mu     sync.Mutex
	ns     string
	path   string
	joined bool
	// perNote: opened with ns and path in the URL (a tab from before
	// v4.8.13). Losing access to its note closes it, as it always did: that
	// client only checks access again by reconnecting.
	perNote bool

	joinTokens float64
	joinAt     time.Time
}

// NewConn creates a new connection wrapper.
func NewConn(ws *websocket.Conn, userID int, username string) *Conn {
	return &Conn{
		User: UserInfo{
			ID:       userID,
			Username: username,
			Color:    colorForUser(userID),
		},
		ws:         ws,
		send:       make(chan []byte, 256),
		joinTokens: joinBurst,
	}
}

// Close forcefully closes the WebSocket connection (normal closure).
func (c *Conn) Close() {
	c.ws.Close(websocket.StatusGoingAway, "replaced by new connection")
}

// Send queues a message to be sent. Non-blocking — drops if buffer full.
func (c *Conn) Send(data []byte) {
	select {
	case c.send <- data:
	default:
		// Buffer full — drop message to avoid blocking
	}
}

// SendReliable queues a message that must not be lost (a Yjs frame). If the
// buffer is full the connection is closed instead of dropping the message:
// a document missing one update stays wrong, while a reconnect fetches the
// whole room again.
func (c *Conn) SendReliable(data []byte) {
	select {
	case c.send <- data:
	default:
		if !c.dropped {
			c.dropped = true
			log.Printf("collab: send buffer full for %s; closing so it resyncs", c.User.Username)
			if c.ws != nil {
				go c.ws.Close(websocket.StatusTryAgainLater, "too slow, reconnect")
			}
		}
	}
}

// noteMsg is what the server says about the connection's note: "joined"
// (everything after it belongs to that note), "join-error", and "note-left"
// (the server took the connection out of its note).
type noteMsg struct {
	Type     string `json:"type"`
	Seq      int    `json:"seq,omitempty"`
	Ns       string `json:"ns,omitempty"`
	Path     string `json:"path,omitempty"`
	ReadOnly bool   `json:"readOnly,omitempty"`
	Error    string `json:"error,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

func (c *Conn) sendNoteMsg(m noteMsg) {
	if data, err := json.Marshal(m); err == nil {
		c.SendReliable(data)
	}
}

// Note returns the note the connection is in.
func (c *Conn) Note() (ns, path string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ns, c.path, c.joined
}

// Enter puts the connection in a note without a join message: the handshake
// of a connection opened with ns and path in the URL. No "joined" is sent,
// so an older client sees exactly what it always did.
func (c *Conn) Enter(hub *Hub, ns, path string, readOnly bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ReadOnly = readOnly
	c.ns, c.path, c.joined, c.perNote = ns, path, true, true
	hub.Join(ns, path, c)
}

// leaveLocked takes the connection out of its note and that note's room.
// Caller holds c.mu.
func (c *Conn) leaveLocked(hub *Hub) {
	if !c.joined {
		return
	}
	hub.YjsLeave(c.ns, c.path, c)
	hub.Leave(c.ns, c.path, c)
	c.joined = false
	c.ns, c.path = "", ""
}

// LeaveNote takes the connection out of ns/path if it is still there, and
// tells the client why. Used when access to the note changed under it.
func (c *Conn) LeaveNote(hub *Hub, ns, path, reason string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.joined || c.ns != ns || c.path != path {
		return false
	}
	c.leaveLocked(hub)
	c.noteLeftLocked(ns, path, reason)
	return true
}

// noteLeftLocked tells the client it is no longer in ns/path. A per-note
// connection is closed instead. Caller holds c.mu.
func (c *Conn) noteLeftLocked(ns, path, reason string) {
	if c.perNote {
		if c.ws != nil {
			go c.ws.Close(websocket.StatusPolicyViolation, "access changed")
		}
		return
	}
	c.sendNoteMsg(noteMsg{Type: "note-left", Ns: ns, Path: path, Reason: reason})
}

// recheck takes the connection out of its note when Authorize no longer
// lets it be there as it is. With only != "", it checks the connection only
// if it is in that note key. It takes c.mu, so it runs after a join that is
// in progress and checks what that join ended up in.
func (c *Conn) recheck(hub *Hub, only string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.joined || (only != "" && noteKey(c.ns, c.path) != only) {
		return
	}
	code, readOnly := "forbidden", false
	if c.Authorize != nil {
		_, readOnly, code = c.Authorize(c.ns, c.path)
	}
	if code == "" && readOnly == c.ReadOnly {
		return
	}
	ns, path := c.ns, c.path
	c.leaveLocked(hub)
	c.noteLeftLocked(ns, path, "access")
}

func (c *Conn) allowJoin(now time.Time) bool {
	if !c.joinAt.IsZero() {
		c.joinTokens += now.Sub(c.joinAt).Seconds() * joinRate
		if c.joinTokens > joinBurst {
			c.joinTokens = joinBurst
		}
	}
	c.joinAt = now
	if c.joinTokens < 1 {
		return false
	}
	c.joinTokens--
	return true
}

// control handles the messages that move the connection between notes. It
// reports whether data was one of them.
func (c *Conn) control(hub *Hub, data []byte) bool {
	var m struct {
		Type string `json:"type"`
		Seq  int    `json:"seq"`
		Ns   string `json:"ns"`
		Path string `json:"path"`
	}
	if json.Unmarshal(data, &m) != nil {
		return false
	}
	switch m.Type {
	case "join":
		c.join(hub, m.Ns, m.Path, m.Seq)
		return true
	case "leave-note":
		c.mu.Lock()
		c.leaveLocked(hub)
		c.mu.Unlock()
		return true
	}
	return false
}

func (c *Conn) join(hub *Hub, ns, rawPath string, seq int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.Expires.IsZero() && !time.Now().Before(c.Expires) {
		c.leaveLocked(hub)
		c.sendNoteMsg(noteMsg{Type: "join-error", Seq: seq, Ns: ns, Path: rawPath, Error: "expired"})
		if c.ws != nil {
			go c.ws.Close(websocket.StatusPolicyViolation, "session expired")
		}
		return
	}
	if !c.allowJoin(time.Now()) {
		c.sendNoteMsg(noteMsg{Type: "join-error", Seq: seq, Ns: ns, Path: rawPath, Error: "rate"})
		return
	}
	path, readOnly, code := "", false, "forbidden"
	if c.Authorize != nil {
		path, readOnly, code = c.Authorize(ns, rawPath)
	}
	if code != "" {
		// Refused: the client is leaving its old note anyway.
		c.leaveLocked(hub)
		c.sendNoteMsg(noteMsg{Type: "join-error", Seq: seq, Ns: ns, Path: rawPath, Error: code})
		return
	}
	if c.joined && c.ns == ns && c.path == path && c.ReadOnly == readOnly {
		c.sendNoteMsg(noteMsg{Type: "joined", Seq: seq, Ns: ns, Path: path, ReadOnly: readOnly})
		hub.sendPresenceLocal(noteKey(ns, path))
		return
	}
	c.leaveLocked(hub)
	c.ReadOnly = readOnly
	c.ns, c.path, c.joined = ns, path, true
	// Before the note's presence: the client takes everything after
	// "joined" as belonging to this note.
	c.sendNoteMsg(noteMsg{Type: "joined", Seq: seq, Ns: ns, Path: path, ReadOnly: readOnly})
	hub.Join(ns, path, c)
}

// ReadLoop reads messages from the client and dispatches them.
// Blocks until the connection is closed, or until Expires.
func (c *Conn) ReadLoop(ctx context.Context, hub *Hub) {
	if !c.Expires.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, c.Expires)
		defer cancel()
	}
	hub.addConn(c)
	defer func() {
		hub.removeConn(c)
		c.mu.Lock()
		c.leaveLocked(hub)
		c.mu.Unlock()
		c.ws.Close(websocket.StatusNormalClosure, "")
	}()

	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return // Connection closed
		}
		c.handle(hub, typ == websocket.MessageBinary, data)
	}
}

// handle dispatches one message from the client to its current note.
func (c *Conn) handle(hub *Hub, binaryFrame bool, data []byte) {
	if !binaryFrame && c.control(hub, data) {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.joined {
		return
	}
	hub.HandleMessage(c.ns, c.path, c, binaryFrame, data)
}

// WriteLoop sends queued messages and pings. Blocks until done.
func (c *Conn) WriteLoop(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case data, ok := <-c.send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(writeCtx, frameType(data), data)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Ping(pingCtx)
			cancel()
			if err != nil {
				log.Printf("collab: ping failed for %s: %v", c.User.Username, err)
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// frameType picks the websocket message type for a queued message. JSON
// starts with '{'; a shared editing frame starts with its tag byte (1 to 4),
// and must go out as binary: a browser fails the whole connection on a text
// frame that is not valid UTF-8.
func frameType(data []byte) websocket.MessageType {
	if len(data) > 0 && data[0] < 0x20 {
		return websocket.MessageBinary
	}
	return websocket.MessageText
}
