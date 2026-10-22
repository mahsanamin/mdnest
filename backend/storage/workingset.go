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
	// SetIfAbsent stores data only when (ns, relPath) has no cached body. The
	// writer hydrates with it: a body an app replica already changed is newer
	// than the disk copy while its op is still queued.
	SetIfAbsent(ctx context.Context, ns, relPath string, data []byte) error
	// CompareAndSet stores data only while the cached body is still old or
	// missing, atomically, and reports whether it did. The writer publishes
	// what landed on disk with it, so an older op never overwrites a newer
	// append that an app replica has already put there.
	CompareAndSet(ctx context.Context, ns, relPath string, old, data []byte) (bool, error)
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

func (r *RedisWorkingSet) SetIfAbsent(ctx context.Context, ns, relPath string, data []byte) error {
	pipe := r.client.TxPipeline()
	pipe.SetNX(ctx, noteKey(ns, relPath), data, 0)
	pipe.SAdd(ctx, nsIndexKey(ns), relPath)
	pipe.SAdd(ctx, nsRegistryKey, ns)
	_, err := pipe.Exec(ctx)
	return err
}

// casBody sets KEYS[1] to ARGV[2] only while it is missing or still equals
// ARGV[1], and indexes it (KEYS[2] the namespace's paths, KEYS[3] the
// namespace registry; ARGV[3] the path, ARGV[4] the namespace).
var casBody = redis.NewScript(`
local cur = redis.call("get", KEYS[1])
if cur == false or cur == ARGV[1] then
	redis.call("set", KEYS[1], ARGV[2])
	redis.call("sadd", KEYS[2], ARGV[3])
	redis.call("sadd", KEYS[3], ARGV[4])
	return 1
end
return 0`)

func (r *RedisWorkingSet) CompareAndSet(ctx context.Context, ns, relPath string, old, data []byte) (bool, error) {
	n, err := casBody.Run(ctx, r.client, []string{noteKey(ns, relPath), nsIndexKey(ns), nsRegistryKey},
		old, data, relPath, ns).Int()
	return n == 1, err
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
