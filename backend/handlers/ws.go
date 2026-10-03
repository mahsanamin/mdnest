package handlers

import (
	"log"
	"net/http"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/middleware"
	"nhooyr.io/websocket"
)

// WSHandler handles WebSocket connections for live collaboration.
type WSHandler struct {
	hub    *collab.Hub
	secret []byte
	perms  *middleware.PermissionChecker
}

// NewWSHandler creates a new WebSocket handler. perms is required: live
// collaboration is multi-mode only, and a room carries the note's live content,
// so joining one is a read of the note and editing in it is a write.
func NewWSHandler(hub *collab.Hub, jwtSecret string, perms *middleware.PermissionChecker) *WSHandler {
	return &WSHandler{hub: hub, secret: []byte(jwtSecret), perms: perms}
}

// HandleWS upgrades to WebSocket and manages the connection lifecycle.
// Query params: ns, path, token (JWT for auth).
func (h *WSHandler) HandleWS(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	rawPath := r.URL.Query().Get("path")
	tokenStr := r.URL.Query().Get("token")

	if ns == "" || rawPath == "" || tokenStr == "" {
		http.Error(w, `{"error":"ns, path, and token are required"}`, http.StatusBadRequest)
		return
	}

	// The same session rule as every other route: a login step token (one
	// with a purpose claim) is not a session.
	claims, err := middleware.ParseSessionToken(h.secret, tokenStr)
	if err != nil {
		http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
		return
	}
	uc := middleware.UserFromClaims(claims)

	// The room is keyed by the cleaned path — the path that is authorised is
	// the path whose live content is shared — and the user must be able to
	// read the note to join. Fail closed without a checker.
	if !ValidNamespaceName(ns) {
		http.Error(w, `{"error":"invalid namespace"}`, http.StatusBadRequest)
		return
	}
	path, ok := SafeRelPath(rawPath)
	if !ok {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	r = middleware.WithUser(r, uc)
	if h.perms == nil || !h.perms.CheckRead(r, ns, "/"+path) {
		middleware.DenyJSON(w)
		return
	}
	readOnly := !h.perms.CheckWrite(r, ns, "/"+path)

	// Upgrade to WebSocket
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		log.Printf("collab: websocket upgrade failed: %v", err)
		return
	}

	conn := collab.NewConn(ws, uc.ID, uc.Username)
	conn.ReadOnly = readOnly
	h.hub.Join(ns, path, conn)

	ctx := r.Context()

	// Run read and write loops concurrently
	go conn.WriteLoop(ctx)
	conn.ReadLoop(ctx, h.hub, ns, path) // blocks until disconnect
}
