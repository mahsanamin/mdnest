package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/mdnest/mdnest/backend/storage"
)

type MoveHandler struct {
	store storage.Storage
}

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

	if err := h.store.Rename(ctx, ns, fromRel, toRel); err != nil {
		http.Error(w, `{"error":"failed to move item"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "moved"})
}
