package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/mdnest/mdnest/backend/storage"
)

type MoveHandler struct {
	store       storage.Storage
	chatMembers chatMembersFollow // nil unless private chats are on
}

// SetChatMembers makes a move carry private chats' member lists along.
func (h *MoveHandler) SetChatMembers(m chatMembersFollow) { h.chatMembers = m }

func NewMoveHandler(store storage.Storage) *MoveHandler {
	return &MoveHandler{store: store}
}

// HandleMove handles POST /api/move?ns=...&from=...&to=...
// Moves a file or folder from one path to another within the same namespace.
func (h *MoveHandler) HandleMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}

	fromRel, ok := SafeRelPath(r.URL.Query().Get("from"))
	if !ok {
		http.Error(w, `{"error":"invalid source path"}`, http.StatusBadRequest)
		return
	}

	toRel, ok := SafeRelPath(r.URL.Query().Get("to"))
	if !ok {
		http.Error(w, `{"error":"invalid destination path"}`, http.StatusBadRequest)
		return
	}

	if _, err := h.store.Stat(ctx, ns, fromRel); errors.Is(err, storage.ErrNotExist) {
		http.Error(w, `{"error":"source not found"}`, http.StatusNotFound)
		return
	}
	// Never onto something that exists. The local backend's rename replaces
	// a file silently, which loses its content, and with private chats it
	// also lets a writer drop their own private chat over a shared note and
	// take it away from everyone else (issue #127). /api/transfer already
	// refuses an existing destination the same way.
	// A rename that only changes letter case is the same file on a
	// case-insensitive mount, so it is let through.
	if _, err := h.store.Stat(ctx, ns, toRel); err == nil && !strings.EqualFold(fromRel, toRel) {
		http.Error(w, `{"error":"destination already exists"}`, http.StatusConflict)
		return
	}

	copied, ok := chatMembersBeforeMove(ctx, h.store, h.chatMembers, ns, fromRel, ns, toRel)
	if !ok {
		http.Error(w, `{"error":"failed to move item"}`, http.StatusInternalServerError)
		return
	}
	err := h.store.Rename(ctx, ns, fromRel, toRel)
	chatMembersAfter(h.chatMembers, copied, err == nil)
	if err != nil {
		http.Error(w, `{"error":"failed to move item"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "moved"})
}
