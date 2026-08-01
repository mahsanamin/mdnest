package storage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func tsWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func tsRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// tsCommitPush stages, commits and pushes a scratch working clone's HEAD to the
// remote's main branch.
func tsCommitPush(t *testing.T, dir string) {
	t.Helper()
	run(t, dir, "git", "add", "-A")
	run(t, dir, "git", "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "--quiet", "-m", "x")
	run(t, dir, "git", "push", "--quiet", "origin", "HEAD:main")
}

// TestCommitterTwoWaySync exercises the full bidirectional sync against a local
// bare repo standing in for the remote: it seeds existing remote notes into a
// fresh namespace, pushes a local note up, and pulls an externally-made change
// back down — reflecting each pulled change through the reconciler.
func TestCommitterTwoWaySync(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()

	remoteBase := t.TempDir()
	bare := filepath.Join(remoteBase, "team.git")
	run(t, "", "git", "init", "--bare", "--quiet", "-b", "main", bare)

	// Seed the remote with an existing note via a scratch clone.
	seed := t.TempDir()
	run(t, "", "git", "clone", "--quiet", bare, seed)
	tsWrite(t, filepath.Join(seed, "existing.md"), "from remote")
	tsCommitPush(t, seed)

	root := t.TempDir()
	c := NewIntervalCommitter(root, time.Hour, time.Hour, "ci", "ci@example.com",
		remoteConfig{baseURL: remoteBase, branch: "main"})
	defer c.Close()

	changed := map[string]bool{}
	removed := map[string]bool{}
	fn := reconcileFn(func(_ context.Context, ns string, ch, rm []string) {
		for _, p := range ch {
			changed[ns+"/"+p] = true
		}
		for _, p := range rm {
			removed[ns+"/"+p] = true
		}
	})
	c.reconcile.Store(&fn)

	g, err := NewGitStorage(root, c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}

	// 1) First sync seeds the existing remote note into the empty namespace.
	if err := c.commit(ctx, "team"); err != nil {
		t.Fatalf("seed sync: %v", err)
	}
	if got := tsRead(t, filepath.Join(root, "team", "existing.md")); got != "from remote" {
		t.Fatalf("seed did not import the remote note, got %q", got)
	}
	if !changed["team/existing.md"] {
		t.Fatal("reconciler not called for the seeded note")
	}

	// 2) A local note is pushed up to the remote.
	if err := g.WriteFile(ctx, "team", "local.md", []byte("from mdnest")); err != nil {
		t.Fatal(err)
	}
	if err := c.commit(ctx, "team"); err != nil {
		t.Fatalf("push sync: %v", err)
	}
	verify := t.TempDir()
	run(t, "", "git", "clone", "--quiet", bare, verify)
	if _, err := os.Stat(filepath.Join(verify, "local.md")); err != nil {
		t.Fatal("local note was not pushed to the remote")
	}

	// 3) An externally-made change on the remote is pulled back down + reflected.
	run(t, seed, "git", "pull", "--quiet", "--no-edit", "origin", "main") // adopt local.md so the next push is fast-forward
	tsWrite(t, filepath.Join(seed, "external.md"), "edited elsewhere")
	tsCommitPush(t, seed)

	changed = map[string]bool{}
	if err := c.commit(ctx, "team"); err != nil {
		t.Fatalf("pull sync: %v", err)
	}
	if got := tsRead(t, filepath.Join(root, "team", "external.md")); got != "edited elsewhere" {
		t.Fatalf("external change not pulled, got %q", got)
	}
	if !changed["team/external.md"] {
		t.Fatal("reconciler not called for the pulled note")
	}
}

// statusSinkFunc adapts a func to the SyncStatusSink interface for tests.
type statusSinkFunc func(ns, msg string) error

func (f statusSinkFunc) SetSyncStatus(ns, msg string) error { return f(ns, msg) }

// TestSyncReportsStatusToSink verifies a failing mirror sync is reported to the
// status sink (so the UI can surface it) and a subsequent success clears it.
func TestSyncReportsStatusToSink(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root := t.TempDir()

	// A base URL pointing at a nonexistent bare repo: the fetch/push fails.
	bogus := filepath.Join(t.TempDir(), "missing")
	c := NewIntervalCommitter(root, time.Hour, time.Hour, "ci", "ci@example.com",
		remoteConfig{baseURL: bogus, branch: "main"})
	defer c.Close()

	got := map[string]string{}
	var sink SyncStatusSink = statusSinkFunc(func(ns, msg string) error {
		got[ns] = msg
		return nil
	})
	c.statusSink.Store(&sink)

	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Empty namespace, unreachable remote: the sync fails and is reported.
	_ = c.commit(ctx, "team")
	if got["team"] == "" {
		t.Fatalf("expected a non-empty sync error to be reported")
	}

	// Point at a real, reachable bare remote and sync again: status clears.
	realBase := t.TempDir()
	run(t, "", "git", "init", "--bare", "--quiet", "-b", "main", filepath.Join(realBase, "team.git"))
	c.remote = remoteConfig{baseURL: realBase, branch: "main"}
	delete(c.pushNext, "team") // clear the backoff window from the failure above
	delete(c.pushFails, "team")
	if err := os.WriteFile(filepath.Join(root, "team", "n.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := c.commit(ctx, "team"); err != nil {
		t.Fatalf("recovery sync: %v", err)
	}
	if got["team"] != "" {
		t.Fatalf("expected the error to clear on success, got %q", got["team"])
	}
}
