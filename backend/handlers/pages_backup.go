package handlers

// A namespace backup contains a versioned manifest and one folder per handle.
// Unlinked files are left to the Unlinked tab. Missing pages are listed in the
// manifest instead of preventing a useful partial backup.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	maxPagesBackupBytes    int64 = 256 << 20
	maxPagesBackupTarBytes int64 = 272 << 20 // files plus bounded tar headers/padding
	maxPagesBackupFiles          = 10000
	maxPagesBackupEntries        = 1000
	maxPagesManifestBytes        = 2 << 20
)

type pageBackupEntry struct {
	Key         string `json:"key"`
	Path        string `json:"path"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}
type pageBackupResult struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}
type pagesManifest struct {
	Version   int                `json:"version"`
	Namespace string             `json:"namespace"`
	Pages     []pageBackupEntry  `json:"pages"`
	Skipped   []pageBackupResult `json:"skipped"`
}
type pageBackupFile struct {
	rel  string
	size int64
}

func (h *PagesHandler) requireBackup(w http.ResponseWriter, r *http.Request, method string) (string, func()) {
	if r.Method != method {
		pagesError(w, 405, "method not allowed")
		return "", nil
	}
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return "", nil
	}
	if !h.canWritePath(r, ns, "") {
		pagesError(w, 403, "Write access to the whole namespace is required.")
		return "", nil
	}
	release, err := h.backupSlots.acquire(slotKey(r))
	if err != nil {
		w.Header().Set("Retry-After", zipRetryAfter)
		pagesError(w, 429, "A pages backup is already running. Try again shortly.")
		return "", nil
	}
	return ns, release
}

// pageFiles refuses links and hidden names even if a host-side restore placed
// them here. The same scan validates per-page limits before an import publishes.
func pageFiles(dir string) ([]pageBackupFile, int64, int, error) {
	out := []pageBackupFile{}
	var total int64
	dirs := 0
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil || rel == "." {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !validBackupPath(rel) {
			return fmt.Errorf("unsafe page path")
		}
		if d.IsDir() {
			dirs++
			if dirs > maxPagesBackupFiles {
				return pageInputErr(413, "too many page folders")
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("page contains a link or special file")
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		total += fi.Size()
		if total > maxPagesBackupBytes || len(out) >= maxPagesBackupFiles {
			return pageInputErr(413, "This backup is larger than 256 MB or contains more than 10,000 files.")
		}
		out = append(out, pageBackupFile{rel, fi.Size()})
		return nil
	})
	return out, total, dirs, err
}

func validBackupPath(p string) bool {
	rel, ok := SafeRelPath(p)
	if !ok || rel != p || strings.Contains(p, "\\") {
		return false
	}
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

func backupKey(s string) bool {
	if len(s) != 6 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// snapshotPageFiles copies a complete page before it is added to the archive.
// Like copyPageFiles for transfers, it is a variable so tests can exercise a
// concurrent delete halfway through a copy without timing-dependent sleeps.
var snapshotPageFiles = func(ctx context.Context, src, dst string, files []pageBackupFile) error {
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		in, err := os.Open(pageStorePath(src, file.rel))
		if err != nil {
			return err
		}
		target := SafePath(dst, file.rel)
		if target == "" {
			in.Close()
			return fmt.Errorf("invalid page file")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			in.Close()
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			in.Close()
			return err
		}
		n, err := io.Copy(out, io.LimitReader(in, file.size+1))
		in.Close()
		closeErr := out.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if n != file.size {
			return fmt.Errorf("page changed while copying")
		}
	}
	return nil
}

// HandleExport serves GET /api/pages/export?ns=. The file is built first so a
// failed backup never downloads as a successful, truncated tar.gz.
func (h *PagesHandler) HandleExport(w http.ResponseWriter, r *http.Request) {
	ns, release := h.requireBackup(w, r, http.MethodGet)
	if ns == "" {
		return
	}
	defer release()
	// No page mutation waits for a backup build or a slow download. A page
	// deleted during its snapshot is skipped, without half a page in the tar.
	tmp, err := os.MkdirTemp("", "mdnest-pages-export-")
	if err != nil {
		pagesError(w, 500, "The server could not prepare the pages backup.")
		return
	}
	defer os.RemoveAll(tmp)
	manifest := pagesManifest{Version: 1, Namespace: ns, Pages: []pageBackupEntry{}, Skipped: []pageBackupResult{}}
	type source struct {
		dir   string
		files []pageBackupFile
	}
	sources := []source{}
	var total int64
	count := 0
	refs := h.handlesIn(r.Context(), ns, "")
	if len(refs) > maxPagesBackupEntries {
		pagesError(w, 413, "This namespace has more than 1,000 page handles.")
		return
	}
	for _, ref := range refs {
		if r.Context().Err() != nil {
			return
		}
		m, err := h.readMeta(ns, ref.id)
		dir := h.pageDir(ns, ref.id)
		index := pageStorePath(dir, "index.html")
		fi, statErr := os.Stat(index)
		if err != nil || index == "" || statErr != nil || !fi.Mode().IsRegular() {
			manifest.Skipped = append(manifest.Skipped, pageBackupResult{ref.path, "skipped", "files missing"})
			continue
		}
		files, size, _, err := pageFiles(dir)
		if err != nil {
			manifest.Skipped = append(manifest.Skipped, pageBackupResult{ref.path, "skipped", "page files could not be read safely"})
			continue
		}
		if total+size > maxPagesBackupBytes || count+len(files) > maxPagesBackupFiles {
			pagesError(w, 413, "This backup is larger than 256 MB or contains more than 10,000 files.")
			return
		}
		key := fmt.Sprintf("%06d", len(sources))
		snapshot := filepath.Join(tmp, key)
		if err := os.Mkdir(snapshot, 0700); err != nil {
			pagesError(w, 500, "The server could not prepare the pages backup.")
			return
		}
		if err := snapshotPageFiles(r.Context(), dir, snapshot, files); err != nil {
			os.RemoveAll(snapshot)
			manifest.Skipped = append(manifest.Skipped, pageBackupResult{ref.path, "skipped", "files missing or changed during download"})
			continue
		}
		total += size
		count += len(files)
		manifest.Pages = append(manifest.Pages, pageBackupEntry{key, ref.path, m.Title, m.Description})
		sources = append(sources, source{snapshot, files})
	}
	data, _ := json.Marshal(manifest)
	if len(data) > maxPagesManifestBytes {
		pagesError(w, 413, "The page paths, titles and descriptions make this backup's manifest larger than 2 MB.")
		return
	}
	f, err := os.CreateTemp(tmp, "backup-*.tgz")
	if err != nil {
		pagesError(w, 500, "The server could not build the pages backup.")
		return
	}
	defer os.Remove(f.Name())
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	write := func(name string, size int64, body io.Reader) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0644, Size: size, Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		_, err := io.CopyN(tw, body, size)
		return err
	}
	err = write("manifest.json", int64(len(data)), bytes.NewReader(data))
	for i, src := range sources {
		for _, file := range src.files {
			if err != nil || r.Context().Err() != nil {
				break
			}
			p := pageStorePath(src.dir, file.rel)
			in, openErr := os.Open(p)
			if openErr != nil {
				err = openErr
				break
			}
			err = write(path.Join("pages", manifest.Pages[i].Key, file.rel), file.size, in)
			in.Close()
		}
	}
	if closeErr := tw.Close(); err == nil {
		err = closeErr
	}
	if closeErr := gz.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		pagesError(w, 500, "The server could not build the pages backup. Try again.")
		return
	}
	fi, err := f.Stat()
	if err != nil {
		pagesError(w, 500, "The server could not build the pages backup.")
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", contentDisposition(ns+"-pages.tgz"))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Mdnest-Pages-Exported", fmt.Sprint(len(manifest.Pages)))
	w.Header().Set("X-Mdnest-Pages-Skipped", fmt.Sprint(len(manifest.Skipped)))
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// readBackup stages only regular files below a private temporary folder. It
// bounds compressed bytes, expanded tar bytes, payload bytes, files and folders.
// It validates every manifest path and every page before the first publish.
func (h *PagesHandler) readBackup(w http.ResponseWriter, r *http.Request, tmp string) (*pagesManifest, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPagesBackupTarBytes)
	gz, err := gzip.NewReader(r.Body)
	if err != nil {
		return nil, pageInputErr(400, "That file is not a pages backup (.tar.gz).")
	}
	defer gz.Close()
	expanded := &io.LimitedReader{R: gz, N: maxPagesBackupTarBytes + 1}
	tr := tar.NewReader(expanded)
	seen := map[string]bool{}
	dirs := map[string]bool{}
	var total int64
	files := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, pageInputErr(400, "The pages backup could not be read. It may be damaged.")
		}
		name := strings.TrimSuffix(strings.TrimPrefix(hdr.Name, "./"), "/")
		if name == "" || name == "." {
			if hdr.Typeflag == tar.TypeDir {
				continue
			}
			return nil, pageInputErr(400, "The backup contains a path that cannot be restored.")
		}
		if !validBackupPath(name) {
			return nil, pageInputErr(400, "The backup contains an invalid path: %q.", hdr.Name)
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeDir {
			return nil, pageInputErr(400, "A pages backup can contain only plain files and folders, not links or special files.")
		}
		if seen[name] {
			return nil, pageInputErr(400, "The backup lists %q more than once.", name)
		}
		seen[name] = true
		if name != "manifest.json" && name != "pages" && !strings.HasPrefix(name, "pages/") {
			return nil, pageInputErr(400, "The backup contains an unexpected file or folder: %q.", name)
		}
		dir := path.Dir(name)
		if hdr.Typeflag == tar.TypeDir {
			dir = name
		}
		for ; dir != "." && !dirs[dir]; dir = path.Dir(dir) {
			dirs[dir] = true
			if len(dirs) > maxPagesBackupFiles+maxPagesBackupEntries+1 {
				return nil, pageInputErr(413, "This backup contains too many folders.")
			}
		}
		target := SafePath(tmp, name)
		if target == "" {
			return nil, pageInputErr(400, "The backup contains a path that cannot be restored.")
		}
		if hdr.Typeflag == tar.TypeDir {
			if name == "manifest.json" {
				return nil, pageInputErr(400, "manifest.json must be a file, not a folder.")
			}
			if err := os.MkdirAll(target, 0755); err != nil {
				return nil, err
			}
			continue
		}
		files++
		if files > maxPagesBackupFiles+1 {
			return nil, pageInputErr(413, "This backup contains more than 10,000 files.")
		}
		limit := maxPagesBackupBytes - total
		if name == "manifest.json" {
			limit = maxPagesManifestBytes
		}
		if hdr.Size > limit {
			return nil, pageInputErr(413, "The backup is too large (256 MB of page files or 2 MB for manifest.json).")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return nil, err
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, err
		}
		n, err := io.Copy(out, io.LimitReader(tr, limit+1))
		closeErr := out.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if n > limit {
			return nil, pageInputErr(413, "This backup contains more than 256 MB of page files.")
		}
		if name != "manifest.json" {
			total += n
		}
	}
	// Read through the gzip trailer, checking its checksum and the expanded cap.
	if _, err := io.Copy(io.Discard, expanded); err != nil {
		return nil, pageInputErr(400, "The backup's gzip data is damaged.")
	}
	if expanded.N <= 0 {
		return nil, pageInputErr(413, "The unpacked backup is larger than 272 MB.")
	}
	data, err := os.ReadFile(filepath.Join(tmp, "manifest.json"))
	var m pagesManifest
	if err != nil || json.Unmarshal(data, &m) != nil || m.Version != 1 {
		return nil, pageInputErr(400, "This file does not contain a valid pages backup manifest (version 1).")
	}
	if len(m.Pages)+len(m.Skipped) > maxPagesBackupEntries {
		return nil, pageInputErr(413, "This backup lists more than 1,000 pages.")
	}
	for i := range m.Skipped {
		skipped := &m.Skipped[i]
		if !validBackupPath(skipped.Path) || !IsPageHandlePath(skipped.Path) {
			return nil, pageInputErr(400, "The backup lists a skipped page with an invalid path.")
		}
		skipped.Status = "skipped"
		skipped.Reason = truncateRunes(collapseSpace(plainField(skipped.Reason)), 500)
	}
	keys, paths := map[string]bool{}, map[string]bool{}
	for _, entry := range m.Pages {
		if !backupKey(entry.Key) || !validBackupPath(entry.Path) || !IsPageHandlePath(entry.Path) || keys[entry.Key] || paths[entry.Path] {
			return nil, pageInputErr(400, "The backup lists an invalid or repeated page handle.")
		}
		keys[entry.Key] = true
		paths[entry.Path] = true
		dir := SafePath(tmp, path.Join("pages", entry.Key))
		fs, size, folders, err := pageFiles(dir)
		if err != nil {
			return nil, pageInputErr(400, "Files for %s are missing or cannot be restored.", entry.Path)
		}
		if size > h.cfg.MaxBytes || len(fs) > h.cfg.MaxFiles || folders > h.cfg.MaxFiles {
			return nil, pageInputErr(413, "The page %s exceeds this server's size or file limit (PAGES_MAX_MB or PAGES_MAX_FILES).", entry.Path)
		}
		if fi, err := os.Stat(filepath.Join(dir, "index.html")); err != nil || !fi.Mode().IsRegular() {
			return nil, pageInputErr(400, "The page %s is missing index.html.", entry.Path)
		}
	}
	for name := range seen {
		if name == "manifest.json" || name == "pages" {
			continue
		}
		parts := strings.Split(name, "/")
		if len(parts) < 2 || !keys[parts[1]] {
			return nil, pageInputErr(400, "The backup contains page files that are not listed in manifest.json.")
		}
	}
	return &m, nil
}

// A bounded publish response, used to report each entry using the same publish
// rules as the normal endpoint without trusting archive metadata as a handle.
type pageBackupResponse struct {
	header http.Header
	bytes.Buffer
	code int
}

func (w *pageBackupResponse) Header() http.Header  { return w.header }
func (w *pageBackupResponse) WriteHeader(code int) { w.code = code }

func (h *PagesHandler) HandleImport(w http.ResponseWriter, r *http.Request) {
	ns, release := h.requireBackup(w, r, http.MethodPost)
	if ns == "" {
		return
	}
	defer release()
	tmp, err := os.MkdirTemp("", "mdnest-pages-import-")
	if err != nil {
		pagesError(w, 500, "The server could not prepare the pages backup.")
		return
	}
	defer os.RemoveAll(tmp)
	manifest, err := h.readBackup(w, r, tmp)
	if err != nil {
		var pe *errPageInput
		var mbe *http.MaxBytesError
		if errors.As(err, &pe) {
			pagesError(w, pe.status, pe.msg)
		} else if errors.As(err, &mbe) {
			pagesError(w, 413, "The backup upload is larger than 272 MB.")
		} else {
			pagesError(w, 400, "The server could not read the pages backup.")
		}
		return
	}
	results := []pageBackupResult{}
	restored := 0
	for _, entry := range manifest.Pages {
		if r.Context().Err() != nil {
			return
		}
		result := pageBackupResult{Path: entry.Path, Status: "skipped"}
		// One staged page at a time, so a large namespace is never held in memory.
		body, err := os.CreateTemp(tmp, ".publish-")
		if err != nil {
			pagesError(w, 500, "The server could not restore the pages.")
			return
		}
		err = writePageTar(body, filepath.Join(tmp, "pages", entry.Key))
		if err == nil {
			_, err = body.Seek(0, io.SeekStart)
		}
		if err != nil {
			body.Close()
			pagesError(w, 500, "The server could not restore the pages.")
			return
		}
		req := r.Clone(r.Context())
		req.URL = &url.URL{Path: "/api/pages", RawQuery: url.Values{"ns": {ns}, "path": {entry.Path}}.Encode()}
		req.Header = r.Header.Clone()
		req.Header.Set("Content-Type", "application/x-tar")
		req.Body = body
		response := &pageBackupResponse{header: make(http.Header), code: 200}
		h.publishPage(response, req, &entry)
		body.Close()
		os.Remove(body.Name())
		if response.code < 300 {
			result.Status = "restored"
			restored++
		} else {
			var msg struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(response.Bytes(), &msg)
			result.Reason = msg.Error
			if result.Reason == "" {
				result.Reason = "could not restore page"
			}
		}
		results = append(results, result)
	}
	// Missing pages recorded by the exporter remain visible in the restore report.
	results = append(results, manifest.Skipped...)
	pagesJSON(w, 200, map[string]any{"restored": restored, "skipped": len(results) - restored, "results": results})
}
