package collab

import (
	"encoding/json"
	"log"
	"sync"
)

// Hub manages WebSocket connections grouped by note (namespace + path).
// Enforces single active session per user — new connections supersede old ones.
type Hub struct {
	mu       sync.RWMutex
	notes    map[string]map[int]*Conn // noteKey -> userID -> connection
	sessions map[int]*sessionInfo     // userID -> active session (global, across all notes)
}

// sessionInfo tracks a user's active WebSocket session.
type sessionInfo struct {
	conn *Conn
	ns   string
	path string
}

// NewHub creates a new collaboration hub.
func NewHub() *Hub {
	return &Hub{
		notes:    make(map[string]map[int]*Conn),
		sessions: make(map[int]*sessionInfo),
	}
}

// noteKey builds a unique key for a note.
func noteKey(ns, path string) string {
	return ns + ":" + path
}

// UserInfo identifies a connected user.
type UserInfo struct {
	ID       int    `json:"id"`
	Username string `json:"username"`
	Color    string `json:"color"`
}

// Message types sent/received over WebSocket.
type IncomingMessage struct {
	Type      string `json:"type"` // "cursor", "selection", or "content"
	Line      int    `json:"line,omitempty"`
	Ch        int    `json:"ch,omitempty"`
	FromLine  int    `json:"fromLine,omitempty"`
	FromCh    int    `json:"fromCh,omitempty"`
	ToLine    int    `json:"toLine,omitempty"`
	ToCh      int    `json:"toCh,omitempty"`
	Content   string `json:"content,omitempty"`
}

type OutgoingMessage struct {
	Type     string      `json:"type"`
	UserID   int         `json:"userId,omitempty"`
	Username string      `json:"username,omitempty"`
	Color    string      `json:"color,omitempty"`
	Users    []UserInfo  `json:"users,omitempty"`
	Line     int         `json:"line,omitempty"`
	Ch       int         `json:"ch,omitempty"`
	FromLine int         `json:"fromLine,omitempty"`
	FromCh   int         `json:"fromCh,omitempty"`
	ToLine   int         `json:"toLine,omitempty"`
	ToCh     int         `json:"toCh,omitempty"`
	By       int         `json:"by,omitempty"`
	ETag     string      `json:"etag,omitempty"`
	Content  string      `json:"content,omitempty"`
}

// Color palette for user cursors (Catppuccin colors).
var cursorColors = []string{
	"#89b4fa", // blue
	"#a6e3a1", // green
	"#f9e2af", // yellow
	"#f38ba8", // red
	"#cba6f7", // mauve
	"#fab387", // peach
	"#94e2d5", // teal
	"#f5c2e7", // pink
	"#74c7ec", // sapphire
	"#eba0ac", // maroon
}

func colorForUser(userID int) string {
	return cursorColors[userID%len(cursorColors)]
}

// Join adds a connection to a note's presence.
// Enforces single session per user — if the user already has an active session,
// the old connection is closed. A 2-second debounce avoids treating page refreshes
// as new sessions.
func (h *Hub) Join(ns, path string, conn *Conn) {
	key := noteKey(ns, path)
	userID := conn.User.ID

	h.mu.Lock()

	// Check for existing session — collect old conn to close AFTER releasing lock
	var oldConn *Conn
	var supersede bool

	if existing, ok := h.sessions[userID]; ok && existing.conn != conn {
		oldKey := noteKey(existing.ns, existing.path)

		if conn.SessionID != "" && conn.SessionID == existing.conn.SessionID {
			// Same tab switching files — don't close, frontend handles its own cleanup
			log.Printf("collab: %s switched notes (same tab %s)", conn.User.Username, conn.SessionID)
		} else {
			// Different tab/window — supersede the old session
			log.Printf("collab: session superseded for %s (was on %s, now on %s)", conn.User.Username, oldKey, key)
			oldConn = existing.conn
			supersede = true
		}

		// Remove old connection from its note
		if conns, ok := h.notes[oldKey]; ok {
			delete(conns, userID)
			if len(conns) == 0 {
				delete(h.notes, oldKey)
			}
		}
	}

	// Register new session
	h.sessions[userID] = &sessionInfo{
		conn: conn,
		ns:   ns,
		path: path,
	}

	if h.notes[key] == nil {
		h.notes[key] = make(map[int]*Conn)
	}
	h.notes[key][userID] = conn
	h.mu.Unlock()

	// Close old connection OUTSIDE the lock to avoid deadlock
	if oldConn != nil {
		if supersede {
			oldConn.CloseSuperseded()
		} else {
			oldConn.Close()
		}
	}

	log.Printf("collab: %s joined %s (%d users)", conn.User.Username, key, h.countUsers(key))

	h.broadcastPresence(key)

	h.broadcastToOthers(key, userID, OutgoingMessage{
		Type:     "join",
		UserID:   userID,
		Username: conn.User.Username,
		Color:    conn.User.Color,
	})
}

// Leave removes a connection from a note's presence.
func (h *Hub) Leave(ns, path string, userID int) {
	key := noteKey(ns, path)
	h.mu.Lock()
	if conns, ok := h.notes[key]; ok {
		leavingConn := conns[userID]
		delete(conns, userID)
		if len(conns) == 0 {
			delete(h.notes, key)
		}
		// Only remove from sessions if this IS the active session
		// (a newer session may have already replaced it)
		if sess, ok := h.sessions[userID]; ok && sess.conn == leavingConn {
			delete(h.sessions, userID)
		}
	}
	h.mu.Unlock()

	log.Printf("collab: user %d left %s (%d users)", userID, key, h.countUsers(key))

	// Broadcast updated presence and leave event
	h.broadcastPresence(key)
	h.broadcastToOthers(key, userID, OutgoingMessage{
		Type:   "leave",
		UserID: userID,
	})
}

// BroadcastCursor sends a cursor update from one user to all others on the note.
func (h *Hub) BroadcastCursor(ns, path string, from *Conn, msg IncomingMessage) {
	key := noteKey(ns, path)
	h.broadcastToOthers(key, from.User.ID, OutgoingMessage{
		Type:     "cursor",
		UserID:   from.User.ID,
		Username: from.User.Username,
		Color:    from.User.Color,
		Line:     msg.Line,
		Ch:       msg.Ch,
	})
}

// BroadcastSelection sends a selection update from one user to all others.
func (h *Hub) BroadcastSelection(ns, path string, from *Conn, msg IncomingMessage) {
	key := noteKey(ns, path)
	h.broadcastToOthers(key, from.User.ID, OutgoingMessage{
		Type:     "selection",
		UserID:   from.User.ID,
		Username: from.User.Username,
		Color:    from.User.Color,
		FromLine: msg.FromLine,
		FromCh:   msg.FromCh,
		ToLine:   msg.ToLine,
		ToCh:     msg.ToCh,
	})
}

// BroadcastContent sends live content from one user to all others on the note.
func (h *Hub) BroadcastContent(ns, path string, from *Conn, content string) {
	key := noteKey(ns, path)
	h.broadcastToOthers(key, from.User.ID, OutgoingMessage{
		Type:     "content",
		UserID:   from.User.ID,
		Username: from.User.Username,
		Content:  content,
	})
}

// BroadcastFileChanged notifies all users on a note that it was saved.
func (h *Hub) BroadcastFileChanged(ns, path string, byUserID int, byUsername string, etag string) {
	key := noteKey(ns, path)
	h.broadcastToOthers(key, byUserID, OutgoingMessage{
		Type:     "file-changed",
		By:       byUserID,
		Username: byUsername,
		ETag:     etag,
	})
}

// BroadcastTreeChanged notifies all connected clients on a namespace that the file tree changed.
// Used when files are created/deleted/moved via API or CLI.
func (h *Hub) BroadcastTreeChanged(ns string) {
	msg := OutgoingMessage{
		Type: "tree-changed",
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	prefix := ns + ":"
	for key, conns := range h.notes {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			for _, c := range conns {
				c.Send(data)
			}
		}
	}
	h.mu.RUnlock()
}

// BroadcastAccessChanged notifies ALL connected clients that permissions changed.
// Used when users are invited, grants created/modified/deleted.
func (h *Hub) BroadcastAccessChanged() {
	msg := OutgoingMessage{
		Type: "access-changed",
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	for _, conns := range h.notes {
		for _, c := range conns {
			c.Send(data)
		}
	}
	h.mu.RUnlock()
}

func (h *Hub) broadcastPresence(key string) {
	h.mu.RLock()
	conns := h.notes[key]
	if conns == nil {
		h.mu.RUnlock()
		return
	}

	users := make([]UserInfo, 0, len(conns))
	for _, c := range conns {
		users = append(users, c.User)
	}

	msg := OutgoingMessage{
		Type:  "presence",
		Users: users,
	}
	data, _ := json.Marshal(msg)

	// Copy connections to avoid holding lock during send
	targets := make([]*Conn, 0, len(conns))
	for _, c := range conns {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.Send(data)
	}
}

func (h *Hub) broadcastToOthers(key string, excludeUserID int, msg OutgoingMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	conns := h.notes[key]
	targets := make([]*Conn, 0, len(conns))
	for uid, c := range conns {
		if uid != excludeUserID {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.Send(data)
	}
}

func (h *Hub) countUsers(key string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.notes[key])
}
