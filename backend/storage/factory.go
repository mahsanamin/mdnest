package storage

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// FromEnv constructs a Storage backend from environment variables.
//
//	STORAGE_BACKEND            local (default) | git
//	REDIS_URL                  when set with the git backend, layers a Redis
//	                           working set over it for cross-replica coherence
//	REDIS_WORKINGSET_MAX_BYTES max cached body size (default 1 MiB)
//
// The "git" backend behaves like "local" for reads and durability (notes are
// written synchronously to the filesystem) and additionally maintains git
// history in-process via a background committer. localRoot is the absolute
// NOTES_DIR used by both filesystem-backed backends.
//
// When the git backend is selected and REDIS_URL is configured, the returned
// Storage is wrapped in a CoherentStorage so note-body writes are immediately
// visible to reads on every replica sharing that Redis (the git-native HA
// working-set tier). With no REDIS_URL the git backend is returned as-is (the
// single-box / local-fallback path).
func FromEnv(ctx context.Context, localRoot string) (Storage, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	switch backend {
	case "", "local":
		return NewLocalStorage(localRoot)
	case "git":
		interval := durationEnv("GIT_COMMIT_INTERVAL", 10*time.Second)
		committer := NewIntervalCommitter(localRoot, interval, os.Getenv("GIT_AUTHOR_NAME"), os.Getenv("GIT_AUTHOR_EMAIL"))
		gs, err := NewGitStorage(localRoot, committer)
		if err != nil {
			return nil, err
		}
		if url := strings.TrimSpace(os.Getenv("REDIS_URL")); url != "" {
			ws, err := NewRedisWorkingSet(ctx, url)
			if err != nil {
				return nil, fmt.Errorf("storage: REDIS_URL is set but the working set is unavailable: %w", err)
			}
			return newCoherentStorage(gs, ws, int64Env("REDIS_WORKINGSET_MAX_BYTES", defaultWorkingSetMaxBytes)), nil
		}
		return gs, nil
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

// int64Env reads a positive int64 from the environment, falling back to def
// when unset or unparseable.
func int64Env(key string, def int64) int64 {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}
