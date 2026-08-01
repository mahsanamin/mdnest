package storage

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

// FromEnv constructs a Storage backend from environment variables.
//
//	MDNEST_ROLE                single (default) | app | writer
//	STORAGE_BACKEND            local (default) | git   (single role only)
//	REDIS_URL                  Redis coherence tier (required for app/writer;
//	                           with the git backend in single role it layers a
//	                           working set for cross-replica coherence)
//	REDIS_WORKINGSET_MAX_BYTES max cached body size (default 1 MiB)
//	MDNEST_WRITER_LOCK_TTL     writer leader lock TTL (default 15s, writer role)
//
// Roles (git-native HA):
//   - single: the standalone process. STORAGE_BACKEND picks local/git; with the
//     git backend and REDIS_URL set it gains the working-set tier. No queue.
//   - app: a stateless replica. Reads are served from the Redis working set
//     (hydrated by the writer); writes publish to the working set and enqueue on
//     the durability queue. Owns no filesystem.
//   - writer: the single elected writer. Owns the authoritative git tree, drains
//     the durability queue in a background goroutine, and serves reads through
//     the working set.
//
// localRoot is the absolute NOTES_DIR (the working tree for single/writer;
// unused for app, which is filesystem-less).
func FromEnv(ctx context.Context, localRoot string, resolver RemoteResolver) (Storage, error) {
	switch role := strings.ToLower(strings.TrimSpace(os.Getenv("MDNEST_ROLE"))); role {
	case "", "single":
		return fromEnvSingle(ctx, localRoot, resolver)
	case "app":
		return newAppStorage(ctx, localRoot)
	case "writer":
		return newWriterStorage(ctx, localRoot, resolver)
	default:
		return nil, fmt.Errorf("storage: unknown MDNEST_ROLE %q (want single, app or writer)", role)
	}
}

// fromEnvSingle builds the standalone backend selected by STORAGE_BACKEND.
func fromEnvSingle(ctx context.Context, localRoot string, resolver RemoteResolver) (Storage, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	switch backend {
	case "", "local":
		return NewLocalStorage(localRoot)
	case "git":
		gs, err := newGitStorageFromEnv(localRoot, resolver)
		if err != nil {
			return nil, err
		}
		if url := strings.TrimSpace(os.Getenv("REDIS_URL")); url != "" {
			ws, err := NewRedisWorkingSet(ctx, url)
			if err != nil {
				return nil, fmt.Errorf("storage: REDIS_URL is set but the working set is unavailable: %w", err)
			}
			gs.SetReconciler(makeReflector(gs, ws, workingSetCap()))
			return newCoherentStorage(gs, ws, workingSetCap()), nil
		}
		return gs, nil
	default:
		return nil, fmt.Errorf("storage: unknown STORAGE_BACKEND %q (want local or git)", backend)
	}
}

// newAppStorage builds a stateless app replica: reads are served from the Redis
// working set (hydrated by the writer), writes publish to the working set and
// enqueue a durability op. The replica owns no filesystem.
func newAppStorage(ctx context.Context, _ string) (Storage, error) {
	url := strings.TrimSpace(os.Getenv("REDIS_URL"))
	if url == "" {
		return nil, errors.New("storage: MDNEST_ROLE=app requires REDIS_URL")
	}
	ws, err := NewRedisWorkingSet(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("storage: app working set unavailable: %w", err)
	}
	queue, err := NewRedisStreamQueue(ctx, url, instanceID())
	if err != nil {
		return nil, fmt.Errorf("storage: app durability queue unavailable: %w", err)
	}
	return NewQueuedStorage(ws, queue, workingSetCap()), nil
}

// newWriterStorage builds the single writer: it owns the git tree, starts the
// drain loop in a background goroutine, and serves reads through the working
// set. The goroutine ends when ctx is cancelled or leadership is lost.
func newWriterStorage(ctx context.Context, localRoot string, resolver RemoteResolver) (Storage, error) {
	url := strings.TrimSpace(os.Getenv("REDIS_URL"))
	if url == "" {
		return nil, errors.New("storage: MDNEST_ROLE=writer requires REDIS_URL")
	}
	ws, err := NewRedisWorkingSet(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("storage: writer working set unavailable: %w", err)
	}
	id := instanceID()
	queue, err := NewRedisStreamQueue(ctx, url, id)
	if err != nil {
		return nil, fmt.Errorf("storage: writer durability queue unavailable: %w", err)
	}
	leader, err := NewRedisLeader(ctx, url, id, durationEnv("MDNEST_WRITER_LOCK_TTL", 15*time.Second))
	if err != nil {
		return nil, fmt.Errorf("storage: writer leader election unavailable: %w", err)
	}
	gs, err := newGitStorageFromEnv(localRoot, resolver)
	if err != nil {
		return nil, err
	}
	w := NewWriter(gs, ws, queue, leader, workingSetCap())
	gs.SetReconciler(makeReflector(gs, ws, workingSetCap()))
	go func() {
		if err := w.Run(ctx); err != nil && ctx.Err() == nil {
			log.Printf("storage: durability writer stopped: %v", err)
		}
	}()
	return newCoherentStorage(gs, ws, workingSetCap()), nil
}

// newGitStorageFromEnv builds a git backend (its interval committer and the
// optional per-namespace remote mirror) from the environment. Shared by the
// single-git and writer roles.
func newGitStorageFromEnv(localRoot string, resolver RemoteResolver) (*GitStorage, error) {
	debounce := durationEnv("GIT_COMMIT_DEBOUNCE", 2*time.Minute)
	maxWait := durationEnv("GIT_COMMIT_MAX_WAIT", 10*time.Minute)
	remote, err := remoteConfigFromEnv()
	if err != nil {
		return nil, err
	}
	committer := NewIntervalCommitter(localRoot, debounce, maxWait, os.Getenv("GIT_AUTHOR_NAME"), os.Getenv("GIT_AUTHOR_EMAIL"), remote)
	committer.resolver = resolver
	committer.syncInterval.Store(int64(durationEnv("GIT_SYNC_INTERVAL", time.Minute)))
	return NewGitStorage(localRoot, committer)
}

// instanceID returns a per-instance identifier (the hostname / pod name) used
// for the queue consumer name and the writer leader-lock owner.
func instanceID() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "mdnest"
}

// workingSetCap resolves the working-set body cap from the environment.
func workingSetCap() int64 {
	return int64Env("REDIS_WORKINGSET_MAX_BYTES", defaultWorkingSetMaxBytes)
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
