package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type UploadHandler struct {
	notesDir string
}

func NewUploadHandler(notesDir string) *UploadHandler {
	return &UploadHandler{notesDir: notesDir}
}

// HandleFolder handles POST /api/folder?ns=...&path=...
func (h *UploadHandler) HandleFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
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
	if err := os.MkdirAll(absPath, 0755); err != nil {
		http.Error(w, `{"error":"failed to create folder"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "created"})
}

// HandleUpload handles POST /api/upload?ns=...&path=...
func (h *UploadHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}
	reqPath := r.URL.Query().Get("path")
	notePath := SafePath(nsDir, reqPath)
	if notePath == "" {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20) // 32MB hard limit
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, `{"error":"failed to parse multipart form"}`, http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, `{"error":"missing file field"}`, http.StatusBadRequest)
		return
	}
	defer file.Close()

	noteDir := filepath.Dir(notePath)
	if err := os.MkdirAll(noteDir, 0755); err != nil {
		http.Error(w, `{"error":"failed to create directory"}`, http.StatusInternalServerError)
		return
	}

	filename := filepath.Base(header.Filename)
	destPath := filepath.Join(noteDir, filename)

	destSafe := SafePath(nsDir, filepath.Join(filepath.Dir(reqPath), filename))
	if destSafe == "" {
		http.Error(w, `{"error":"invalid upload destination"}`, http.StatusBadRequest)
		return
	}

	out, err := os.Create(destPath)
	if err != nil {
		http.Error(w, `{"error":"failed to create file"}`, http.StatusInternalServerError)
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		http.Error(w, `{"error":"failed to save file"}`, http.StatusInternalServerError)
		return
	}

	relPath, err := filepath.Rel(nsDir, destPath)
	if err != nil {
		http.Error(w, `{"error":"failed to compute relative path"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"url": relPath})
}

// HandleServeFile serves files at /api/files/{namespace}/path/to/file
func (h *UploadHandler) HandleServeFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	fullPath := strings.TrimPrefix(r.URL.Path, "/api/files/")
	if fullPath == "" {
		http.Error(w, `{"error":"missing path"}`, http.StatusBadRequest)
		return
	}

	// First segment is namespace, rest is file path
	parts := strings.SplitN(fullPath, "/", 2)
	ns := parts[0]

	nsClean := filepath.Clean(ns)
	if nsClean != ns || strings.Contains(ns, "/") || strings.HasPrefix(ns, ".") {
		http.Error(w, `{"error":"invalid namespace"}`, http.StatusBadRequest)
		return
	}

	nsDir := filepath.Join(h.notesDir, ns)
	if info, err := os.Stat(nsDir); err != nil || !info.IsDir() {
		http.Error(w, `{"error":"namespace not found"}`, http.StatusNotFound)
		return
	}

	if len(parts) < 2 || parts[1] == "" {
		http.Error(w, `{"error":"missing file path"}`, http.StatusBadRequest)
		return
	}

	absPath := SafePath(nsDir, parts[1])
	if absPath == "" {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	http.ServeFile(w, r, absPath)
}
