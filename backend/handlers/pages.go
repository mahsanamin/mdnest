package handlers

// HTML pages (ENABLE_PAGES, off by default): view-only HTML reports and
// dashboards published into a namespace. Pages live in their own folder
// (PAGES_DIR), never in the notes tree, and are never rendered by the server:
// it only stores and serves files.
//
// Layout on disk:
//
//	PAGES_DIR/<ns>/<id>/...                   the page's files (index.html first)
//	PAGES_DIR/<ns>/.pages-meta/<id>.json      title, author, date, size, text
//
// A page shows in the notes tree as a handle file, <name>.page.md, holding
// only front matter (`page: <id>`, title, author, published). The handle is
// an ordinary note: it moves, copies and is read-checked like one, and the
// page goes wherever it goes. Storage is keyed by the random id, never by the
// handle's path (pages_handles.go).
//
// A page is viewed through a short-lived pass (a JWT with purpose "page",
// signed with the server secret, naming one namespace and one page id). The pass
// sits in the URL path, /<pass>/<file>, so the relative links inside a page
// carry it without a cookie or a header. The namespace and id come from the
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
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

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

// CheckPagesDir refuses a PAGES_DIR that overlaps NOTES_DIR (the same
// folder, one inside the other). Inside the notes, every page file would
// become a readable note (its HTML shown and searched as a note, synced to
// git), and the notes would hold folders mdnest never created. Symlinks are
// resolved first, on the part of each path that exists, so a link cannot
// hide the overlap. Called at startup, before PAGES_DIR is created.
func CheckPagesDir(pagesDir, notesDir string) error {
	p, err := realPath(pagesDir)
	if err != nil {
		return err
	}
	n, err := realPath(notesDir)
	if err != nil {
		return err
	}
	if p == n || within(p, n) || within(n, p) {
		return fmt.Errorf("PAGES_DIR %s overlaps NOTES_DIR %s; pages must be stored outside the notes (and the notes outside the pages)", pagesDir, notesDir)
	}
	return nil
}

// within reports whether child is strictly inside parent.
func within(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// realPath is the absolute, symlink-free form of p. The part of p that does
// not exist yet is kept as written below its deepest existing folder.
func realPath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rest := ""
	for cur := abs; ; cur = filepath.Dir(cur) {
		if resolved, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(resolved, rest), nil
		}
		if filepath.Dir(cur) == cur {
			return abs, nil
		}
		rest = filepath.Join(filepath.Base(cur), rest)
	}
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
	ID          string `json:"id,omitempty"`
	Path        string `json:"path,omitempty"` // the handle, in list and publish responses
	Title       string `json:"title"`
	Author      string `json:"author,omitempty"`
	PublishedAt string `json:"publishedAt"`
	Bytes       int64  `json:"bytes"`
	Files       int    `json:"files"`
	Description string `json:"description,omitempty"` // <meta name="description">, when the page has one
	Text        string `json:"text,omitempty"`
	// Version is a random id set on every publish. A pass carries it, so a
	// pass made before a republish or a delete never opens what replaced it.
	Version string `json:"-"`
	// Missing marks a handle whose page is not stored in this namespace
	// (moved here by hand or by git-sync, or hand-edited).
	Missing bool `json:"missing,omitempty"`
}

// writePageTar streams a page's regular files as a tar. Links and special
// files are never stored, and are skipped here too.
func writePageTar(w io.Writer, dir string) error {
	tw := tar.NewWriter(w)
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return nil
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
		if err := tw.WriteHeader(&tar.Header{Name: filepath.ToSlash(rel), Mode: 0644, Size: info.Size(), ModTime: info.ModTime(), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	return tw.Close()
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

var pageIDRe = regexp.MustCompile(`^[a-z2-7]{26,64}$`)

// ValidPageID: a page id as newPageID makes it (lowercase base32, 26 to 64
// characters). It can never be a dotfile (".pages-meta") or a traversal.
func ValidPageID(s string) bool { return pageIDRe.MatchString(s) }

// newPageID returns 160 random bits as 32 lowercase base32 characters. The id
// is the page's storage key and the only thing a handle file holds, so it
// must not be guessable.
func newPageID() string {
	b := make([]byte, 20)
	rand.Read(b)
	return strings.ToLower(base32.StdEncoding.EncodeToString(b))
}

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

// pageDir returns PAGES_DIR/<ns>/<id>, validated with SafePath.
func (h *PagesHandler) pageDir(ns, id string) string {
	if !ValidNamespaceName(ns) || !ValidPageID(id) {
		return ""
	}
	return SafePath(h.cfg.Dir, path.Join(ns, id))
}

func (h *PagesHandler) metaPath(ns, id string) string {
	if !ValidNamespaceName(ns) || !ValidPageID(id) {
		return ""
	}
	return SafePath(h.cfg.Dir, path.Join(ns, pagesMetaDir, id+".json"))
}

func (h *PagesHandler) readMeta(ns, id string) (*PageMeta, error) {
	p := h.metaPath(ns, id)
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
	m.ID = id
	m.Version = f.Version
	return &m, nil
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
	// Folders are capped too, at the same number as files. Every folder the
	// archive would create is counted, whether it comes from a folder entry
	// or from a file's path (a/b/c/x.css makes three), and the count is
	// checked before anything is created. Without this, a small gzipped tar
	// of empty folder entries, or one deeply nested file, could create
	// millions of folders and use up the disk's inodes.
	dirs := map[string]bool{}
	addDirs := func(rel string) error {
		for d := rel; d != "." && d != "" && !dirs[d]; d = path.Dir(d) {
			dirs[d] = true
			if len(dirs) > h.cfg.MaxFiles {
				return pageInputErr(http.StatusRequestEntityTooLarge, "page has more than %d folders (PAGES_MAX_FILES)", h.cfg.MaxFiles)
			}
		}
		return nil
	}
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
			if err := addDirs(rel); err != nil {
				return total, files, err
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
		if err := addDirs(path.Dir(rel)); err != nil {
			return total, files, err
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

// maxPageDescription caps the stored <meta name="description">.
const maxPageDescription = 500

// ExtractPageText returns the <title>, the first <meta name="description">
// and the visible text of an HTML
// document, with script, style and template content left out and whitespace
// collapsed. It runs once, at publish time.
func ExtractPageText(doc []byte) (title, description, text string) {
	z := html.NewTokenizer(bytes.NewReader(doc))
	var tb, xb strings.Builder
	skip := 0 // depth inside script/style/noscript/template
	inTitle := false
	haveDesc := false
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return collapseSpace(plainField(tb.String())), description, truncateText(collapseSpace(plainField(xb.String())))
		case html.StartTagToken, html.EndTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			a := atom.Lookup(name)
			isStart := tt != html.EndTagToken
			if a == atom.Meta && isStart && hasAttr && !haveDesc {
				var metaName, content string
				for {
					k, v, more := z.TagAttr()
					switch strings.ToLower(string(k)) {
					case "name":
						metaName = strings.ToLower(strings.TrimSpace(string(v)))
					case "content":
						content = string(v)
					}
					if !more {
						break
					}
				}
				if metaName == "description" {
					haveDesc = true
					description = truncateRunes(collapseSpace(plainField(content)), maxPageDescription)
				}
				continue
			}
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
				xb.WriteByte(' ')
			}
		case html.TextToken:
			if skip > 0 {
				continue
			}
			t := string(z.Text())
			if inTitle {
				tb.WriteString(t)
				continue
			}
			if xb.Len() < maxPageText*2 {
				xb.WriteString(t)
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

// truncateRunes cuts s to at most n characters.
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }

// plainField makes a value safe to print in a terminal or a TSV line: every
// control character (tabs, line breaks, ESC and the rest of C0/C1, DEL) and
// the Unicode line and paragraph separators become a space. A page title is
// written by whoever publishes the page, and the CLI prints it.
func plainField(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return ' '
		}
		return r
	}, s)
}

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
	ID        string `json:"id"`
	Version   string `json:"v"`
	jwt.RegisteredClaims
}

func (h *PagesHandler) mintPass(ns, id, version string) (string, time.Time, error) {
	exp := time.Now().Add(h.cfg.PassTTL)
	c := pageClaims{
		Purpose:   pagePassPurpose,
		Namespace: ns,
		ID:        id,
		Version:   version,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(pagePassKey(h.cfg.Secret))
	return s, exp, err
}

// pagePassKey is the key page passes are signed with: HMAC-SHA256 of the
// server's JWT secret over a fixed label. Passes and login tokens therefore
// never share a key. A pass appears in page URLs, which can end up in logs
// and browser history, so even if a bug let a token's purpose claim be
// ignored, a pass still could not be checked against the login key, and a
// login token could not pass as a page pass.
func pagePassKey(secret []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("mdnest-pages"))
	return m.Sum(nil)
}

// parsePass returns the namespace and page id a pass is good for, or ok=false
// when it is malformed, not a page pass, tampered with, expired, or made for
// a version of the page that has since been replaced or deleted.
func (h *PagesHandler) parsePass(s string) (string, string, bool) {
	var c pageClaims
	tok, err := jwt.ParseWithClaims(s, &c, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, jwt.ErrSignatureInvalid
		}
		return pagePassKey(h.cfg.Secret), nil
	}, jwt.WithExpirationRequired())
	if err != nil || !tok.Valid || c.Purpose != pagePassPurpose {
		return "", "", false
	}
	if !ValidNamespaceName(c.Namespace) || !ValidPageID(c.ID) || c.Version == "" {
		return "", "", false
	}
	m, err := h.readMeta(c.Namespace, c.ID)
	if err != nil || m.Version != c.Version {
		return "", "", false
	}
	return c.Namespace, c.ID, true
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
	// The main server's CORS middleware allows FRONTEND_ORIGIN on every
	// response. Page files need no cross-origin reads at all on this origin.
	for _, k := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Max-Age"} {
		w.Header().Del(k)
	}
	// A page is shown only inside the app's frame. Opened as a whole tab,
	// someone else's HTML would sit on mdnest's own address (no scripts or
	// forms, but enough to imitate a mdnest screen). Browsers mark a tab
	// load with Sec-Fetch-Dest: document, so that is refused. The header is
	// only sent over https and to localhost, so on a plain-http address it
	// is missing and the page is still served: blocking on a missing header
	// would break every page there.
	if r.Header.Get("Sec-Fetch-Dest") == "document" {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, no-store")
		http.Error(w, "This page opens inside mdnest, not on its own.", http.StatusForbidden)
		return
	}
	h.serveFromPass(w, r, strings.TrimPrefix(r.URL.Path, "/api/pages/view/"), "/api/pages/view/", h.staticCSP())
}

// SiteHandler is the whole pages origin (script mode): /<pass>/<file>, read
// only, and nothing else. No API route is reachable through it.
func (h *PagesHandler) SiteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The page runs in an opaque origin (sandbox without
		// allow-same-origin), so even its own fetch('data.json') is a
		// cross-origin request and the browser blocks it without this. It
		// exposes nothing: no cookie or login is involved, and the pass in
		// the URL is the only key, held by whoever already has the page.
		w.Header().Set("Access-Control-Allow-Origin", "*")
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
	ns, id, ok := h.parsePass(pass)
	if !ok {
		http.Error(w, "this page link is invalid or has expired; open the page again from mdnest", http.StatusForbidden)
		return
	}
	if !hasSlash {
		// Relative links resolve against the folder, so it needs its slash.
		http.Redirect(w, r, prefix+pass+"/", http.StatusFound)
		return
	}
	dir := h.pageDir(ns, id)
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
