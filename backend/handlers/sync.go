package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// SyncHandler handles git pull and cache refresh for namespaces.
type SyncHandler struct {
	notesDir        string
	invalidateCache func(ns string) // clears search cache for a namespace
}

// NewSyncHandler creates a new sync handler.
func NewSyncHandler(notesDir string, invalidateCache func(string)) *SyncHandler {
	return &SyncHandler{notesDir: notesDir, invalidateCache: invalidateCache}
}

// HandleSync handles POST /api/admin/sync?ns=<namespace>.
// If the namespace is a git repo, runs git pull. Always invalidates the search cache.
func (h *SyncHandler) HandleSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	ns := r.URL.Query().Get("ns")
	if ns == "" {
		http.Error(w, `{"error":"ns parameter is required"}`, http.StatusBadRequest)
		return
	}

	if strings.Contains(ns, "/") || strings.Contains(ns, "..") || strings.HasPrefix(ns, ".") {
		http.Error(w, `{"error":"invalid namespace"}`, http.StatusBadRequest)
		return
	}

	nsDir := filepath.Join(h.notesDir, ns)
	info, err := os.Stat(nsDir)
	if err != nil || !info.IsDir() {
		http.Error(w, `{"error":"namespace not found"}`, http.StatusNotFound)
		return
	}

	gitOutput := ""

	// Try git pull if it's a git repo
	gitDir := findGitDir(nsDir)
	if gitDir != "" {
		cmd := exec.Command("git", "pull", "--ff-only")
		cmd.Dir = gitDir
		output, err := cmd.CombinedOutput()
		gitOutput = strings.TrimSpace(string(output))
		if err != nil {
			log.Printf("git pull failed for %s: %s", ns, gitOutput)
			// Don't fail the request — still invalidate cache
			gitOutput = "pull failed: " + gitOutput
		} else {
			log.Printf("git pull for %s: %s", ns, gitOutput)
		}
	}

	// Always invalidate search cache
	if h.invalidateCache != nil {
		h.invalidateCache(ns)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
		"git":    gitOutput,
	})
}

// findGitDir walks up from dir looking for a .git directory.
func findGitDir(dir string) string {
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}
