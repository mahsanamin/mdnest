package handlers

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

type UploadHandler struct {
	store storage.Storage
	perms *middleware.PermissionChecker // nil in single mode
	// attachmentProxy, when set (git-native HA app replicas), forwards
	// /api/files/ downloads to the writer, which owns the attachment bytes.
	attachmentProxy http.Handler
}

func NewUploadHandler(store storage.Storage, perms *middleware.PermissionChecker) *UploadHandler {
	return &UploadHandler{store: store, perms: perms}
}

// SetAttachmentProxy makes /api/files/ downloads reverse-proxy to the writer.
// Used on stateless app replicas, which hold no attachment bytes locally.
func (h *UploadHandler) SetAttachmentProxy(p http.Handler) { h.attachmentProxy = p }

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

	// Stateless app replicas hold no attachment bytes — those live on the
	// writer's git tree. Forward the (already authenticated) request to the
	// writer, which serves it with range/conditional-GET support and re-checks
	// the per-namespace read permission with the same forwarded credentials.
	if h.attachmentProxy != nil {
		h.attachmentProxy.ServeHTTP(w, r)
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

	// Enforce the same per-namespace read permission as every other content
	// endpoint. Without this an authenticated user could fetch any file in any
	// namespace by guessing the URL (the /api/files/ route can't use the query
	// param middleware because the namespace lives in the path). Nil perms means
	// single-user mode, where all access is granted.
	if h.perms != nil && !h.perms.CheckRead(r, ns, "/"+relPath) {
		middleware.DenyJSON(w)
		return
	}

	if ct := mime.TypeByExtension(path.Ext(relPath)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}

	// Prefer range/conditional-GET support when the backend can hand out a
	// seekable reader (local filesystem). This keeps browser image caching
	// (304s) and media seeking working, which a plain stream would break.
	// Backends that can only stream (object stores) fall back to a copy.
	if rr, ok := h.store.(storage.RangeReadable); ok {
		rs, info, err := rr.OpenSeek(ctx, ns, relPath)
		if err != nil {
			http.Error(w, `{"error":"file not found"}`, http.StatusNotFound)
			return
		}
		defer rs.Close()
		http.ServeContent(w, r, path.Base(relPath), info.ModTime, rs)
		return
	}

	rc, err := h.store.Open(ctx, ns, relPath)
	if err != nil {
		http.Error(w, `{"error":"file not found"}`, http.StatusNotFound)
		return
	}
	defer rc.Close()
	io.Copy(w, rc)
}
