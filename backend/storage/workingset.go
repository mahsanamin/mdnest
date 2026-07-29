package storage

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"
)

// WorkingSet is the shared, non-durable coherence tier keyed by (namespace,
// relPath). It holds note bodies so a write on one replica is immediately
// visible to reads on every other replica sharing the same Redis.
//
// It is a cache/coherence layer, never the durability layer: CoherentStorage
// writes every mutation through to the inner Storage (the filesystem/git) first
// and updates the working set only after the durable write succeeds; on a miss,
// reads fall back to the inner Storage and hydrate the working set. Every method
// takes a context so callers can bound Redis round-trips.
type WorkingSet interface {
	// Get returns the cached body for (ns, relPath). ok is false on a miss.
	Get(ctx context.Context, ns, relPath string) (data []byte, ok bool, err error)
	// Set stores (or replaces) the cached body for (ns, relPath).
	Set(ctx context.Context, ns, relPath string, data []byte) error
	// Delete drops the cached body for (ns, relPath). It is a no-op on a miss.
	Delete(ctx context.Context, ns, relPath string) error
	// DeletePrefix drops every cached body at relPath and below (relPath == ""
	// clears the whole namespace). Used for recursive removes and renames.
	DeletePrefix(ctx context.Context, ns, relPath string) error

	// AddNamespace registers a namespace so it is listed even while it holds no
	// files (e.g. a freshly created, empty workspace).
	AddNamespace(ctx context.Context, ns string) error
	// RemoveNamespace drops a namespace and every body under it.
	RemoveNamespace(ctx context.Context, ns string) error
	// Namespaces returns the registered namespaces (unsorted).
	Namespaces(ctx context.Context) ([]string, error)
	// List returns every cached relPath in a namespace (unsorted). Stateless
	// replicas derive directory listings and Stat from it.
	List(ctx context.Context, ns string) ([]string, error)

	// Close releases the underlying connection.
	Close() error
}

// NoopWorkingSet satisfies WorkingSet without storing anything. It is used when
// no Redis is configured (the "local fallback": CoherentStorage is not even
// constructed in that case, so this exists mainly for tests and completeness).
type NoopWorkingSet struct{}

func (NoopWorkingSet) Get(context.Context, string, string) ([]byte, bool, error) {
	return nil, false, nil
}
func (NoopWorkingSet) Set(context.Context, string, string, []byte) error  { return nil }
func (NoopWorkingSet) Delete(context.Context, string, string) error       { return nil }
func (NoopWorkingSet) DeletePrefix(context.Context, string, string) error { return nil }
func (NoopWorkingSet) AddNamespace(context.Context, string) error         { return nil }
func (NoopWorkingSet) RemoveNamespace(context.Context, string) error      { return nil }
func (NoopWorkingSet) Namespaces(context.Context) ([]string, error)       { return nil, nil }
func (NoopWorkingSet) List(context.Context, string) ([]string, error)     { return nil, nil }
func (NoopWorkingSet) Close() error                                       { return nil }

// RedisWorkingSet implements WorkingSet over Redis. Bodies are stored under
// note:{ns}:{relPath} and each namespace keeps a companion index set
// noteset:{ns} listing its paths, so DeletePrefix can enumerate members without
// a blocking KEYS/SCAN or glob-escaping the (arbitrary) note paths.
type RedisWorkingSet struct {
	client *redis.Client
}

// NewRedisWorkingSet connects to Redis and verifies reachability before
// returning. The url uses the standard redis:// / rediss:// form parsed by
// go-redis (host, port, db, auth, TLS all encoded there), the same form the
// collab backplane already consumes from REDIS_URL.
func NewRedisWorkingSet(ctx context.Context, url string) (*RedisWorkingSet, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &RedisWorkingSet{client: client}, nil
}

func noteKey(ns, relPath string) string { return "note:" + ns + ":" + relPath }
func nsIndexKey(ns string) string       { return "noteset:" + ns }

// nsRegistryKey is the set of all known namespaces (workspaces), so stateless
// replicas can list namespaces — including empty ones — without a filesystem.
const nsRegistryKey = "mdnest:namespaces"

func (r *RedisWorkingSet) Get(ctx context.Context, ns, relPath string) ([]byte, bool, error) {
	data, err := r.client.Get(ctx, noteKey(ns, relPath)).Bytes()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

func (r *RedisWorkingSet) Set(ctx context.Context, ns, relPath string, data []byte) error {
	pipe := r.client.TxPipeline()
	pipe.Set(ctx, noteKey(ns, relPath), data, 0)
	pipe.SAdd(ctx, nsIndexKey(ns), relPath)
	pipe.SAdd(ctx, nsRegistryKey, ns)
	_, err := pipe.Exec(ctx)
	return err
}

func (r *RedisWorkingSet) Delete(ctx context.Context, ns, relPath string) error {
	pipe := r.client.TxPipeline()
	pipe.Del(ctx, noteKey(ns, relPath))
	pipe.SRem(ctx, nsIndexKey(ns), relPath)
	_, err := pipe.Exec(ctx)
	return err
}

func (r *RedisWorkingSet) DeletePrefix(ctx context.Context, ns, relPath string) error {
	members, err := r.client.SMembers(ctx, nsIndexKey(ns)).Result()
	if err != nil {
		return err
	}
	pipe := r.client.TxPipeline()
	matched := 0
	for _, m := range members {
		if relPath == "" || m == relPath || strings.HasPrefix(m, relPath+"/") {
			pipe.Del(ctx, noteKey(ns, m))
			pipe.SRem(ctx, nsIndexKey(ns), m)
			matched++
		}
	}
	if matched == 0 {
		return nil
	}
	_, err = pipe.Exec(ctx)
	return err
}

func (r *RedisWorkingSet) AddNamespace(ctx context.Context, ns string) error {
	return r.client.SAdd(ctx, nsRegistryKey, ns).Err()
}

func (r *RedisWorkingSet) RemoveNamespace(ctx context.Context, ns string) error {
	if err := r.DeletePrefix(ctx, ns, ""); err != nil {
		return err
	}
	pipe := r.client.TxPipeline()
	pipe.Del(ctx, nsIndexKey(ns))
	pipe.SRem(ctx, nsRegistryKey, ns)
	_, err := pipe.Exec(ctx)
	return err
}

func (r *RedisWorkingSet) Namespaces(ctx context.Context) ([]string, error) {
	return r.client.SMembers(ctx, nsRegistryKey).Result()
}

func (r *RedisWorkingSet) List(ctx context.Context, ns string) ([]string, error) {
	return r.client.SMembers(ctx, nsIndexKey(ns)).Result()
}

func (r *RedisWorkingSet) Close() error { return r.client.Close() }
