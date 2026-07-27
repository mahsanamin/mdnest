package collab

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"
)

// Hub manages WebSocket connections grouped by note (namespace + path).
//
// Storage shape: noteKey -> set of *Conn. We track CONNECTIONS, not
// users — one user can have multiple tabs open on the same note, each
// with its own *Conn. Earlier the map was keyed by userID, which (a)
// silently dropped a user's earlier tab when they opened a second one
// and (b) made the "exclude originator" logic for broadcasts user-scoped
// instead of connection-scoped. The latter caused a real bug: a CLI
// write executed by user X excluded *every* of X's WebSocket conns
// (including the browser tab the user was actively editing in), so
// the browser never auto-reloaded after a CLI write. With *Conn keys,
// HTTP-triggered broadcasts (file-changed, tree-changed) hit every
// connection — there's no originating *Conn to exclude — and only
// WS-triggered relays (cursor / selection / live content) carry an
// originator pointer to filter out the source tab.
type Hub struct {
	mu    sync.RWMutex
	notes map[string]map[*Conn]struct{} // noteKey -> set of connections

	// id identifies this hub process; used to suppress self-echo of
	// messages published to the backplane.
	id string
	// bp fans events out to peer instances. Defaults to nopBackplane
	// (single-instance behavior); replaced by EnableRedis when REDIS_URL
	// is configured.
	bp Backplane

	// rmu guards remote, the per-note presence contributed by peer
	// instances (noteKey -> peer instance id -> that peer's user-set).
	rmu    sync.Mutex
	remote map[string]map[string]remotePresence
}

// remotePresence is a peer instance's advertised user-set for a note, with an
// expiry so a peer that dies (missing its heartbeat) is dropped from merged
// presence.
type remotePresence struct {
	users     []UserInfo
	expiresAt time.Time
}

const (
	// presenceTTL is how long a peer's advertised presence is trusted
	// without a refresh; presenceHeartbeat must be comfortably shorter.
	presenceTTL       = 30 * time.Second
	presenceHeartbeat = 10 * time.Second
)

// NewHub creates a new collaboration hub.
func NewHub() *Hub {
	return &Hub{
		notes:  make(map[string]map[*Conn]struct{}),
		id:     newInstanceID(),
		bp:     nopBackplane{},
		remote: make(map[string]map[string]remotePresence),
	}
}

// EnableRedis attaches a Redis pub/sub backplane so this hub shares live
// events and presence with peer instances, enabling horizontal scaling
// (opt-in). With no Redis configured the hub keeps its single-instance
// behavior and this is never called.
func (h *Hub) EnableRedis(ctx context.Context, url string) error {
	bp, err := newRedisBackplane(ctx, url)
	if err != nil {
		return err
	}
	h.bp = bp
	bp.Start(h.onRemote)
	go h.presenceHeartbeatLoop(ctx)
	log.Println("collab: redis backplane enabled (horizontal scaling)")
	return nil
}

// publish stamps the message with this instance's id and hands it to the
// backplane. A no-op with the default nopBackplane.
func (h *Hub) publish(m wireMsg) {
	m.Origin = h.id
	h.bp.Publish(m)
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
	// Reason explains *why* a file-changed message was sent, when it's
	// non-default. Empty/omitted = a normal save (existing behaviour).
	// "restored" = a deliberate restore of an older version via
	// PUT /api/note?restore-from=<sha>. The frontend renders a
	// distinct (info-coloured) banner for restores so other users
	// know it was an intentional action, not a conflict.
	Reason         string `json:"reason,omitempty"`
	RestoreFromRef string `json:"restoreFromRef,omitempty"`
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

// Join adds a connection to a note's presence. We only emit the public
// "join" event when this is the user's *first* connection on the note —
// a second tab from the same user is internal bookkeeping, not a new
// participant from the perspective of other users.
func (h *Hub) Join(ns, path string, conn *Conn) {
	key := noteKey(ns, path)
	h.mu.Lock()
	if h.notes[key] == nil {
		h.notes[key] = make(map[*Conn]struct{})
	}
	firstForUser := !h.userHasConnLocked(key, conn.User.ID)
	h.notes[key][conn] = struct{}{}
	h.mu.Unlock()

	log.Printf("collab: %s joined %s (%d users)", conn.User.Username, key, h.countUsers(key))

	h.broadcastPresence(key)

	if firstForUser {
		h.broadcastToOthers(key, conn, OutgoingMessage{
			Type:     "join",
			UserID:   conn.User.ID,
			Username: conn.User.Username,
			Color:    conn.User.Color,
		})
	}
}

// Leave removes a connection from a note's presence. The "leave" event
// only fires when the user's last connection on the note disconnects —
// closing one of two tabs shouldn't tell other users you left.
func (h *Hub) Leave(ns, path string, conn *Conn) {
	key := noteKey(ns, path)
	h.mu.Lock()
	if conns, ok := h.notes[key]; ok {
		delete(conns, conn)
		if len(conns) == 0 {
			delete(h.notes, key)
		}
	}
	stillPresent := h.userHasConnLocked(key, conn.User.ID)
	h.mu.Unlock()

	log.Printf("collab: user %d left %s (%d users)", conn.User.ID, key, h.countUsers(key))

	h.broadcastPresence(key)
	if !stillPresent {
		h.broadcastToOthers(key, conn, OutgoingMessage{
			Type:   "leave",
			UserID: conn.User.ID,
		})
	}
}

// userHasConnLocked reports whether `userID` still has at least one
// connection on `key`. Caller must hold h.mu.
func (h *Hub) userHasConnLocked(key string, userID int) bool {
	for c := range h.notes[key] {
		if c.User.ID == userID {
			return true
		}
	}
	return false
}

// BroadcastCursor sends a cursor update from one user to all others on the note.
func (h *Hub) BroadcastCursor(ns, path string, from *Conn, msg IncomingMessage) {
	key := noteKey(ns, path)
	h.broadcastToOthers(key, from, OutgoingMessage{
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
	h.broadcastToOthers(key, from, OutgoingMessage{
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
	h.broadcastToOthers(key, from, OutgoingMessage{
		Type:     "content",
		UserID:   from.User.ID,
		Username: from.User.Username,
		Content:  content,
	})
}

// BroadcastFileChanged notifies all users on a note that it was saved.
// reason is optional: pass "" for a normal save, "restored" for a
// version-history restore (frontend renders a different banner). When
// reason is "restored", restoreFromRef should carry the SHA the file
// was restored from so the banner can quote it.
func (h *Hub) BroadcastFileChanged(ns, path string, byUserID int, byUsername string, etag, reason, restoreFromRef string) {
	// Fan out to every connection on the note. The originator is an
	// HTTP request (PUT /api/note from the browser, the CLI, or an
	// MCP client) — there's no *Conn to exclude. If the change came
	// from a browser tab whose own WS conn happens to be open, that
	// tab will receive a redundant file-changed event for its own
	// save; the App.jsx handler is idempotent in that case (etag
	// already matches; isClean re-fetch is a wasted round trip but
	// harmless). Excluding by user ID, the previous behaviour, broke
	// the common "edit in browser, write via CLI as same user" flow
	// because the browser tab was filtered out of its own update.
	key := noteKey(ns, path)
	h.broadcastToAll(key, OutgoingMessage{
		Type:           "file-changed",
		By:             byUserID,
		Username:       byUsername,
		ETag:           etag,
		Reason:         reason,
		RestoreFromRef: restoreFromRef,
	})
}

// BroadcastTreeChanged notifies all connected clients on a namespace that the file tree changed.
// Used when files are created/deleted/moved via API or CLI. Fan-out is
// connection-scoped — every WS conn on any note in this namespace
// receives the event, including conns belonging to the same user that
// triggered the mutation (HTTP-originated, no *Conn to exclude).
func (h *Hub) BroadcastTreeChanged(ns string) {
	data, err := json.Marshal(OutgoingMessage{Type: "tree-changed"})
	if err != nil {
		return
	}
	h.localNsPrefix(ns, data)
	h.publish(wireMsg{Type: wireNsPrefix, Ns: ns, Payload: data})
}

// localNsPrefix delivers data to every local conn whose note belongs to ns.
func (h *Hub) localNsPrefix(ns string, data []byte) {
	prefix := ns + ":"
	h.mu.RLock()
	targets := make([]*Conn, 0)
	for key, conns := range h.notes {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			for c := range conns {
				targets = append(targets, c)
			}
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.Send(data)
	}
}

// BroadcastAccessChanged notifies ALL connected clients that permissions changed.
// Used when users are invited, grants created/modified/deleted.
func (h *Hub) BroadcastAccessChanged() {
	data, err := json.Marshal(OutgoingMessage{Type: "access-changed"})
	if err != nil {
		return
	}
	h.localAll(data)
	h.publish(wireMsg{Type: wireAll, Payload: data})
}

// localAll delivers data to every local conn on any note.
func (h *Hub) localAll(data []byte) {
	h.mu.RLock()
	targets := make([]*Conn, 0)
	for _, conns := range h.notes {
		for c := range conns {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.Send(data)
	}
}

func (h *Hub) broadcastPresence(key string) {
	localUsers := h.sendPresenceLocal(key)
	// Advertise our local view (possibly empty — e.g. after the last local
	// conn on this note left) so peers refresh or drop our contribution.
	h.publish(wireMsg{Type: wirePresence, Key: key, Users: localUsers})
}

// sendPresenceLocal builds the merged participant list (this instance's users
// plus every live peer's) and sends it to this instance's connections on key.
// It returns the local-only user-set so callers can advertise it to peers.
// It never publishes, so it is safe to call when handling a peer's presence
// update (no echo storm).
func (h *Hub) sendPresenceLocal(key string) []UserInfo {
	h.mu.RLock()
	conns := h.notes[key]
	// Deduplicate by user ID — the presence list is a set of users, not
	// connections, so two tabs from the same user surface as one participant.
	seen := make(map[int]bool, len(conns))
	localUsers := make([]UserInfo, 0, len(conns))
	targets := make([]*Conn, 0, len(conns))
	for c := range conns {
		targets = append(targets, c)
		if !seen[c.User.ID] {
			seen[c.User.ID] = true
			localUsers = append(localUsers, c.User)
		}
	}
	h.mu.RUnlock()

	users := h.mergedPresence(key, localUsers)
	data, _ := json.Marshal(OutgoingMessage{
		Type:  "presence",
		Users: users,
	})

	for _, c := range targets {
		c.Send(data)
	}
	return localUsers
}

// mergedPresence returns the union (deduplicated by user ID) of localUsers and
// every non-expired peer's advertised users for key. Expired peer entries are
// pruned lazily here.
func (h *Hub) mergedPresence(key string, localUsers []UserInfo) []UserInfo {
	now := time.Now()
	result := make([]UserInfo, 0, len(localUsers)+4)
	seen := make(map[int]bool, len(localUsers)+4)
	for _, u := range localUsers {
		if !seen[u.ID] {
			seen[u.ID] = true
			result = append(result, u)
		}
	}

	h.rmu.Lock()
	origins := h.remote[key]
	for origin, rp := range origins {
		if now.After(rp.expiresAt) {
			delete(origins, origin)
			continue
		}
		for _, u := range rp.users {
			if !seen[u.ID] {
				seen[u.ID] = true
				result = append(result, u)
			}
		}
	}
	if len(origins) == 0 {
		delete(h.remote, key)
	}
	h.rmu.Unlock()

	return result
}

// setRemotePresence records (or clears, when users is empty) a peer's
// advertised user-set for a note.
func (h *Hub) setRemotePresence(key, origin string, users []UserInfo) {
	h.rmu.Lock()
	if len(users) == 0 {
		if origins, ok := h.remote[key]; ok {
			delete(origins, origin)
			if len(origins) == 0 {
				delete(h.remote, key)
			}
		}
		h.rmu.Unlock()
		return
	}
	if h.remote[key] == nil {
		h.remote[key] = make(map[string]remotePresence)
	}
	h.remote[key][origin] = remotePresence{
		users:     users,
		expiresAt: time.Now().Add(presenceTTL),
	}
	h.rmu.Unlock()
}

// onRemote handles an envelope received from a peer instance. It is the
// delivery callback wired into the backplane. Messages this instance
// published are ignored (they were already applied locally when sent).
func (h *Hub) onRemote(m wireMsg) {
	if m.Origin == h.id {
		return
	}
	switch m.Type {
	case wireNote:
		h.localNote(m.Key, nil, m.Payload)
	case wireNsPrefix:
		h.localNsPrefix(m.Ns, m.Payload)
	case wireAll:
		h.localAll(m.Payload)
	case wirePresence:
		h.setRemotePresence(m.Key, m.Origin, m.Users)
		// Re-emit the merged list to our local conns; do NOT publish here
		// (that would bounce the presence update back and forth forever).
		h.sendPresenceLocal(m.Key)
	}
}

// presenceHeartbeatLoop periodically re-advertises this instance's local
// presence for every active note so peers' TTLs are refreshed and a crashed
// instance's users age out. Runs only when a backplane is enabled.
func (h *Hub) presenceHeartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(presenceHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.mu.RLock()
			snapshot := make(map[string][]UserInfo, len(h.notes))
			for key, conns := range h.notes {
				seen := make(map[int]bool, len(conns))
				us := make([]UserInfo, 0, len(conns))
				for c := range conns {
					if !seen[c.User.ID] {
						seen[c.User.ID] = true
						us = append(us, c.User)
					}
				}
				snapshot[key] = us
			}
			h.mu.RUnlock()

			for key, us := range snapshot {
				h.publish(wireMsg{Type: wirePresence, Key: key, Users: us})
			}
		}
	}
}

// broadcastToOthers sends `msg` to every conn on `key` except `exclude`.
// Identity is by pointer — the caller is the WS conn that received the
// triggering event, so the originating tab never receives its own echo.
// `exclude` may be nil for HTTP-triggered broadcasts; prefer
// broadcastToAll there for clarity.
func (h *Hub) broadcastToOthers(key string, exclude *Conn, msg OutgoingMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.localNote(key, exclude, data)
	h.publish(wireMsg{Type: wireNote, Key: key, Payload: data})
}

// localNote delivers pre-marshaled data to every local conn on key except
// exclude. Used both for locally-originated events (exclude = originating
// conn) and for events relayed from a peer instance (exclude = nil).
func (h *Hub) localNote(key string, exclude *Conn, data []byte) {
	h.mu.RLock()
	conns := h.notes[key]
	targets := make([]*Conn, 0, len(conns))
	for c := range conns {
		if c != exclude {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range targets {
		c.Send(data)
	}
}

// broadcastToAll fans out `msg` to every conn on `key` with no
// exclusion. Used for HTTP-triggered events (file-changed, etc.) where
// there's no originating *Conn to filter.
func (h *Hub) broadcastToAll(key string, msg OutgoingMessage) {
	h.broadcastToOthers(key, nil, msg)
}

// countUsers returns the number of distinct users (not connections)
// currently present on the given note.
func (h *Hub) countUsers(key string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	seen := make(map[int]bool)
	for c := range h.notes[key] {
		seen[c.User.ID] = true
	}
	return len(seen)
}
