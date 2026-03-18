package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
)

type MoveHandler struct {
	notesDir string
}

func NewMoveHandler(notesDir string) *MoveHandler {
	return &MoveHandler{notesDir: notesDir}
}

// HandleMove handles POST /api/move?ns=...&from=...&to=...
// Moves a file or folder from one path to another within the same namespace.
func (h *MoveHandler) HandleMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}

	fromPath := r.URL.Query().Get("from")
	toPath := r.URL.Query().Get("to")

	absSrc := SafePath(nsDir, fromPath)
	if absSrc == "" {
		http.Error(w, `{"error":"invalid source path"}`, http.StatusBadRequest)
		return
	}

	absDst := SafePath(nsDir, toPath)
	if absDst == "" {
		http.Error(w, `{"error":"invalid destination path"}`, http.StatusBadRequest)
		return
	}

	if _, err := os.Stat(absSrc); os.IsNotExist(err) {
		http.Error(w, `{"error":"source not found"}`, http.StatusNotFound)
		return
	}

	// Ensure destination parent exists
	if err := os.MkdirAll(filepath.Dir(absDst), 0700); err != nil {
		http.Error(w, `{"error":"failed to create destination directory"}`, http.StatusInternalServerError)
		return
	}

	if err := os.Rename(absSrc, absDst); err != nil {
		http.Error(w, `{"error":"failed to move item"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "moved"})
}
