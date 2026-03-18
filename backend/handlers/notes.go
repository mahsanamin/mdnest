package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

type NoteHandler struct {
	notesDir string
}

func NewNoteHandler(notesDir string) *NoteHandler {
	return &NoteHandler{notesDir: notesDir}
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
	w.Write(data)
}

func (h *NoteHandler) updateNote(w http.ResponseWriter, r *http.Request) {
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
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(r.Body)
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
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
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
	body, err := io.ReadAll(r.Body)
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
