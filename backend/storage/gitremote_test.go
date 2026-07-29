package storage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestRemoteURLEmbedsUsernameNotToken(t *testing.T) {
	c := remoteConfig{baseURL: "https://gitlab.forterro.com/mdnest-workspaces", username: "oauth2", branch: "main"}
	got, err := c.remoteURL("team_a")
	if err != nil {
		t.Fatalf("remoteURL: %v", err)
	}
	const want = "https://oauth2@gitlab.forterro.com/mdnest-workspaces/team_a.git"
	if got != want {
		t.Fatalf("remoteURL = %q, want %q", got, want)
	}
}

func TestDisabledRemoteFromEmptyBase(t *testing.T) {
	if (remoteConfig{}).enabled() {
		t.Fatal("zero-value remoteConfig should be disabled")
	}
}

// TestCommitterPushesToRemote exercises the real commit+push path against a
// local bare repo standing in for the GitLab remote (file transport, so no PAT
// is needed). It proves a namespace repo is mirrored one-repo-per-namespace.
func TestCommitterPushesToRemote(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()

	// A bare repo per namespace under remoteBase, matching remoteURL layout.
	remoteBase := t.TempDir()
	bare := filepath.Join(remoteBase, "team.git")
	run(t, "", "git", "init", "--bare", "--quiet", "-b", "main", bare)

	root := t.TempDir()
	remote := remoteConfig{baseURL: remoteBase, branch: "main"} // username empty → clean file path
	c := NewIntervalCommitter(root, time.Hour, "ci", "ci@example.com", remote)
	defer c.Close()
	g, err := NewGitStorage(root, c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := g.WriteFile(ctx, "team", "hello.md", []byte("pushed")); err != nil {
		t.Fatal(err)
	}
	if err := c.Flush(ctx); err != nil {
		t.Fatalf("Flush (commit+push): %v", err)
	}

	// Clone the "remote" and assert the content arrived.
	clone := filepath.Join(t.TempDir(), "clone")
	run(t, "", "git", "clone", "--quiet", bare, clone)
	got, err := os.ReadFile(filepath.Join(clone, "hello.md"))
	if err != nil {
		t.Fatalf("read cloned file: %v", err)
	}
	if string(got) != "pushed" {
		t.Fatalf("cloned body = %q, want %q", got, "pushed")
	}
}

func run(t *testing.T, dir string, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
}
