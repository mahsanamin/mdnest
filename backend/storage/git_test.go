package storage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestGitStorage_CommitsHistory verifies the git backend: writes are durable on
// disk immediately (like local), and the committer turns each namespace into a
// git repo with real commits, without creating empty commits when nothing
// changed.
func TestGitStorage_CommitsHistory(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root := t.TempDir()

	// Long debounce so the background loop never fires; we flush manually.
	c := NewIntervalCommitter(root, time.Hour, time.Hour, "ci", "ci@example.com", remoteConfig{})
	defer c.Close()
	g, err := NewGitStorage(root, c)
	if err != nil {
		t.Fatal(err)
	}
	if g.Kind() != "git" {
		t.Fatalf("Kind = %q, want git", g.Kind())
	}
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := g.WriteFile(ctx, "team", "hello.md", []byte("hi")); err != nil {
		t.Fatal(err)
	}
	// Durable on disk immediately — no commit needed to read it back.
	if b, err := g.ReadFile(ctx, "team", "hello.md"); err != nil || string(b) != "hi" {
		t.Fatalf("read back: %q %v", b, err)
	}

	if err := c.Flush(ctx); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if log := gitOut(t, filepath.Join(root, "team"), "log", "--oneline"); strings.TrimSpace(log) == "" {
		t.Fatal("no commit was recorded")
	}
	if files := gitOut(t, filepath.Join(root, "team"), "ls-files"); !strings.Contains(files, "hello.md") {
		t.Fatalf("hello.md not tracked; ls-files=%q", files)
	}

	// A flush with no changes must not create an empty commit.
	before := strings.TrimSpace(gitOut(t, filepath.Join(root, "team"), "rev-list", "--count", "HEAD"))
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	after := strings.TrimSpace(gitOut(t, filepath.Join(root, "team"), "rev-list", "--count", "HEAD"))
	if before != after {
		t.Fatalf("empty flush created a commit: %s -> %s", before, after)
	}
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v in %s: %v", args, dir, err)
	}
	return string(out)
}
