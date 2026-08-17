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

// TestCommitMessage_NoAttribution keeps the message identical to the previous
// timestamp-only form when nothing was attributed (single-user mode, CLI writes,
// remote merges).
func TestCommitMessage_NoAttribution(t *testing.T) {
	c := &intervalCommitter{}
	msg := c.commitMessage(nil)
	if !strings.HasPrefix(msg, "mdnest: ") {
		t.Fatalf("subject = %q, want mdnest: prefix", msg)
	}
	if strings.Contains(msg, "Co-authored-by") || strings.Contains(msg, "\n\n") {
		t.Fatalf("expected a bare subject, got %q", msg)
	}
}

// TestCommitMessage_Attribution lists each file's savers and emits one
// deduplicated, sorted Co-authored-by trailer per contributor.
func TestCommitMessage_Attribution(t *testing.T) {
	files := map[string]map[ident]struct{}{
		"projects/plan.md": {
			{name: "Bob", email: "bob@x"}:     {},
			{name: "Alice", email: "alice@x"}: {},
		},
		"notes/todo.md": {
			{name: "Alice", email: "alice@x"}: {},
		},
	}
	msg := (&intervalCommitter{}).commitMessage(files)

	// Per-file lines: paths sorted, names sorted within a line.
	if !strings.Contains(msg, "notes/todo.md — Alice\n") {
		t.Errorf("missing todo line in:\n%s", msg)
	}
	if !strings.Contains(msg, "projects/plan.md — Alice, Bob\n") {
		t.Errorf("missing plan line in:\n%s", msg)
	}
	// The file body must come before the trailers.
	if strings.Index(msg, "projects/plan.md") > strings.Index(msg, "Co-authored-by") {
		t.Errorf("file body should precede trailers:\n%s", msg)
	}
	// One trailer per contributor, deduplicated (Alice saved two files).
	if n := strings.Count(msg, "Co-authored-by:"); n != 2 {
		t.Errorf("Co-authored-by count = %d, want 2:\n%s", n, msg)
	}
	if !strings.Contains(msg, "Co-authored-by: Alice <alice@x>") {
		t.Errorf("missing Alice trailer:\n%s", msg)
	}
	if !strings.Contains(msg, "Co-authored-by: Bob <bob@x>") {
		t.Errorf("missing Bob trailer:\n%s", msg)
	}
}

// TestCommitMessage_MissingEmail synthesises a stable noreply address so the
// trailer stays well-formed when a saver has no resolvable email.
func TestCommitMessage_MissingEmail(t *testing.T) {
	files := map[string]map[ident]struct{}{
		"a.md": {{name: "Jane Doe", email: ""}: {}},
	}
	msg := (&intervalCommitter{}).commitMessage(files)
	if !strings.Contains(msg, "Co-authored-by: Jane Doe <jane.doe@users.noreply.mdnest>") {
		t.Fatalf("expected synthesised noreply trailer, got:\n%s", msg)
	}
}

// TestGitStorage_AttributedCommit exercises the full path: a write followed by
// Attribute produces a real commit whose message carries the file line and the
// Co-authored-by trailer.
func TestGitStorage_AttributedCommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root := t.TempDir()

	c := NewIntervalCommitter(root, time.Hour, time.Hour, "ci", "ci@example.com", remoteConfig{})
	defer c.Close()
	g, err := NewGitStorage(root, c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := g.WriteFile(ctx, "team", "hello.md", []byte("hi")); err != nil {
		t.Fatal(err)
	}
	g.Attribute("team", "hello.md", "Alice", "alice@example.com")
	if err := c.Flush(ctx); err != nil {
		t.Fatalf("flush: %v", err)
	}

	body := gitOut(t, filepath.Join(root, "team"), "log", "-1", "--format=%B")
	if !strings.Contains(body, "hello.md — Alice") {
		t.Errorf("commit body missing file attribution:\n%s", body)
	}
	if !strings.Contains(body, "Co-authored-by: Alice <alice@example.com>") {
		t.Errorf("commit body missing co-author trailer:\n%s", body)
	}

	// A second commit must not re-credit the drained contributor.
	if err := g.WriteFile(ctx, "team", "hello.md", []byte("hi again")); err != nil {
		t.Fatal(err)
	}
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	body2 := gitOut(t, filepath.Join(root, "team"), "log", "-1", "--format=%B")
	if strings.Contains(body2, "Co-authored-by") {
		t.Errorf("second commit should carry no stale attribution:\n%s", body2)
	}
}
