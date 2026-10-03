package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// Shared rules for the two endpoints that take a whole subtree out of its
// place: GET /api/download (a folder as a zip) and POST /api/transfer (move or
// copy to another namespace). Both walk the same way, are capped by the same
// limits and refuse the same entries, so one copy of each rule lives here.

// TreeLimits caps how much one download or transfer may touch. Configured by
// DOWNLOAD_MAX_FILES / DOWNLOAD_MAX_MB; the defaults are the PRD's.
type TreeLimits struct {
	MaxFiles int
	MaxBytes int64
}

// DefaultTreeLimits is used when nothing is configured.
var DefaultTreeLimits = TreeLimits{MaxFiles: 500, MaxBytes: 100 << 20}

// TreeLimitsFromEnv reads DOWNLOAD_MAX_FILES and DOWNLOAD_MAX_MB. A missing,
// malformed or non-positive value keeps the default: a limit of zero would
// refuse every folder, which is never what an operator meant.
func TreeLimitsFromEnv() TreeLimits {
	l := DefaultTreeLimits
	if n := envInt("DOWNLOAD_MAX_FILES", 0); n > 0 {
		l.MaxFiles = n
	}
	if mb := envInt("DOWNLOAD_MAX_MB", 0); mb > 0 {
		l.MaxBytes = int64(mb) << 20
	}
	return l
}

// treeEntry is one file or directory found under a transfer/download root.
type treeEntry struct {
	rel   string // namespace-relative path
	isDir bool
	size  int64
	mod   time.Time
}

// treePlan is the result of walking a root: every entry (root first), totals,
// and the entries the walk refused to carry.
type treePlan struct {
	entries  []treeEntry
	files    int
	bytes    int64
	symlinks []string // namespace-relative paths of symlinks found
	reserved []string // .git / .mdnest directories found below the root
}

// reservedDirName reports whether a directory name is app- or VCS-owned and
// must never be exported or carried along: .git (history, possibly remote
// credentials in config) and .mdnest (comment sidecars, board layout).
func reservedDirName(name string) bool {
	return name == ".git" || name == ".mdnest"
}

// hasReservedSegment reports whether any segment of a cleaned relative path is
// a reserved directory. A transfer may not start from or land inside one.
func hasReservedSegment(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if reservedDirName(seg) {
			return true
		}
	}
	return false
}

// planTree walks root and collects what a download or transfer would carry.
// Reserved directories and symlinks are skipped and recorded, never followed.
// The context is checked on every entry, so a cancelled request stops the walk.
func planTree(ctx context.Context, stg storage.Storage, ns, root string) (*treePlan, error) {
	p := &treePlan{}
	err := stg.Walk(ctx, ns, root, func(rel string, info storage.FileInfo) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if info.IsSymlink {
			p.symlinks = append(p.symlinks, rel)
			return nil
		}
		if info.IsDir {
			if rel != root && reservedDirName(info.Name) {
				p.reserved = append(p.reserved, rel)
				return storage.SkipDir
			}
			p.entries = append(p.entries, treeEntry{rel: rel, isDir: true, mod: info.ModTime})
			return nil
		}
		p.entries = append(p.entries, treeEntry{rel: rel, size: info.Size, mod: info.ModTime})
		p.files++
		p.bytes += info.Size
		return nil
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

// tooLarge reports whether the plan exceeds the limits.
func (p *treePlan) tooLarge(l TreeLimits) bool {
	return p.files > l.MaxFiles || p.bytes > l.MaxBytes
}

// writeTooLarge writes the 413 body shared by download and transfer.
func writeTooLarge(w http.ResponseWriter, p *treePlan, l TreeLimits) {
	writeStatusJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
		"error":    "too_large",
		"files":    p.files,
		"bytes":    p.bytes,
		"maxFiles": l.MaxFiles,
		"maxBytes": l.MaxBytes,
	})
}

func writeStatusJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// linkedPath reports whether relPath or one of its existing parent folders is
// a symlink, on backends that can tell (see storage.SymlinkChecker). An error
// counts as linked: the caller refuses rather than guesses.
func linkedPath(ctx context.Context, stg storage.Storage, ns, relPath string) bool {
	sc, ok := stg.(storage.SymlinkChecker)
	if !ok {
		return false
	}
	linked, err := sc.HasSymlink(ctx, ns, relPath)
	return err != nil || linked
}

// relUnder reports whether rel is root itself or inside it.
func relUnder(rel, root string) bool {
	return rel == root || strings.HasPrefix(rel, root+"/")
}

// errBusy is returned by downloadSlots.acquire when no slot is free.
var errBusy = errors.New("busy")

// downloadSlots bounds concurrent zip downloads: one per user and a server-wide
// cap. Acquisition never blocks — a busy server answers 429 at once rather
// than parking goroutines (and their open connections) in a queue.
type downloadSlots struct {
	mu     sync.Mutex
	max    int
	active int
	users  map[string]bool
}

func newDownloadSlots(max int) *downloadSlots {
	if max <= 0 {
		max = 2
	}
	return &downloadSlots{max: max, users: map[string]bool{}}
}

// acquire takes the caller's slot and a global one, or returns errBusy. The
// returned release is idempotent and must be deferred.
func (s *downloadSlots) acquire(user string) (func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users[user] || s.active >= s.max {
		return nil, errBusy
	}
	s.users[user] = true
	s.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			delete(s.users, user)
			s.active--
			s.mu.Unlock()
		})
	}, nil
}

// inUse reports the number of held global slots (for tests).
func (s *downloadSlots) inUse() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

// slotKey names the caller for the per-user slot. In multi mode it is the user
// ID, which an API token resolves to as well, so one person cannot hold N
// slots with N tokens. Single mode arrives with no user context (see
// preferences.go) and has exactly one user, so every request shares one key.
func slotKey(r *http.Request) string {
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		return fmt.Sprintf("u%d", uc.ID)
	}
	return "single"
}

// contentDisposition builds an attachment header that is safe for any file
// name: an ASCII-only filename= fallback (quotes, backslashes, control and
// non-ASCII characters replaced) and, when the name is not plain ASCII, an
// RFC 5987 filename* (UTF-8, percent-encoded) with every byte outside
// attr-char escaped. A name
// can therefore never break out of the header or inject a parameter.
func contentDisposition(name string) string {
	var ascii strings.Builder
	plain := true
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f || r > 0x7e:
			plain = false
			ascii.WriteByte('_')
		case r == '"' || r == '\\':
			plain = false
			ascii.WriteByte('_')
		default:
			ascii.WriteRune(r)
		}
	}
	fallback := ascii.String()
	if strings.Trim(fallback, "_. ") == "" {
		fallback = "download"
	}
	h := `attachment; filename="` + fallback + `"`
	if !plain {
		h += "; filename*=UTF-8''" + rfc5987Escape(name)
	}
	return h
}

// rfc5987Escape percent-encodes every byte outside RFC 5987's attr-char set.
func rfc5987Escape(s string) string {
	const attr = "!#$&+-.^_`|~"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.IndexByte(attr, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
