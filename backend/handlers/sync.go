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
	invalidateCache func(ns string)
}

// NewSyncHandler creates a new sync handler.
func NewSyncHandler(notesDir string, invalidateCache func(string)) *SyncHandler {
	return &SyncHandler{notesDir: notesDir, invalidateCache: invalidateCache}
}

type syncStatusResponse struct {
	IsGitRepo  bool   `json:"isGitRepo"`
	HasRemote  bool   `json:"hasRemote"`
	RemoteURL  string `json:"remoteUrl,omitempty"`
	Branch     string `json:"branch,omitempty"`
	LastCommit string `json:"lastCommit,omitempty"` // date of last commit
	HasSSHKey  bool   `json:"hasSSHKey"`
}

// HandleSyncStatus handles GET /api/admin/sync-status?ns=<namespace>.
// Returns git repo status without pulling.
func (h *SyncHandler) HandleSyncStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
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

	resp := syncStatusResponse{}
	gitDir := findGitDir(nsDir)

	if gitDir != "" {
		resp.IsGitRepo = true

		// Get remote URL
		if out, err := gitCmd(gitDir, "remote", "get-url", "origin"); err == nil {
			resp.RemoteURL = out
			resp.HasRemote = true
		}

		// Get branch
		if out, err := gitCmd(gitDir, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
			resp.Branch = out
		}

		// Get last commit date
		if out, err := gitCmd(gitDir, "log", "-1", "--format=%ci"); err == nil {
			resp.LastCommit = out
		}

		// Check SSH key
		if _, err := os.Stat("/root/.ssh/deploy_key"); err == nil {
			resp.HasSSHKey = true
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// HandleSync handles POST /api/admin/sync?ns=<namespace>.
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
	lastCommit := ""

	gitDir := findGitDir(nsDir)
	if gitDir != "" {
		cmd := exec.Command("git", "pull", "--ff-only")
		cmd.Dir = gitDir

		sshKeyPath := "/root/.ssh/deploy_key"
		if _, err := os.Stat(sshKeyPath); err == nil {
			cmd.Env = append(os.Environ(),
				"GIT_SSH_COMMAND=ssh -i "+sshKeyPath+" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts",
			)
		}

		cmd.Env = append(cmd.Env, "HOME=/root")

		output, err := cmd.CombinedOutput()
		gitOutput = strings.TrimSpace(string(output))
		if err != nil {
			log.Printf("git pull failed for %s: %s", ns, gitOutput)
			gitOutput = "pull failed: " + gitOutput
		} else {
			log.Printf("git pull for %s: %s", ns, gitOutput)
		}

		// Get last commit date after pull
		if out, err := gitCmd(gitDir, "log", "-1", "--format=%ci"); err == nil {
			lastCommit = out
		}
	}

	if h.invalidateCache != nil {
		h.invalidateCache(ns)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":     "ok",
		"git":        gitOutput,
		"lastCommit": lastCommit,
	})
}

func gitCmd(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

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
