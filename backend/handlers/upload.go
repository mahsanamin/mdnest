package handlers

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/mdnest/mdnest/backend/storage"
)

type UploadHandler struct {
	store storage.Storage
}

func NewUploadHandler(store storage.Storage) *UploadHandler {
	return &UploadHandler{store: store}
}

// HandleFolder handles POST /api/folder?ns=...&path=...
func (h *UploadHandler) HandleFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	relPath, ok := SafeRelPath(r.URL.Query().Get("path"))
	if !ok {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}
	if err := h.store.MkdirAll(ctx, ns, relPath); err != nil {
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
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}
	reqRel, ok := SafeRelPath(r.URL.Query().Get("path"))
	if !ok {
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

	// Destination is the uploaded filename inside the requested directory.
	filename := path.Base(header.Filename)
	destRel, ok := SafeRelPath(path.Join(path.Dir(reqRel), filename))
	if !ok {
		http.Error(w, `{"error":"invalid upload destination"}`, http.StatusBadRequest)
		return
	}

	if err := h.store.WriteFrom(ctx, ns, destRel, file, header.Size); err != nil {
		http.Error(w, `{"error":"failed to save file"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"url": destRel})
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
	if !ValidNamespaceName(ns) {
		http.Error(w, `{"error":"invalid namespace"}`, http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	if ok, err := h.store.NamespaceExists(ctx, ns); err != nil || !ok {
		http.Error(w, `{"error":"namespace not found"}`, http.StatusNotFound)
		return
	}

	if len(parts) < 2 || parts[1] == "" {
		http.Error(w, `{"error":"missing file path"}`, http.StatusBadRequest)
		return
	}

	relPath, ok := SafeRelPath(parts[1])
	if !ok {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	rc, err := h.store.Open(ctx, ns, relPath)
	if err != nil {
		http.Error(w, `{"error":"file not found"}`, http.StatusNotFound)
		return
	}
	defer rc.Close()

	if ct := mime.TypeByExtension(path.Ext(relPath)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	io.Copy(w, rc)
}
