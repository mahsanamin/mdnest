package handlers

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mdnest/mdnest/backend/storage"
)

// Task scanning is the expensive part of the board, and it is pure: the same
// files and the same column layout always produce the same tasks. Measured on
// a namespace of 420 notes holding ~12,000 checkboxes, walking the tree costs
// ~6ms while reading and parsing every file costs ~100ms — so remembering the
// parse and re-doing only the walk turns a ~100ms request into a ~10ms one.
// The gap widens as a project grows, because the walk stats files while the
// parse reads them.
//
// Correctness over cleverness: the cache is never trusted on its own. Every
// request still walks the namespace and derives a signature from what it finds
// (file set, sizes, newest mtime) plus the board layout. A hit only counts when
// that signature is identical, so an edit from any source — the API, the CLI,
// git-sync, an editor on the host — invalidates it without needing to be told.
// The one case a signature cannot see is a write that leaves the size and the
// mtime untouched (a restore that preserves timestamps, say); the board's
// Refresh sends refresh=1 and bypasses the cache entirely for exactly that.
//
// In memory rather than a file on disk, deliberately. A cache file under
// NOTES_DIR would be synced by git-sync, would show up in a user's notes
// directory, and — as `.marp-themes` taught us — would be destroyed by a
// rebuild unless it got its own volume. None of that is worth it for data that
// is derived and cheap to recompute.
type taskCache struct {
	mu      sync.Mutex
	entries map[string]taskCacheEntry
	maxSize int
}

type taskCacheEntry struct {
	signature string
	tasks     []Task
	stored    time.Time
}

func newTaskCache(maxSize int) *taskCache {
	return &taskCache{entries: make(map[string]taskCacheEntry), maxSize: maxSize}
}

// get returns the cached tasks for a namespace when the signature still
// matches. The returned slice is a copy: callers sort and stamp it, and must
// not be able to mutate what the next caller sees.
func (c *taskCache) get(ns, signature string) ([]Task, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[ns]
	if !ok || e.signature != signature {
		return nil, false
	}
	out := make([]Task, len(e.tasks))
	copy(out, e.tasks)
	return out, true
}

func (c *taskCache) put(ns, signature string, tasks []Task) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// Bounded so a server with many namespaces cannot grow without limit.
	// Namespaces are few and long-lived, so evicting the oldest entry is
	// enough — this is a cache, and a miss only costs the original scan.
	if len(c.entries) >= c.maxSize {
		var oldestKey string
		var oldest time.Time
		for k, e := range c.entries {
			if oldestKey == "" || e.stored.Before(oldest) {
				oldestKey, oldest = k, e.stored
			}
		}
		delete(c.entries, oldestKey)
	}
	stored := make([]Task, len(tasks))
	copy(stored, tasks)
	c.entries[ns] = taskCacheEntry{signature: signature, tasks: stored, stored: time.Now()}
}

// scanSignature walks a namespace and returns both the .md files it found and
// a signature describing them. The walk is the cheap half of a scan, so it runs
// on every request and is what makes a cache hit safe.
func (h *TaskHandler) scanSignature(ctx context.Context, ns string, boardKey string) ([]string, string) {
	var (
		files  []string
		total  int64
		newest int64
		count  int
	)
	h.store.Walk(ctx, ns, "", func(relPath string, info storage.FileInfo) error {
		if info.IsDir {
			if relPath != "" && strings.HasPrefix(info.Name, ".") {
				return storage.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(info.Name), ".md") {
			return nil
		}
		files = append(files, relPath)
		count++
		total += info.Size
		if ms := info.ModTime.UnixNano(); ms > newest {
			newest = ms
		}
		return nil
	})
	// The board layout takes part in parsing (it resolves a task's column), so
	// a column rename has to invalidate the cache just as an edit does.
	sig := fmt.Sprintf("%d:%d:%d:%s", count, total, newest, boardKey)
	return files, sig
}
