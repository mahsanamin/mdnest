package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gitT(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t", "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func runSync(t *testing.T, notes string) map[string]string {
	t.Helper()
	w := httptest.NewRecorder()
	NewSyncHandler(notes, nil, nil).HandleSync(w, httptest.NewRequest(http.MethodPost, "/api/admin/sync?ns=work", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("sync: %d %s", w.Code, w.Body.String())
	}
	var m map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// A manual Sync whose pull or push fails says so in syncError. The request
// answers 200 either way, and the Sidebar label shows only the last commit's
// date, so without it a failed Sync looked like one with nothing to do.
func TestSyncReportsAFailedPullOrPush(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	notes := t.TempDir()
	ns := filepath.Join(notes, "work")
	remote := filepath.Join(t.TempDir(), "remote.git")
	if err := os.MkdirAll(ns, 0o755); err != nil {
		t.Fatal(err)
	}
	gitT(t, notes, "init", "-q", "--bare", remote)
	gitT(t, ns, "init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(ns, "a.md"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, ns, "add", "-A")
	gitT(t, ns, "commit", "-q", "-m", "first")
	gitT(t, ns, "remote", "add", "origin", remote)
	gitT(t, ns, "push", "-q", "-u", "origin", "main")

	if m := runSync(t, notes); m["syncError"] != "" {
		t.Fatalf("a working sync reported an error: %q (git: %q)", m["syncError"], m["git"])
	}

	// The remote goes away: pull and push both fail.
	if err := os.RemoveAll(remote); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ns, "a.md"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := runSync(t, notes)
	if m["syncError"] == "" {
		t.Fatalf("a sync whose pull and push failed reported no error (git: %q)", m["git"])
	}
	t.Logf("syncError: %s", m["syncError"])
}
