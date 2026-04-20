package collab

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"nhooyr.io/websocket"
)

const (
	writeTimeout = 5 * time.Second
	pingInterval = 15 * time.Second
)

// Conn wraps a WebSocket connection with user identity.
type Conn struct {
	User      UserInfo
	SessionID string // unique per browser tab (frontend CollabClient instance)
	ws        *websocket.Conn
	send      chan []byte
}

// NewConn creates a new connection wrapper.
func NewConn(ws *websocket.Conn, userID int, username string, sessionID string) *Conn {
	return &Conn{
		User: UserInfo{
			ID:       userID,
			Username: username,
			Color:    colorForUser(userID),
		},
		SessionID: sessionID,
		ws:        ws,
		send:      make(chan []byte, 64),
	}
}

// Close forcefully closes the WebSocket connection (normal closure).
func (c *Conn) Close() {
	c.ws.Close(websocket.StatusGoingAway, "replaced by new connection")
}

// CloseSuperseded sends a "session_superseded" message then closes.
// Uses a JSON message instead of a custom close code because proxies
// (Caddy, nginx) can strip or remap WebSocket close codes.
func (c *Conn) CloseSuperseded() {
	// Send supersede message — the frontend handles this in onMessage
	msg := []byte(`{"type":"session_superseded"}`)
	c.Send(msg)
	// Give the message time to flush before closing
	go func() {
		time.Sleep(500 * time.Millisecond)
		c.ws.Close(websocket.StatusGoingAway, "session_superseded")
	}()
}

// Send queues a message to be sent. Non-blocking — drops if buffer full.
func (c *Conn) Send(data []byte) {
	select {
	case c.send <- data:
	default:
		// Buffer full — drop message to avoid blocking
	}
}

// ReadLoop reads messages from the client and dispatches them.
// Blocks until the connection is closed.
func (c *Conn) ReadLoop(ctx context.Context, hub *Hub, ns, path string) {
	defer func() {
		hub.Leave(ns, path, c.User.ID)
		c.ws.Close(websocket.StatusNormalClosure, "")
	}()

	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			return // Connection closed
		}

		var msg IncomingMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "cursor":
			hub.BroadcastCursor(ns, path, c, msg)
		case "selection":
			hub.BroadcastSelection(ns, path, c, msg)
		case "content":
			hub.BroadcastContent(ns, path, c, msg.Content)
		}
	}
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
			err := c.ws.Write(writeCtx, websocket.MessageText, data)
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
