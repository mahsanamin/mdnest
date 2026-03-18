package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"
)

// NamespaceHandler lists available namespaces (top-level dirs in NOTES_DIR).
type NamespaceHandler struct {
	notesDir string
}

// NewNamespaceHandler creates a new namespace handler.
func NewNamespaceHandler(notesDir string) *NamespaceHandler {
	return &NamespaceHandler{notesDir: notesDir}
}

// ListNamespaces handles GET /api/namespaces.
func (h *NamespaceHandler) ListNamespaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	entries, err := os.ReadDir(h.notesDir)
	if err != nil {
		http.Error(w, `{"error":"failed to read notes directory"}`, http.StatusInternalServerError)
		return
	}

	names := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(names)
}
