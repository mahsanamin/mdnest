package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
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

// intervalCommitter commits dirty namespaces to per-namespace git repos once
// the writer has gone idle on them, rather than on a fixed interval: an edit
// burst (many rapid saves during a live editing session) is coalesced into a
// single commit made after the namespace has seen no new write for `debounce`,
// with `maxWait` as a safety cap so a continuously-edited namespace still
// checkpoints periodically. This keeps the git history readable (one commit per
// editing session, not one every few seconds) without affecting durability —
// note bytes are already on disk (and in the Redis working set) before a commit
// is ever attempted.
//
// Each namespace directory is its own repository (the layout the git-sync
// sidecar already expects), initialised on first commit. When a remote is
// configured each repo is also mirrored (pushed) to it — one remote repository
// per namespace — which is the durability layer app replicas clone.
type intervalCommitter struct {
	root        string
	debounce    time.Duration // commit a namespace after this long with no new write
	maxWait     time.Duration // force a commit once a namespace has been dirty this long
	authorName  string
	authorEmail string
	remote      remoteConfig

	mu    sync.Mutex
	dirty map[string]dirtyEntry

	// Push backoff state, touched only from the (serialized) Flush path.
	pushNext  map[string]time.Time // ns -> earliest next push attempt
	pushFails map[string]int       // ns -> consecutive push failures

	stop chan struct{}
	done chan struct{}
}

// dirtyEntry tracks, for one namespace, when it first became dirty since the
// last successful commit and when it was last written. The loop commits it once
// it has been idle for `debounce` (now-last) or dirty for `maxWait` (now-first).
type dirtyEntry struct {
	first time.Time
	last  time.Time
}

// Push retry backoff bounds: after a failed mirror push a namespace waits
// pushBackoffBase, doubling up to pushBackoffMax, instead of hammering the
// remote every commit interval.
const (
	pushBackoffBase = 30 * time.Second
	pushBackoffMax  = 15 * time.Minute
)

// errPushPending keeps a namespace queued for a later push without pushing (and
// logging) now, while it is inside its backoff window.
var errPushPending = errors.New("storage: push backing off")

// NewIntervalCommitter starts a background committer. It commits a namespace
// once it has been idle for `debounce` (default 2m), capped by `maxWait`
// (default 10m). authorName/email default to a generic mdnest identity when
// empty. A disabled remoteConfig (zero value) keeps history local-only.
func NewIntervalCommitter(root string, debounce, maxWait time.Duration, authorName, authorEmail string, remote remoteConfig) *intervalCommitter {
	if debounce <= 0 {
		debounce = 2 * time.Minute
	}
	if maxWait <= 0 {
		maxWait = 10 * time.Minute
	}
	if maxWait < debounce {
		maxWait = debounce
	}
	if authorName == "" {
		authorName = "mdnest"
	}
	if authorEmail == "" {
		authorEmail = "mdnest@localhost"
	}
	c := &intervalCommitter{
		root:        root,
		debounce:    debounce,
		maxWait:     maxWait,
		authorName:  authorName,
		authorEmail: authorEmail,
		remote:      remote,
		dirty:       make(map[string]dirtyEntry),
		pushNext:    make(map[string]time.Time),
		pushFails:   make(map[string]int),
		stop:        make(chan struct{}),
		done:        make(chan struct{}),
	}
	// Mark every existing namespace dirty (and immediately due) so the first
	// poll commits any changes written but not yet committed before a restart
	// (git add -A is a no-op when a namespace has nothing pending, so this
	// creates no empty commits). This is why no graceful-shutdown flush is
	// needed for durability of history: the note bytes are always on disk, and
	// history reconciles on the next flush.
	c.markExisting()
	go c.loop()
	return c
}

// markExisting marks all current namespace directories dirty and immediately
// due, so pre-restart uncommitted changes reconcile on the first poll.
func (c *intervalCommitter) markExisting() {
	entries, err := os.ReadDir(c.root)
	if err != nil {
		return
	}
	now := time.Now()
	c.mu.Lock()
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			c.dirty[e.Name()] = dirtyEntry{first: now, last: now.Add(-c.debounce)}
		}
	}
	c.mu.Unlock()
}

// Record marks a namespace dirty, resetting its idle timer so the commit fires
// only once writes stop for `debounce`.
func (c *intervalCommitter) Record(ns string) {
	now := time.Now()
	c.mu.Lock()
	e, ok := c.dirty[ns]
	if !ok {
		e.first = now
	}
	e.last = now
	c.dirty[ns] = e
	c.mu.Unlock()
}

// recordDue re-marks a namespace as immediately due after a failed commit, so
// the retry happens on the next poll instead of waiting a full debounce window.
func (c *intervalCommitter) recordDue(ns string) {
	now := time.Now()
	c.mu.Lock()
	e, ok := c.dirty[ns]
	if !ok {
		e.first = now
	}
	e.last = now.Add(-c.debounce)
	c.dirty[ns] = e
	c.mu.Unlock()
}

// pollInterval is how often the loop checks whether a namespace's idle window
// has elapsed. Derived from the debounce (a fraction of it) and clamped so a
// commit fires within a small delay of the writer going idle.
func (c *intervalCommitter) pollInterval() time.Duration {
	p := c.debounce / 6
	if p < time.Second {
		p = time.Second
	}
	if p > 15*time.Second {
		p = 15 * time.Second
	}
	return p
}

func (c *intervalCommitter) loop() {
	defer close(c.done)
	t := time.NewTicker(c.pollInterval())
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = c.flushDue(context.Background(), time.Now())
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

// Flush commits every dirty namespace now, regardless of its idle window. Used
// on shutdown and by callers that need an immediate checkpoint.
func (c *intervalCommitter) Flush(ctx context.Context) error {
	c.mu.Lock()
	pending := make([]string, 0, len(c.dirty))
	for ns := range c.dirty {
		pending = append(pending, ns)
	}
	c.dirty = make(map[string]dirtyEntry)
	c.mu.Unlock()
	return c.commitList(ctx, pending)
}

// flushDue commits only the namespaces whose idle window (debounce) or maximum
// dirty age (maxWait) has elapsed as of now.
func (c *intervalCommitter) flushDue(ctx context.Context, now time.Time) error {
	c.mu.Lock()
	var pending []string
	for ns, e := range c.dirty {
		if now.Sub(e.last) >= c.debounce || now.Sub(e.first) >= c.maxWait {
			pending = append(pending, ns)
			delete(c.dirty, ns)
		}
	}
	c.mu.Unlock()
	return c.commitList(ctx, pending)
}

// commitList commits each namespace in turn, re-marking any that fail as due so
// a later poll retries them (without waiting the full debounce again).
func (c *intervalCommitter) commitList(ctx context.Context, pending []string) error {
	var firstErr error
	for _, ns := range pending {
		if err := c.commit(ctx, ns); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			c.recordDue(ns)
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
	if c.git(ctx, dir, "diff", "--cached", "--quiet") != nil {
		msg := "mdnest: " + time.Now().UTC().Format("2006-01-02 15:04:05 UTC")
		if err := c.git(ctx, dir, "commit", "--quiet", "-m", msg); err != nil {
			return fmt.Errorf("git commit %s: %w", ns, err)
		}
	}
	// Mirror to the remote (one repo per namespace). Pushing an unchanged repo
	// is a cheap "up-to-date" no-op, so this also flushes any commit whose push
	// failed on an earlier flush (the namespace stays marked dirty until it
	// succeeds).
	if c.remote.enabled() {
		return c.pushWithBackoff(ctx, dir, ns)
	}
	return nil
}

// pushWithBackoff mirrors a namespace, applying exponential backoff after a
// failure so a missing/misconfigured remote does not trigger a failing push (and
// a log line) on every commit interval. It returns a non-nil error while a push
// is still owed, which keeps the namespace marked dirty for a later retry.
func (c *intervalCommitter) pushWithBackoff(ctx context.Context, dir, ns string) error {
	if t, ok := c.pushNext[ns]; ok && time.Now().Before(t) {
		return errPushPending // inside the backoff window; retry later, no push/log
	}
	if err := c.push(ctx, dir, ns); err != nil {
		n := c.pushFails[ns] + 1
		c.pushFails[ns] = n
		shift := n - 1
		if shift > 5 {
			shift = 5
		}
		backoff := pushBackoffBase << uint(shift)
		if backoff > pushBackoffMax {
			backoff = pushBackoffMax
		}
		c.pushNext[ns] = time.Now().Add(backoff)
		if n == 1 || n%10 == 0 { // log the first failure and every 10th, not every retry
			log.Printf("storage: git push %s failed (attempt %d, backing off %s): %v", ns, n, backoff, err)
		}
		return err
	}
	delete(c.pushFails, ns)
	delete(c.pushNext, ns)
	return nil
}

// push mirrors a namespace repo to its remote over HTTPS. Credentials are
// supplied out-of-band via the askpass helper (see remoteConfig), never in argv.
func (c *intervalCommitter) push(ctx context.Context, dir, ns string) error {
	remoteURL, err := c.remote.remoteURL(ns)
	if err != nil {
		return fmt.Errorf("git remote url %s: %w", ns, err)
	}
	cmd := exec.CommandContext(ctx, "git", "push", remoteURL, "HEAD:refs/heads/"+c.remote.branch)
	cmd.Dir = dir
	cmd.Env = c.remote.pushEnv()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git push %s: %v: %s", ns, err, stderr.String())
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
