package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/middleware"
)

const maxNoteSize = 10 << 20 // 10MB

type NoteHandler struct {
	notesDir string
	hub      *collab.Hub // nil when collab disabled
}

func NewNoteHandler(notesDir string) *NoteHandler {
	return &NoteHandler{notesDir: notesDir}
}

// SetCollabHub sets the collaboration hub for broadcasting file changes.
func (h *NoteHandler) SetCollabHub(hub *collab.Hub) {
	h.hub = hub
}

func contentETag(data []byte) string {
	hash := sha256.Sum256(data)
	return `"` + hex.EncodeToString(hash[:16]) + `"`
}

func (h *NoteHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.getNote(w, r)
	case http.MethodPut:
		h.updateNote(w, r)
	case http.MethodPost:
		h.createNote(w, r)
	case http.MethodDelete:
		h.deleteNote(w, r)
	case http.MethodPatch:
		h.patchNote(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *NoteHandler) getNote(w http.ResponseWriter, r *http.Request) {
	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}
	reqPath := r.URL.Query().Get("path")
	absPath := SafePath(nsDir, reqPath)
	if absPath == "" {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"failed to read file"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("ETag", contentETag(data))
	w.Write(data)
}

func (h *NoteHandler) updateNote(w http.ResponseWriter, r *http.Request) {
	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}
	ns := r.URL.Query().Get("ns")
	reqPath := r.URL.Query().Get("path")
	absPath := SafePath(nsDir, reqPath)
	if absPath == "" {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	// Read current file for existence check and ETag verification
	currentData, err := os.ReadFile(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"failed to read file"}`, http.StatusInternalServerError)
		return
	}

	// If-Match: optimistic locking for conflict detection
	ifMatch := r.Header.Get("If-Match")
	if ifMatch != "" {
		currentETag := contentETag(currentData)
		if ifMatch != currentETag {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", currentETag)
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "file was modified by another user",
				"etag":  currentETag,
			})
			return
		}
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxNoteSize))
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		http.Error(w, `{"error":"failed to create directories"}`, http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(absPath, body, 0644); err != nil {
		http.Error(w, `{"error":"failed to write file"}`, http.StatusInternalServerError)
		return
	}

	newETag := contentETag(body)

	// Broadcast file-changed to other users on this note
	if h.hub != nil {
		uc := middleware.UserFromContext(r.Context())
		username := "unknown"
		userID := 0
		if uc != nil {
			username = uc.Username
			userID = uc.ID
		}
		h.hub.BroadcastFileChanged(ns, reqPath, userID, username, newETag)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", newETag)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "etag": newETag})
}

func (h *NoteHandler) createNote(w http.ResponseWriter, r *http.Request) {
	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}
	reqPath := r.URL.Query().Get("path")
	absPath := SafePath(nsDir, reqPath)
	if absPath == "" {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(absPath); err == nil {
		http.Error(w, `{"error":"file already exists"}`, http.StatusConflict)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxNoteSize))
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		http.Error(w, `{"error":"failed to create directories"}`, http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(absPath, body, 0644); err != nil {
		http.Error(w, `{"error":"failed to write file"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "created"})
}

func (h *NoteHandler) deleteNote(w http.ResponseWriter, r *http.Request) {
	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}
	reqPath := r.URL.Query().Get("path")
	absPath := SafePath(nsDir, reqPath)
	if absPath == "" {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	info, err := os.Stat(absPath)
	if os.IsNotExist(err) {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	if info.IsDir() {
		err = os.RemoveAll(absPath)
	} else {
		err = os.Remove(absPath)
	}
	if err != nil {
		http.Error(w, `{"error":"failed to delete"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func (h *NoteHandler) patchNote(w http.ResponseWriter, r *http.Request) {
	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}
	reqPath := r.URL.Query().Get("path")
	absPath := SafePath(nsDir, reqPath)
	if absPath == "" {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	position := r.URL.Query().Get("position")
	if position == "" {
		position = "bottom"
	}
	if position != "top" && position != "bottom" {
		http.Error(w, `{"error":"position must be top or bottom"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxNoteSize))
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}
	text := string(body)

	// Read existing content (empty if file doesn't exist yet)
	existing := ""
	data, err := os.ReadFile(absPath)
	if err == nil {
		existing = string(data)
	} else if !os.IsNotExist(err) {
		http.Error(w, `{"error":"failed to read file"}`, http.StatusInternalServerError)
		return
	}

	// Combine based on position
	var result string
	if position == "top" {
		if existing != "" {
			result = text + "\n" + existing
		} else {
			result = text
		}
	} else {
		if existing != "" {
			result = strings.TrimRight(existing, "\n") + "\n" + text
		} else {
			result = text
		}
	}

	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		http.Error(w, `{"error":"failed to create directories"}`, http.StatusInternalServerError)
		return
	}
	if err := os.WriteFile(absPath, []byte(result), 0644); err != nil {
		http.Error(w, `{"error":"failed to write file"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
