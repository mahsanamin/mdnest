package handlers

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// HistoryHandler exposes the per-file git history that the storage backend
// maintains. Two endpoints:
//
//	GET /api/note/history?ns=&path=     list of recent commits affecting a file
//	GET /api/note/at?ns=&path=&ref=     content of a file at a specific commit
//
// Both read a per-namespace .git/ directly off the local filesystem. On a
// git-native HA deployment the stateless app replicas own no git tree — only
// the writer does — so when a writerProxy is configured (MDNEST_ROLE=app) both
// endpoints forward to the writer, exactly like attachment traffic. Without a
// proxy and without a local .git/ (single/writer with a namespace that has no
// history yet), both return 404 so the frontend can hide the History entry.
type HistoryHandler struct {
	notesDir string
	// writerProxy, when set (git-native HA app replicas), forwards history reads
	// to the writer, which owns the git tree. App replicas keep no .git/ locally,
	// so history can only be answered by the writer.
	writerProxy http.Handler
}

// NewHistoryHandler creates a new history handler.
func NewHistoryHandler(notesDir string) *HistoryHandler {
	return &HistoryHandler{notesDir: notesDir}
}

// SetWriterProxy makes the read-only history endpoints reverse-proxy to the
// writer. Used on stateless app replicas, which hold no git tree locally.
func (h *HistoryHandler) SetWriterProxy(p http.Handler) { h.writerProxy = p }

// shaRe matches a 7-40 char hex string. We deliberately reject branch
// names, HEAD~N, tags, and other ref forms — accepting only commit SHAs
// keeps the surface small and predictable. Users land on a SHA via the
// history list anyway; arbitrary ref strings aren't a feature.
var shaRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// commitEntry is one row in the history response.
type commitEntry struct {
	Commit  string `json:"commit"`
	UnixTS  int64  `json:"unix_ts"`
	Author  string `json:"author"`
	Message string `json:"message"`
}

// HandleHistory handles GET /api/note/history?ns=<n>&path=<p>.
// Returns up to 50 most recent commits that touched the given path,
// newest first.
func (h *HistoryHandler) HandleHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	// App replicas hold no git tree: the writer owns it, so history can only be
	// answered there. Forward the read rather than reporting a bogus "no history".
	if h.writerProxy != nil {
		h.writerProxy.ServeHTTP(w, r)
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

	gitDir := findGitDir(nsDir)
	if gitDir == "" {
		http.Error(w, `{"error":"git-sync is not configured for this namespace"}`, http.StatusNotFound)
		return
	}

	// Compute the path relative to gitDir so git log understands it.
	// In the common case gitDir == nsDir and rel == reqPath.
	rel, err := filepath.Rel(gitDir, absPath)
	if err != nil {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	// %H = full SHA, %ct = committer unix timestamp, %an = author name,
	// %s = subject. Tab-separated for easy parsing; tabs are not allowed
	// in author names or subjects in normal git workflows, and even if
	// they appeared we'd just truncate one field — not a security issue.
	out, err := gitCmd(gitDir, "log", "--max-count=50", "--pretty=format:%H%x09%ct%x09%an%x09%s", "--", rel)
	if err != nil {
		// `git log` returns 0 even when no commits match; an actual error
		// here is "git not installed" or "not a git repo" or similar.
		http.Error(w, `{"error":"failed to read git history"}`, http.StatusInternalServerError)
		return
	}

	entries := []commitEntry{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			continue
		}
		ts, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			continue
		}
		entries = append(entries, commitEntry{
			Commit:  parts[0],
			UnixTS:  ts,
			Author:  parts[2],
			Message: parts[3],
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

// HandleNoteAt handles GET /api/note/at?ns=<n>&path=<p>&ref=<sha>.
// Returns the file's content at that commit. Read-only; no ETag header
// (this is a historical snapshot, not editable through this endpoint —
// restoration goes through PUT /api/note?restore-from=<sha>).
func (h *HistoryHandler) HandleNoteAt(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	// App replicas hold no git tree: forward the snapshot read to the writer.
	if h.writerProxy != nil {
		h.writerProxy.ServeHTTP(w, r)
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

	ref := r.URL.Query().Get("ref")
	if !shaRe.MatchString(ref) {
		http.Error(w, `{"error":"invalid ref — must be a commit SHA"}`, http.StatusBadRequest)
		return
	}

	gitDir := findGitDir(nsDir)
	if gitDir == "" {
		http.Error(w, `{"error":"git-sync is not configured for this namespace"}`, http.StatusNotFound)
		return
	}

	rel, err := filepath.Rel(gitDir, absPath)
	if err != nil {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	// `git show <sha>:<path>`. Run directly via exec.Command rather than
	// the shared gitCmd helper because gitCmd does TrimSpace on its
	// output, which would silently strip trailing newlines from the file
	// content. For history viewing + restoration we want byte-faithful
	// output so the displayed (and potentially restored) content matches
	// what git stored.
	cmd := exec.Command("git", "show", ref+":"+rel)
	cmd.Dir = gitDir
	out, err := cmd.Output()
	if err != nil {
		// Most likely: that path didn't exist at that commit, or the SHA
		// itself doesn't exist. Either way the user picked a bad combo;
		// surface it as a 404 rather than a 500.
		http.Error(w, `{"error":"file not found at that commit"}`, http.StatusNotFound)
		return
	}

	// Strip the mdnest note ID marker before returning, just like getNote
	// does — the marker is invisible to users and would be confusing in a
	// historical snapshot view.
	_, clean := ExtractNoteID(string(out))

	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Write([]byte(clean))
}
