package storage

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

// FromEnv constructs a Storage backend from environment variables.
//
//	STORAGE_BACKEND   local (default) | git
//
// The "git" backend behaves like "local" for reads and durability (notes are
// written synchronously to the filesystem) and additionally maintains git
// history in-process via a background committer. localRoot is the absolute
// NOTES_DIR used by both filesystem-backed backends.
func FromEnv(ctx context.Context, localRoot string) (Storage, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	switch backend {
	case "", "local":
		return NewLocalStorage(localRoot)
	case "git":
		interval := durationEnv("GIT_COMMIT_INTERVAL", 10*time.Second)
		committer := NewIntervalCommitter(localRoot, interval, os.Getenv("GIT_AUTHOR_NAME"), os.Getenv("GIT_AUTHOR_EMAIL"))
		return NewGitStorage(localRoot, committer)
	default:
		return nil, fmt.Errorf("storage: unknown STORAGE_BACKEND %q (want local or git)", backend)
	}
}

// durationEnv reads a Go duration (e.g. "10s") from the environment, falling
// back to def when unset or unparseable.
func durationEnv(key string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}
