package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// GitStorage is the "git" backend: notes live on the local filesystem exactly
// like the local backend (so reads, Stat, Walk, range serving and the symlink
// containment are inherited unchanged), and mutations are additionally recorded
// to a Committer that maintains git history.
//
// Durability is the filesystem: a write returns once os.WriteFile has returned,
// with no write-behind window — the single-box path stays synchronous. Git
// commits are made asynchronously by the Committer (they carry history, not
// primary durability), mirroring how the git-sync sidecar behaves today but
// owned in-process so no sidecar is needed for local history.
//
// This backend is the "single-writer git path" with HA off: one process owns
// the working tree and the commits. The Redis coherence tier (which makes the
// commit path an out-of-process writer draining a queue) builds on this seam.
type GitStorage struct {
	*LocalStorage
	committer Committer
}

// NewGitStorage wraps a local working tree rooted at root with a Committer.
func NewGitStorage(root string, committer Committer) (*GitStorage, error) {
	ls, err := NewLocalStorage(root)
	if err != nil {
		return nil, err
	}
	return &GitStorage{LocalStorage: ls, committer: committer}, nil
}

func (g *GitStorage) Kind() string { return "git" }

// Close stops the committer (final flush).
func (g *GitStorage) Close() error { return g.committer.Close() }

// --- mutations: do the filesystem op, then record the namespace as dirty ---

func (g *GitStorage) WriteFile(ctx context.Context, ns, relPath string, data []byte) error {
	if err := g.LocalStorage.WriteFile(ctx, ns, relPath, data); err != nil {
		return err
	}
	g.committer.Record(ns)
	return nil
}

func (g *GitStorage) WriteFrom(ctx context.Context, ns, relPath string, r io.Reader, size int64) error {
	if err := g.LocalStorage.WriteFrom(ctx, ns, relPath, r, size); err != nil {
		return err
	}
	g.committer.Record(ns)
	return nil
}

func (g *GitStorage) Append(ctx context.Context, ns, relPath string, data []byte) error {
	if err := g.LocalStorage.Append(ctx, ns, relPath, data); err != nil {
		return err
	}
	g.committer.Record(ns)
	return nil
}

func (g *GitStorage) Remove(ctx context.Context, ns, relPath string) error {
	if err := g.LocalStorage.Remove(ctx, ns, relPath); err != nil {
		return err
	}
	g.committer.Record(ns)
	return nil
}

func (g *GitStorage) RemoveAll(ctx context.Context, ns, relPath string) error {
	if err := g.LocalStorage.RemoveAll(ctx, ns, relPath); err != nil {
		return err
	}
	g.committer.Record(ns)
	return nil
}

func (g *GitStorage) Rename(ctx context.Context, ns, from, to string) error {
	if err := g.LocalStorage.Rename(ctx, ns, from, to); err != nil {
		return err
	}
	g.committer.Record(ns)
	return nil
}

// Committer records namespaces whose working tree changed and commits them to
// git. Record is non-blocking (the bytes are already durable on disk); commits
// happen on an interval or on Flush.
type Committer interface {
	// Record marks a namespace as having uncommitted changes.
	Record(ns string)
	// Flush commits every dirty namespace now. Safe to call concurrently.
	Flush(ctx context.Context) error
	// Close stops any background loop after a final flush.
	Close() error
}

// NoopCommitter records nothing. Used when git history is handled elsewhere
// (e.g. an external git-sync sidecar) or in tests.
type NoopCommitter struct{}

func (NoopCommitter) Record(string)               {}
func (NoopCommitter) Flush(context.Context) error { return nil }
func (NoopCommitter) Close() error                { return nil }

// intervalCommitter commits dirty namespaces to per-namespace git repos on a
// fixed interval. Each namespace directory is its own repository (the layout
// the git-sync sidecar already expects), initialised on first commit.
type intervalCommitter struct {
	root        string
	interval    time.Duration
	authorName  string
	authorEmail string

	mu    sync.Mutex
	dirty map[string]struct{}

	stop chan struct{}
	done chan struct{}
}

// NewIntervalCommitter starts a background committer. authorName/email default
// to a generic mdnest identity when empty.
func NewIntervalCommitter(root string, interval time.Duration, authorName, authorEmail string) *intervalCommitter {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	if authorName == "" {
		authorName = "mdnest"
	}
	if authorEmail == "" {
		authorEmail = "mdnest@localhost"
	}
	c := &intervalCommitter{
		root:        root,
		interval:    interval,
		authorName:  authorName,
		authorEmail: authorEmail,
		dirty:       make(map[string]struct{}),
		stop:        make(chan struct{}),
		done:        make(chan struct{}),
	}
	// Mark every existing namespace dirty so the first flush commits any
	// changes written but not yet committed before a restart (git add -A is a
	// no-op when a namespace has nothing pending, so this creates no empty
	// commits). This is why no graceful-shutdown flush is needed for durability
	// of history: the note bytes are always on disk, and history reconciles on
	// the next flush.
	c.markExisting()
	go c.loop()
	return c
}

// markExisting marks all current namespace directories dirty.
func (c *intervalCommitter) markExisting() {
	entries, err := os.ReadDir(c.root)
	if err != nil {
		return
	}
	c.mu.Lock()
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			c.dirty[e.Name()] = struct{}{}
		}
	}
	c.mu.Unlock()
}

func (c *intervalCommitter) Record(ns string) {
	c.mu.Lock()
	c.dirty[ns] = struct{}{}
	c.mu.Unlock()
}

func (c *intervalCommitter) loop() {
	defer close(c.done)
	t := time.NewTicker(c.interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = c.Flush(context.Background())
		case <-c.stop:
			_ = c.Flush(context.Background())
			return
		}
	}
}

func (c *intervalCommitter) Close() error {
	select {
	case <-c.stop:
		// already closed
	default:
		close(c.stop)
	}
	<-c.done
	return nil
}

func (c *intervalCommitter) Flush(ctx context.Context) error {
	c.mu.Lock()
	pending := make([]string, 0, len(c.dirty))
	for ns := range c.dirty {
		pending = append(pending, ns)
	}
	c.dirty = make(map[string]struct{})
	c.mu.Unlock()

	var firstErr error
	for _, ns := range pending {
		if err := c.commit(ctx, ns); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			// Re-mark so a later flush retries.
			c.Record(ns)
		}
	}
	return firstErr
}

func (c *intervalCommitter) commit(ctx context.Context, ns string) error {
	dir := filepath.Join(c.root, ns)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return nil // namespace gone (deleted); nothing to commit
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		if err := c.git(ctx, dir, "init", "--quiet"); err != nil {
			return fmt.Errorf("git init %s: %w", ns, err)
		}
		_ = c.git(ctx, dir, "config", "user.name", c.authorName)
		_ = c.git(ctx, dir, "config", "user.email", c.authorEmail)
	}
	if err := c.git(ctx, dir, "add", "-A"); err != nil {
		return fmt.Errorf("git add %s: %w", ns, err)
	}
	// Commit only when the index has staged changes.
	if c.git(ctx, dir, "diff", "--cached", "--quiet") == nil {
		return nil // nothing staged
	}
	msg := "mdnest: " + time.Now().UTC().Format("2006-01-02 15:04:05 UTC")
	if err := c.git(ctx, dir, "commit", "--quiet", "-m", msg); err != nil {
		return fmt.Errorf("git commit %s: %w", ns, err)
	}
	return nil
}

func (c *intervalCommitter) git(ctx context.Context, dir string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%v: %s", err, stderr.String())
	}
	return nil
}
