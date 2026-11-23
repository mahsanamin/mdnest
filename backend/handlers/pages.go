package handlers

// HTML pages (ENABLE_PAGES, off by default): view-only HTML reports and
// dashboards published into a namespace. Pages live in their own folder
// (PAGES_DIR), never in the notes tree, and are never rendered by the server:
// it only stores and serves files.
//
// Layout on disk:
//
//	PAGES_DIR/<ns>/<slug>/...                 the page's files (index.html first)
//	PAGES_DIR/<ns>/.pages-meta/<slug>.json    title, author, date, size, text
//
// A page is viewed through a short-lived pass (a JWT with purpose "page",
// signed with the server secret, naming one namespace and one slug). The pass
// sits in the URL path, /<pass>/<file>, so the relative links inside a page
// carry it without a cookie or a header. The namespace and slug come from the
// pass alone, so a page cannot even name another page.
//
// Two serving modes:
//   - static (default): files are served on mdnest's own origin under
//     /api/pages/view/, with a CSP sandbox that turns scripts off.
//   - script mode (PAGES_ORIGIN set): files are served only by a separate
//     listener on another origin, with `sandbox allow-scripts` and a CSP that
//     limits what the page may load. The main origin serves no page files.

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const (
	pagesMetaDir    = ".pages-meta"
	pagePassPurpose = "page"
	// maxPageText caps the extracted text kept for search, so one huge page
	// cannot make every list request slow.
	maxPageText = 256 << 10
)

// PagesEnabled decides ENABLE_PAGES: off unless set to true, and always off
// on the multi-replica app role, where the page files would sit on one
// replica's disk only.
func PagesEnabled(setting, role string) bool {
	if role == "app" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}

// PagesConfig is everything the pages feature reads from the environment.
type PagesConfig struct {
	Dir      string // PAGES_DIR, absolute
	MaxBytes int64  // PAGES_MAX_MB, in bytes: total size of a page's files
	MaxFiles int    // PAGES_MAX_FILES
	// Origin is PAGES_ORIGIN after validation. Empty means static mode.
	Origin string
	// Network is PAGES_NETWORK: "strict" (the page loads only its own
	// files) or "open" (outside scripts and fetches allowed). Script mode only.
	Network string
	// FrameAncestors is the origin allowed to frame a page (FRONTEND_ORIGIN).
	FrameAncestors string
	Secret         []byte        // the server's JWT secret, signs page passes
	PassTTL        time.Duration // how long a pass is good for
	SingleUser     string        // author name in single mode (MDNEST_USER)
}

// Origin returns scheme://host[:port] of a URL, or "" when it is not an
// absolute http(s) URL.
func originOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return u.Scheme + "://" + host + ":" + port
}

// ResolvePagesOrigin validates PAGES_ORIGIN against FRONTEND_ORIGIN. It
// returns the origin to serve scripted pages from, or "" for static mode,
// plus a message to log when the setting was refused. A pages origin equal to
// mdnest's own (same scheme, host and port) would let a page's script read
// the viewer's login token, so it is refused and scripts stay off.
func ResolvePagesOrigin(pagesOrigin, frontendOrigin string) (string, string) {
	pagesOrigin = strings.TrimSpace(pagesOrigin)
	if pagesOrigin == "" {
		return "", ""
	}
	po := originOf(pagesOrigin)
	if po == "" {
		return "", fmt.Sprintf("PAGES_ORIGIN=%q is not an http(s) URL; pages run in static mode (scripts off)", pagesOrigin)
	}
	if po == originOf(frontendOrigin) {
		return "", fmt.Sprintf("PAGES_ORIGIN=%q is the same origin as FRONTEND_ORIGIN; a page's script could read the viewer's login there, so pages run in static mode (scripts off). Use a second hostname or port", pagesOrigin)
	}
	u, _ := url.Parse(pagesOrigin)
	return u.Scheme + "://" + u.Host, ""
}

// PageMeta is what mdnest stores about a page besides its files.
type PageMeta struct {
	Slug        string `json:"slug"`
	Title       string `json:"title"`
	Author      string `json:"author,omitempty"`
	PublishedAt string `json:"publishedAt"`
	Bytes       int64  `json:"bytes"`
	Files       int    `json:"files"`
	Text        string `json:"text,omitempty"`
	// Version is a random id set on every publish. A pass carries it, so a
	// pass made before a republish or a delete never opens what replaced it.
	Version string `json:"-"`
}

// pageMetaFile is PageMeta as stored, with the version, which no API
// response shows.
type pageMetaFile struct {
	PageMeta
	Version string `json:"version"`
}

type PagesHandler struct {
	cfg   PagesConfig
	store storage.Storage               // only for NamespaceExists
	perms *middleware.PermissionChecker // nil in single mode
	mu    sync.Mutex                    // serialises publish/delete swaps
}

func NewPagesHandler(cfg PagesConfig, stg storage.Storage, perms *middleware.PermissionChecker) *PagesHandler {
	if cfg.PassTTL <= 0 {
		cfg.PassTTL = 30 * time.Minute
	}
	if cfg.Network != "open" {
		cfg.Network = "strict"
	}
	return &PagesHandler{cfg: cfg, store: stg, perms: perms}
}

// ScriptMode reports whether pages run with scripts on (PAGES_ORIGIN set).
func (h *PagesHandler) ScriptMode() bool { return h.cfg.Origin != "" }

var pageSlugRe = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// ValidPageSlug: lowercase letters, digits and hyphens, 1 to 64 characters.
// It can therefore never be a dotfile (".pages-meta") or a traversal.
func ValidPageSlug(s string) bool { return pageSlugRe.MatchString(s) }

func pagesJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func pagesError(w http.ResponseWriter, status int, msg string) {
	pagesJSON(w, status, map[string]string{"error": msg})
}

// nsDir returns PAGES_DIR/<ns>, validated with SafePath.
func (h *PagesHandler) nsDir(ns string) string {
	return SafePath(h.cfg.Dir, ns)
}

// pageDir returns PAGES_DIR/<ns>/<slug>, validated with SafePath.
func (h *PagesHandler) pageDir(ns, slug string) string {
	if !ValidNamespaceName(ns) || !ValidPageSlug(slug) {
		return ""
	}
	return SafePath(h.cfg.Dir, path.Join(ns, slug))
}

func (h *PagesHandler) metaPath(ns, slug string) string {
	if !ValidNamespaceName(ns) || !ValidPageSlug(slug) {
		return ""
	}
	return SafePath(h.cfg.Dir, path.Join(ns, pagesMetaDir, slug+".json"))
}

// The page permission is the namespace's own, checked on its root: a grant on
// a subfolder does not give access to pages.
func (h *PagesHandler) canRead(r *http.Request, ns string) bool {
	return h.perms == nil || h.perms.CheckRead(r, ns, "/")
}

func (h *PagesHandler) canWrite(r *http.Request, ns string) bool {
	return h.perms == nil || h.perms.CheckWrite(r, ns, "/")
}

// namespaceAndSlug resolves ?ns= (must exist in the notes storage) and, when
// needSlug, ?slug=. It writes the error itself and returns ok=false.
func (h *PagesHandler) namespaceAndSlug(w http.ResponseWriter, r *http.Request, needSlug bool) (string, string, bool) {
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return "", "", false
	}
	if !needSlug {
		return ns, "", true
	}
	slug := r.URL.Query().Get("slug")
	if !ValidPageSlug(slug) {
		pagesError(w, http.StatusBadRequest, "invalid page name: use 1 to 64 lowercase letters, digits or hyphens")
		return "", "", false
	}
	return ns, slug, true
}

// Handle serves /api/pages: GET lists, PUT publishes, DELETE removes.
func (h *PagesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleList(w, r)
	case http.MethodPut, http.MethodPost:
		h.handlePublish(w, r)
	case http.MethodDelete:
		h.handleDelete(w, r)
	default:
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *PagesHandler) readMeta(ns, slug string) (*PageMeta, error) {
	p := h.metaPath(ns, slug)
	if p == "" {
		return nil, os.ErrNotExist
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var f pageMetaFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	m := f.PageMeta
	m.Slug = slug
	m.Version = f.Version
	return &m, nil
}

func (h *PagesHandler) handleList(w http.ResponseWriter, r *http.Request) {
	ns, _, ok := h.namespaceAndSlug(w, r, false)
	if !ok {
		return
	}
	if !h.canRead(r, ns) {
		middleware.DenyJSON(w)
		return
	}
	terms := strings.Fields(strings.ToLower(r.URL.Query().Get("q")))
	pages := []PageMeta{}
	dir := h.nsDir(ns)
	entries, _ := os.ReadDir(filepath.Join(dir, pagesMetaDir))
	for _, e := range entries {
		slug, isJSON := strings.CutSuffix(e.Name(), ".json")
		if !isJSON || !e.Type().IsRegular() || !ValidPageSlug(slug) {
			continue
		}
		m, err := h.readMeta(ns, slug)
		if err != nil {
			continue
		}
		if len(terms) > 0 {
			hay := strings.ToLower(m.Title + " " + m.Slug + " " + m.Text)
			match := true
			for _, t := range terms {
				if !strings.Contains(hay, t) {
					match = false
					break
				}
			}
			if !match {
				continue
			}
		}
		m.Text = ""
		pages = append(pages, *m)
	}
	sort.Slice(pages, func(i, j int) bool {
		if pages[i].PublishedAt != pages[j].PublishedAt {
			return pages[i].PublishedAt > pages[j].PublishedAt
		}
		return pages[i].Slug < pages[j].Slug
	})
	if r.URL.Query().Get("format") == "tsv" {
		// One page per line for the CLI, which renders it in awk:
		// slug, title, author, publishedAt, files, bytes. Tabs and line
		// breaks inside a field become spaces.
		w.Header().Set("Content-Type", "text/tab-separated-values; charset=utf-8")
		clean := strings.NewReplacer("\t", " ", "\n", " ", "\r", " ")
		for _, p := range pages {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%d\n", p.Slug, clean.Replace(p.Title), clean.Replace(p.Author), p.PublishedAt, p.Files, p.Bytes)
		}
		return
	}
	pagesJSON(w, http.StatusOK, map[string]any{"pages": pages})
}

// HandleText serves GET /api/pages/text: the page's details and the plain
// text pulled out of index.html at publish time (never the raw HTML).
func (h *PagesHandler) HandleText(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, slug, ok := h.namespaceAndSlug(w, r, true)
	if !ok {
		return
	}
	if !h.canRead(r, ns) {
		middleware.DenyJSON(w)
		return
	}
	m, err := h.readMeta(ns, slug)
	if err != nil {
		pagesError(w, http.StatusNotFound, "page not found")
		return
	}
	pagesJSON(w, http.StatusOK, m)
}

// HandleArchive serves GET /api/pages/archive: the page's files as a tar, for
// `mdnest page pull`.
func (h *PagesHandler) HandleArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, slug, ok := h.namespaceAndSlug(w, r, true)
	if !ok {
		return
	}
	if !h.canRead(r, ns) {
		middleware.DenyJSON(w)
		return
	}
	dir := h.pageDir(ns, slug)
	if st, err := os.Stat(dir); dir == "" || err != nil || !st.IsDir() {
		pagesError(w, http.StatusNotFound, "page not found")
		return
	}
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.tar"`, slug))
	tw := tar.NewWriter(w)
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return nil // links and specials are never stored; skip anything odd
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()
		tw.WriteHeader(&tar.Header{
			Name:     filepath.ToSlash(rel),
			Mode:     0644,
			Size:     info.Size(),
			ModTime:  info.ModTime(),
			Typeflag: tar.TypeReg,
		})
		io.Copy(tw, f)
		return nil
	})
	tw.Close()
}

func (h *PagesHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	ns, slug, ok := h.namespaceAndSlug(w, r, true)
	if !ok {
		return
	}
	if !h.canWrite(r, ns) {
		middleware.DenyJSON(w)
		return
	}
	dir := h.pageDir(ns, slug)
	meta := h.metaPath(ns, slug)
	if dir == "" || meta == "" {
		pagesError(w, http.StatusBadRequest, "invalid page")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	_, dirErr := os.Stat(dir)
	_, metaErr := os.Stat(meta)
	if dirErr != nil && metaErr != nil {
		pagesError(w, http.StatusNotFound, "page not found")
		return
	}
	os.Remove(meta)
	if err := os.RemoveAll(dir); err != nil {
		pagesError(w, http.StatusInternalServerError, "failed to delete page")
		return
	}
	pagesJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// errPageInput is a client mistake in a published page; its message is shown.
type errPageInput struct {
	status int
	msg    string
}

func (e *errPageInput) Error() string { return e.msg }

func pageInputErr(status int, format string, a ...any) error {
	return &errPageInput{status: status, msg: fmt.Sprintf(format, a...)}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *PagesHandler) handlePublish(w http.ResponseWriter, r *http.Request) {
	ns, slug, ok := h.namespaceAndSlug(w, r, true)
	if !ok {
		return
	}
	if !h.canWrite(r, ns) {
		middleware.DenyJSON(w)
		return
	}
	nsDir := h.nsDir(ns)
	if nsDir == "" {
		pagesError(w, http.StatusBadRequest, "invalid namespace")
		return
	}
	if err := os.MkdirAll(filepath.Join(nsDir, pagesMetaDir), 0755); err != nil {
		log.Printf("pages: cannot create %s: %v", nsDir, err)
		pagesError(w, http.StatusInternalServerError, "failed to store page")
		return
	}

	// The body may be a little larger than the files it carries (tar headers
	// and padding); the real limit is counted on the files themselves.
	overhead := int64(h.cfg.MaxFiles)*1024 + (1 << 20)
	r.Body = http.MaxBytesReader(w, r.Body, h.cfg.MaxBytes+overhead)

	tmp := filepath.Join(nsDir, ".tmp-"+randHex(8))
	if err := os.Mkdir(tmp, 0755); err != nil {
		pagesError(w, http.StatusInternalServerError, "failed to store page")
		return
	}
	defer os.RemoveAll(tmp) // gone after a successful rename; cleans up on error

	total, files, err := h.extractPage(r, tmp)
	if err != nil {
		var pe *errPageInput
		var mbe *http.MaxBytesError
		switch {
		case errors.As(err, &pe):
			pagesError(w, pe.status, pe.msg)
		case errors.As(err, &mbe):
			pagesError(w, http.StatusRequestEntityTooLarge, h.tooBigMsg())
		default:
			log.Printf("pages: publish %s/%s: %v", ns, slug, err)
			pagesError(w, http.StatusBadRequest, "could not read the uploaded page")
		}
		return
	}
	indexBytes, err := os.ReadFile(filepath.Join(tmp, "index.html"))
	if err != nil {
		pagesError(w, http.StatusBadRequest, "a page needs an index.html at its top level")
		return
	}
	title, text := ExtractPageText(indexBytes)
	if title == "" {
		title = slug
	}
	meta := PageMeta{
		Slug:        slug,
		Title:       title,
		Author:      h.author(r),
		PublishedAt: time.Now().UTC().Format(time.RFC3339),
		Bytes:       total,
		Files:       files,
		Text:        text,
		Version:     randHex(12),
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	dest := h.pageDir(ns, slug)
	metaFile := h.metaPath(ns, slug)
	if dest == "" || metaFile == "" {
		pagesError(w, http.StatusBadRequest, "invalid page")
		return
	}
	// Swap the new folder in: move the old one aside, rename, then drop it.
	var old string
	if _, err := os.Stat(dest); err == nil {
		old = filepath.Join(nsDir, ".old-"+randHex(8))
		if err := os.Rename(dest, old); err != nil {
			pagesError(w, http.StatusInternalServerError, "failed to replace page")
			return
		}
	}
	if err := os.Rename(tmp, dest); err != nil {
		if old != "" {
			os.Rename(old, dest)
		}
		pagesError(w, http.StatusInternalServerError, "failed to store page")
		return
	}
	if old != "" {
		os.RemoveAll(old)
	}
	mb, _ := json.Marshal(pageMetaFile{PageMeta: meta, Version: meta.Version})
	tmpMeta := metaFile + ".tmp-" + randHex(4)
	if err := os.WriteFile(tmpMeta, mb, 0644); err != nil || os.Rename(tmpMeta, metaFile) != nil {
		os.Remove(tmpMeta)
		pagesError(w, http.StatusInternalServerError, "failed to store page details")
		return
	}
	meta.Text = ""
	pagesJSON(w, http.StatusOK, meta)
}

func (h *PagesHandler) tooBigMsg() string {
	return fmt.Sprintf("page is larger than the limit of %d MB (PAGES_MAX_MB)", h.cfg.MaxBytes>>20)
}

func (h *PagesHandler) author(r *http.Request) string {
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		return uc.Username
	}
	return h.cfg.SingleUser
}

// extractPage writes the request body into dir. The body is either one HTML
// file (Content-Type text/html, stored as index.html) or a tar of the page's
// folder, optionally gzipped (Content-Type application/x-tar or
// application/gzip). It returns the total bytes and file count written.
func (h *PagesHandler) extractPage(r *http.Request, dir string) (int64, int, error) {
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	switch ct {
	case "text/html":
		n, err := h.writeLimited(filepath.Join(dir, "index.html"), r.Body, 0)
		return n, 1, err
	case "application/x-tar", "application/tar", "application/gzip", "application/x-gzip":
		return h.extractTar(r.Body, dir)
	}
	return 0, 0, pageInputErr(http.StatusUnsupportedMediaType, "send a page as text/html (one file) or application/x-tar (a folder, may be gzipped)")
}

// writeLimited copies src to a new file at p, stopping as soon as the page's
// running total (already + this file) passes the limit, so a gzip bomb is cut
// off after MaxBytes of output, not after it has filled the disk.
func (h *PagesHandler) writeLimited(p string, src io.Reader, already int64) (int64, error) {
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	limit := h.cfg.MaxBytes - already
	n, err := io.Copy(f, io.LimitReader(src, limit+1))
	if err != nil {
		return n, err
	}
	if n > limit {
		return n, pageInputErr(http.StatusRequestEntityTooLarge, "%s", h.tooBigMsg())
	}
	return n, nil
}

func (h *PagesHandler) extractTar(body io.Reader, dir string) (int64, int, error) {
	br := bufio.NewReader(body)
	var src io.Reader = br
	if magic, _ := br.Peek(2); bytes.Equal(magic, []byte{0x1f, 0x8b}) {
		gz, err := gzip.NewReader(br)
		if err != nil {
			return 0, 0, pageInputErr(http.StatusBadRequest, "the gzip data is not valid")
		}
		defer gz.Close()
		src = gz
	}
	tr := tar.NewReader(src)
	var total int64
	files := 0
	seen := map[string]bool{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return total, files, err
			}
			return total, files, pageInputErr(http.StatusBadRequest, "the tar data is not valid")
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		name = strings.TrimSuffix(name, "/")
		if name == "" || name == "." {
			continue // the archive's own root entry
		}
		rel, ok := SafeRelPath(name)
		if !ok {
			return total, files, pageInputErr(http.StatusBadRequest, "path %q is not allowed in a page", hdr.Name)
		}
		// Hidden files (.DS_Store, ._ resource forks, .git) are not part of
		// a page; skipping them also keeps every stored name free of dots.
		hidden := false
		for _, seg := range strings.Split(rel, "/") {
			if strings.HasPrefix(seg, ".") {
				hidden = true
			}
		}
		if hidden {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			target := SafePath(dir, rel)
			if target == "" {
				return total, files, pageInputErr(http.StatusBadRequest, "path %q is not allowed in a page", hdr.Name)
			}
			if err := os.MkdirAll(target, 0755); err != nil {
				return total, files, err
			}
			continue
		case tar.TypeReg:
		default:
			// Symlinks, hard links, devices and FIFOs could point outside the
			// page or block a reader; a page is plain files only.
			return total, files, pageInputErr(http.StatusBadRequest, "%q is not a regular file; a page may hold only plain files and folders", hdr.Name)
		}
		if seen[rel] {
			return total, files, pageInputErr(http.StatusBadRequest, "%q appears twice in the archive", rel)
		}
		seen[rel] = true
		files++
		if files > h.cfg.MaxFiles {
			return total, files, pageInputErr(http.StatusRequestEntityTooLarge, "page has more than %d files (PAGES_MAX_FILES)", h.cfg.MaxFiles)
		}
		if total+hdr.Size > h.cfg.MaxBytes {
			return total, files, pageInputErr(http.StatusRequestEntityTooLarge, "%s", h.tooBigMsg())
		}
		target := SafePath(dir, rel)
		if target == "" {
			return total, files, pageInputErr(http.StatusBadRequest, "path %q is not allowed in a page", hdr.Name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return total, files, err
		}
		n, err := h.writeLimited(target, tr, total)
		total += n
		if err != nil {
			if os.IsExist(err) {
				return total, files, pageInputErr(http.StatusBadRequest, "%q appears twice in the archive", rel)
			}
			return total, files, err
		}
	}
	return total, files, nil
}

// ExtractPageText returns the <title> and the visible text of an HTML
// document, with script, style and template content left out and whitespace
// collapsed. It runs once, at publish time.
func ExtractPageText(doc []byte) (string, string) {
	z := html.NewTokenizer(bytes.NewReader(doc))
	var title, text strings.Builder
	skip := 0 // depth inside script/style/noscript/template
	inTitle := false
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return collapseSpace(title.String()), truncateText(collapseSpace(text.String()))
		case html.StartTagToken, html.EndTagToken:
			name, _ := z.TagName()
			a := atom.Lookup(name)
			isStart := tt == html.StartTagToken
			switch a {
			case atom.Script, atom.Style, atom.Noscript, atom.Template:
				if isStart {
					skip++
				} else if skip > 0 {
					skip--
				}
			case atom.Title:
				inTitle = isStart
			}
			if isBlockAtom(a) {
				text.WriteByte(' ')
			}
		case html.TextToken:
			if skip > 0 {
				continue
			}
			t := string(z.Text())
			if inTitle {
				title.WriteString(t)
				continue
			}
			if text.Len() < maxPageText*2 {
				text.WriteString(t)
			}
		}
	}
}

func isBlockAtom(a atom.Atom) bool {
	switch a {
	case atom.P, atom.Div, atom.Br, atom.Li, atom.Tr, atom.Td, atom.Th,
		atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6,
		atom.Section, atom.Article, atom.Header, atom.Footer, atom.Table, atom.Pre:
		return true
	}
	return false
}

func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }

func truncateText(s string) string {
	if len(s) <= maxPageText {
		return s
	}
	s = s[:maxPageText]
	// Do not cut a UTF-8 sequence in half.
	for len(s) > 0 && s[len(s)-1]&0xC0 == 0x80 {
		s = s[:len(s)-1]
	}
	if len(s) > 0 && s[len(s)-1] >= 0xC0 {
		s = s[:len(s)-1]
	}
	return s
}

// ---- passes ----

// pageClaims are a pass's claims. Purpose "page" means ParseSessionToken
// refuses it, so a pass can never act as a login.
type pageClaims struct {
	Purpose   string `json:"purpose"`
	Namespace string `json:"ns"`
	Slug      string `json:"slug"`
	Version   string `json:"v"`
	jwt.RegisteredClaims
}

func (h *PagesHandler) mintPass(ns, slug, version string) (string, time.Time, error) {
	exp := time.Now().Add(h.cfg.PassTTL)
	c := pageClaims{
		Purpose:   pagePassPurpose,
		Namespace: ns,
		Slug:      slug,
		Version:   version,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(h.cfg.Secret)
	return s, exp, err
}

// parsePass returns the namespace and slug a pass is good for, or ok=false
// when it is malformed, not a page pass, tampered with, expired, or made for
// a version of the page that has since been replaced or deleted.
func (h *PagesHandler) parsePass(s string) (string, string, bool) {
	var c pageClaims
	tok, err := jwt.ParseWithClaims(s, &c, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, jwt.ErrSignatureInvalid
		}
		return h.cfg.Secret, nil
	}, jwt.WithExpirationRequired())
	if err != nil || !tok.Valid || c.Purpose != pagePassPurpose {
		return "", "", false
	}
	if !ValidNamespaceName(c.Namespace) || !ValidPageSlug(c.Slug) || c.Version == "" {
		return "", "", false
	}
	m, err := h.readMeta(c.Namespace, c.Slug)
	if err != nil || m.Version != c.Version {
		return "", "", false
	}
	return c.Namespace, c.Slug, true
}

// HandlePass serves POST /api/pages/pass: a frame URL for one page, after the
// same read check as the list. The frontend asks for a fresh one each time a
// page is opened.
func (h *PagesHandler) HandlePass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, slug, ok := h.namespaceAndSlug(w, r, true)
	if !ok {
		return
	}
	if !h.canRead(r, ns) {
		middleware.DenyJSON(w)
		return
	}
	m, err := h.readMeta(ns, slug)
	if err != nil {
		pagesError(w, http.StatusNotFound, "page not found")
		return
	}
	pass, exp, err := h.mintPass(ns, slug, m.Version)
	if err != nil {
		pagesError(w, http.StatusInternalServerError, "failed to create page pass")
		return
	}
	base := "/api/pages/view"
	if h.ScriptMode() {
		base = strings.TrimRight(h.cfg.Origin, "/")
	}
	pagesJSON(w, http.StatusOK, map[string]any{
		"url":       base + "/" + pass + "/",
		"scripts":   h.ScriptMode(),
		"expiresAt": exp.UTC().Format(time.RFC3339),
	})
}

// ---- serving ----

// staticCSP: no scripts at all (sandbox without allow-scripts), and the page
// may show only its own images, styles and fonts.
func (h *PagesHandler) staticCSP() string {
	return "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; " +
		"base-uri 'none'; form-action 'none'" + h.frameAncestors() + "; sandbox"
}

// scriptCSP: scripts run, but in an opaque origin (no allow-same-origin), and
// with PAGES_NETWORK=strict only from the page's own origin.
func (h *PagesHandler) scriptCSP() string {
	o := h.cfg.Origin
	var src string
	if h.cfg.Network == "open" {
		src = "default-src " + o + " https: data: blob: 'unsafe-inline' 'unsafe-eval'"
	} else {
		src = "default-src " + o + "; script-src " + o + " 'unsafe-inline' 'unsafe-eval'; style-src " + o + " 'unsafe-inline'; " +
			"img-src " + o + " data: blob:; font-src " + o + " data:; media-src " + o + " data: blob:; connect-src " + o
	}
	return src + "; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'" + h.frameAncestors() + "; sandbox allow-scripts"
}

func (h *PagesHandler) frameAncestors() string {
	if fa := originOf(h.cfg.FrameAncestors); fa != "" {
		u, _ := url.Parse(strings.TrimSpace(h.cfg.FrameAncestors))
		return "; frame-ancestors " + u.Scheme + "://" + u.Host
	}
	return "; frame-ancestors 'none'"
}

// HandleStaticView serves GET /api/pages/view/<pass>/<file> on mdnest's own
// origin (static mode only: the route is not registered in script mode).
func (h *PagesHandler) HandleStaticView(w http.ResponseWriter, r *http.Request) {
	h.serveFromPass(w, r, strings.TrimPrefix(r.URL.Path, "/api/pages/view/"), "/api/pages/view/", h.staticCSP())
}

// SiteHandler is the whole pages origin (script mode): /<pass>/<file>, read
// only, and nothing else. No API route is reachable through it.
func (h *PagesHandler) SiteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.serveFromPass(w, r, strings.TrimPrefix(r.URL.Path, "/"), "/", h.scriptCSP())
	})
}

func (h *PagesHandler) serveFromPass(w http.ResponseWriter, r *http.Request, rest, prefix, csp string) {
	// Every response, errors included: no type sniffing, the pass never
	// leaves in a Referer, nothing is kept by a shared browser or a proxy.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", csp)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	pass, file, hasSlash := strings.Cut(rest, "/")
	ns, slug, ok := h.parsePass(pass)
	if !ok {
		http.Error(w, "this page link is invalid or has expired; open the page again from mdnest", http.StatusForbidden)
		return
	}
	if !hasSlash {
		// Relative links resolve against the folder, so it needs its slash.
		http.Redirect(w, r, prefix+pass+"/", http.StatusFound)
		return
	}
	dir := h.pageDir(ns, slug)
	if dir == "" {
		http.NotFound(w, r)
		return
	}
	rel := "index.html"
	if file != "" {
		var ok bool
		rel, ok = SafeRelPath(file)
		if !ok {
			http.Error(w, "invalid path", http.StatusBadRequest)
			return
		}
		for _, seg := range strings.Split(rel, "/") {
			if strings.HasPrefix(seg, ".") {
				http.NotFound(w, r)
				return
			}
		}
	}
	target := SafePath(dir, rel)
	if target == "" {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	st, err := os.Lstat(target)
	if err == nil && st.IsDir() {
		target = filepath.Join(target, "index.html")
		st, err = os.Lstat(target)
	}
	if err != nil || !st.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(target)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	ct := mime.TypeByExtension(path.Ext(target))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	http.ServeContent(w, r, "", st.ModTime(), f)
}
