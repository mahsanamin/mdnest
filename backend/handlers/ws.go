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
// Query params: token (JWT for auth), and optionally ns + path.
//
// Without ns and path the connection serves the whole visit: the client
// sends {"type":"join","ns","path","seq"} to move it to a note, and each join
// is checked here exactly like the handshake below. With ns and path (a tab
// from before v4.8.13) it starts in that note, checked before the upgrade.
func (h *WSHandler) HandleWS(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	rawPath := r.URL.Query().Get("path")
	tokenStr := r.URL.Query().Get("token")

	if tokenStr == "" {
		http.Error(w, `{"error":"token is required"}`, http.StatusBadRequest)
		return
	}
	perNote := ns != "" || rawPath != ""

	// The same session rule as every other route: a login step token (one
	// with a purpose claim) is not a session.
	claims, err := middleware.ParseSessionToken(h.secret, tokenStr)
	if err != nil {
		http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
		return
	}
	uc := middleware.UserFromClaims(claims)
	r = middleware.WithUser(r, uc)
	if h.perms == nil {
		// Fail closed without a checker.
		middleware.DenyJSON(w)
		return
	}
	authorize := func(ns, rawPath string) (string, bool, string) { return h.authorize(r, ns, rawPath) }

	var path string
	var readOnly bool
	if perNote {
		var code string
		path, readOnly, code = authorize(ns, rawPath)
		switch code {
		case "":
		case "invalid-namespace":
			http.Error(w, `{"error":"invalid namespace"}`, http.StatusBadRequest)
			return
		case "invalid-path":
			http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
			return
		default:
			middleware.DenyJSON(w)
			return
		}
	}

	// Upgrade to WebSocket
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		log.Printf("collab: websocket upgrade failed: %v", err)
		return
	}

	// A Yjs snapshot or a big paste is larger than the library's 32 KB
	// default read limit, which would close the socket mid-edit.
	if h.hub.SharedEditing() {
		ws.SetReadLimit(collab.YjsMaxFrameBytes)
	}

	conn := collab.NewConn(ws, uc.ID, uc.Username)
	conn.Authorize = authorize
	// The socket lasts the visit, so it must not outlive the login.
	if exp, err := claims.GetExpirationTime(); err == nil && exp != nil {
		conn.Expires = exp.Time
	}
	if perNote {
		conn.Enter(h.hub, ns, path, readOnly)
	}

	ctx := r.Context()

	// Run read and write loops concurrently
	go conn.WriteLoop(ctx)
	conn.ReadLoop(ctx, h.hub) // blocks until disconnect
}

// authorize is the check for being in a note, at the handshake and on every
// join: the room is keyed by the cleaned path (the path that is authorised is
// the path whose live content is shared), the user must be able to read the
// note to be there, and editing in it is a write. The checker applies grants,
// groups, path scopes and private chat membership, as for any request.
func (h *WSHandler) authorize(r *http.Request, ns, rawPath string) (string, bool, string) {
	if !ValidNamespaceName(ns) {
		return "", false, "invalid-namespace"
	}
	path, ok := SafeRelPath(rawPath)
	if !ok || path == "" {
		return "", false, "invalid-path"
	}
	if !h.perms.CheckRead(r, ns, "/"+path) {
		return "", false, "forbidden"
	}
	return path, !h.perms.CheckWrite(r, ns, "/"+path), ""
}
