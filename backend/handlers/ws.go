package handlers

import (
	"log"
	"net/http"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/collab"
	"nhooyr.io/websocket"
)

// WSHandler handles WebSocket connections for live collaboration.
type WSHandler struct {
	hub    *collab.Hub
	secret []byte
}

// NewWSHandler creates a new WebSocket handler.
func NewWSHandler(hub *collab.Hub, jwtSecret string) *WSHandler {
	return &WSHandler{hub: hub, secret: []byte(jwtSecret)}
}

// HandleWS upgrades to WebSocket and manages the connection lifecycle.
// Query params: ns, path, token (JWT for auth).
func (h *WSHandler) HandleWS(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	path := r.URL.Query().Get("path")
	tokenStr := r.URL.Query().Get("token")

	if ns == "" || path == "" || tokenStr == "" {
		http.Error(w, `{"error":"ns, path, and token are required"}`, http.StatusBadRequest)
		return
	}

	// Verify JWT
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return h.secret, nil
	})
	if err != nil || !token.Valid {
		http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
		return
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		http.Error(w, `{"error":"invalid token claims"}`, http.StatusUnauthorized)
		return
	}

	userID := 0
	username := "unknown"
	if v, ok := claims["user_id"].(float64); ok {
		userID = int(v)
	}
	if v, ok := claims["sub"].(string); ok {
		username = v
	}

	// Upgrade to WebSocket
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		log.Printf("collab: websocket upgrade failed: %v", err)
		return
	}

	sessionID := r.URL.Query().Get("sid")
	conn := collab.NewConn(ws, userID, username, sessionID)
	h.hub.Join(ns, path, conn)

	ctx := r.Context()

	// Run read and write loops concurrently
	go conn.WriteLoop(ctx)
	conn.ReadLoop(ctx, h.hub, ns, path) // blocks until disconnect
}
