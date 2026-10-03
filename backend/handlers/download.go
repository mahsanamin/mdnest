package handlers

import (
	"archive/zip"
	"compress/flate"
	"context"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/mdnest/mdnest/backend/storage"
)

// DownloadHandler serves GET /api/download?ns=&path= — a file as itself, a
// folder as a zip that keeps its hierarchy. Read access is checked by the
// RequireRead middleware against the cleaned ?path= (not RequireNsAccess: a
// grant scoped to /Shared must not be able to zip /Private).
type DownloadHandler struct {
	store  storage.Storage
	limits TreeLimits
	slots  *downloadSlots
	// writerProxy, when set (MDNEST_ROLE=app), forwards the request to the
	// writer: an app replica's working set holds no attachments and no bodies
	// over the cache cap, so a zip built there would silently miss files.
	writerProxy http.Handler
}

// NewDownloadHandler builds the handler. maxConcurrent is the server-wide cap
// on concurrent zip downloads (DOWNLOAD_MAX_CONCURRENT); each user may also
// hold at most one.
func NewDownloadHandler(store storage.Storage, limits TreeLimits, maxConcurrent int) *DownloadHandler {
	return &DownloadHandler{store: store, limits: limits, slots: newDownloadSlots(maxConcurrent)}
}

// SetWriterProxy makes downloads reverse-proxy to the writer (MDNEST_ROLE=app).
func (h *DownloadHandler) SetWriterProxy(p http.Handler) { h.writerProxy = p }

// zipRetryAfter is the Retry-After (seconds) sent with a 429.
const zipRetryAfter = "5"

func (h *DownloadHandler) HandleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.writerProxy != nil {
		h.writerProxy.ServeHTTP(w, r)
		return
	}
	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}

	// An empty path is the namespace root (downloaded as <ns>.zip).
	rel := ""
	name := ns
	if raw := r.URL.Query().Get("path"); raw != "" {
		var ok bool
		rel, ok = SafeRelPath(raw)
		if !ok || hasReservedSegment(rel) {
			http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
			return
		}
		name = path.Base(rel)
	}
	// A linked path (the item or a parent folder) is not exported: the read
	// grant was checked against the link's name, not where it leads.
	if linkedPath(ctx, h.store, ns, rel) {
		writeStatusJSON(w, http.StatusBadRequest, map[string]any{"error": "symlink", "path": rel})
		return
	}

	info, err := h.store.Stat(ctx, ns, rel)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	if !info.IsDir {
		h.serveFile(w, r, ns, rel, name)
		return
	}

	plan, err := planTree(ctx, h.store, ns, rel)
	if err != nil {
		if errors.Is(err, storage.ErrNotExist) {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"failed to read folder"}`, http.StatusInternalServerError)
		return
	}
	if len(plan.entries) == 0 {
		// The root itself was a symlink: nothing we are willing to export.
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	// Refused before the first byte, so the client gets a JSON body it can
	// show instead of a truncated archive.
	if plan.tooLarge(h.limits) {
		writeTooLarge(w, plan, h.limits)
		return
	}
	release, err := h.slots.acquire(slotKey(r))
	if err != nil {
		w.Header().Set("Retry-After", zipRetryAfter)
		writeStatusJSON(w, http.StatusTooManyRequests, map[string]string{"error": "busy"})
		return
	}
	// Released on every path out, including a client that hangs up mid-stream
	// (the request context is cancelled and writeZip returns).
	defer release()

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", contentDisposition(name+".zip"))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodHead {
		return
	}
	if err := h.writeZip(ctx, w, ns, rel, name, plan); err != nil && ctx.Err() == nil {
		log.Printf("download: ns=%s path=%s: %v", ns, rel, err)
	}
}

// serveFile sends one file as an attachment, with range support when the
// backend can seek (same path as /api/files/, plus Content-Disposition).
func (h *DownloadHandler) serveFile(w http.ResponseWriter, r *http.Request, ns, rel, name string) {
	ctx := r.Context()
	ct := mime.TypeByExtension(path.Ext(rel))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	setServedFileSafetyHeaders(w, rel, ct)
	w.Header().Set("Content-Disposition", contentDisposition(name))
	if rr, ok := h.store.(storage.RangeReadable); ok {
		rs, info, err := rr.OpenSeek(ctx, ns, rel)
		if err != nil {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		defer rs.Close()
		http.ServeContent(w, r, name, info.ModTime, rs)
		return
	}
	rc, err := h.store.Open(ctx, ns, rel)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	defer rc.Close()
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, rc)
	}
}

// errZipBudget aborts a zip whose files grew past the byte limit after the
// pre-walk counted them.
var errZipBudget = errors.New("download: folder grew past the size limit while streaming")

// writeZip streams the planned entries into w. Paths inside the archive start
// at the folder's own name. The context is checked before every entry and on
// every read, so a cancelled download stops promptly.
func (h *DownloadHandler) writeZip(ctx context.Context, w io.Writer, ns, root, name string, plan *treePlan) error {
	zw := zip.NewWriter(w)
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestSpeed)
	})
	budget := h.limits.MaxBytes
	for _, e := range plan.entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		inner := e.rel
		if root != "" {
			inner = strings.TrimPrefix(strings.TrimPrefix(e.rel, root), "/")
		}
		zname := name
		if inner != "" {
			zname = name + "/" + inner
		}
		if e.isDir {
			if _, err := zw.CreateHeader(&zip.FileHeader{Name: zname + "/", Method: zip.Store, Modified: e.mod}); err != nil {
				return err
			}
			continue
		}
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: zname, Method: zip.Deflate, Modified: e.mod})
		if err != nil {
			return err
		}
		rc, err := h.store.Open(ctx, ns, e.rel)
		if err != nil {
			continue // removed since the walk; the rest of the archive is still valid
		}
		n, err := io.Copy(fw, io.LimitReader(ctxReader{ctx, rc}, budget+1))
		rc.Close()
		if err != nil {
			return err
		}
		budget -= n
		if budget < 0 {
			return errZipBudget // archive left unterminated: the client sees a failed download
		}
	}
	return zw.Close()
}

// ctxReader fails reads once ctx is done, so copying one large file stops as
// soon as the client goes away rather than when the next write fails.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
