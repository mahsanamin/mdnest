package storage

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// Leader is single-writer leader election. Campaign blocks until leadership is
// held, then keeps it renewed in the background; the returned context is
// cancelled if leadership is ever lost (e.g. a renew fails after a Redis
// partition), so the caller stops writing immediately. This makes the single
// writer a write-path SPOF-with-failover, never a read SPOF: reads are always
// served from the Redis working set regardless of who holds the lock.
type Leader interface {
	// Campaign blocks until this instance is the leader (or ctx is cancelled),
	// then returns a context that stays live only while leadership is held.
	Campaign(ctx context.Context) (context.Context, error)
	// Close releases leadership (best-effort) and the connection.
	Close() error
}

const leaderKey = "mdnest:writer:leader"

// renewCAS extends the lock only if we still own it (compare-and-set on the
// value), so a writer that lost the lock during a partition never clobbers the
// new leader.
var renewCAS = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("pexpire", KEYS[1], ARGV[2])
else
	return 0
end`)

// releaseCAS deletes the lock only if we still own it.
var releaseCAS = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("del", KEYS[1])
else
	return 0
end`)

// RedisLeader implements Leader with a single Redis key held via SET NX PX and
// renewed at ttl/2.
type RedisLeader struct {
	client *redis.Client
	id     string
	ttl    time.Duration
}

// NewRedisLeader connects to Redis. id must be unique per instance (typically
// the pod name); ttl bounds how long a crashed leader blocks failover.
func NewRedisLeader(ctx context.Context, url, id string, ttl time.Duration) (*RedisLeader, error) {
	if ttl <= 0 {
		ttl = 15 * time.Second
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &RedisLeader{client: client, id: id, ttl: ttl}, nil
}

func (l *RedisLeader) Campaign(ctx context.Context) (context.Context, error) {
	for {
		ok, err := l.client.SetNX(ctx, leaderKey, l.id, l.ttl).Result()
		if err != nil {
			return nil, err
		}
		if ok {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(l.ttl / 2):
		}
	}
	lctx, cancel := context.WithCancel(ctx)
	go l.keep(lctx, cancel)
	return lctx, nil
}

// keep renews the lock at ttl/2; on a failed/lost renewal it cancels the leader
// context so the writer stops.
func (l *RedisLeader) keep(ctx context.Context, cancel context.CancelFunc) {
	t := time.NewTicker(l.ttl / 2)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			// Release only if we still own it (parent cancelled / shutdown).
			rel, c := context.WithTimeout(context.Background(), 2*time.Second)
			_ = releaseCAS.Run(rel, l.client, []string{leaderKey}, l.id).Err()
			c()
			return
		case <-t.C:
			held, err := renewCAS.Run(ctx, l.client, []string{leaderKey}, l.id, l.ttl.Milliseconds()).Int()
			if err != nil || held == 0 {
				cancel() // lost leadership; stop writing
				return
			}
		}
	}
}

func (l *RedisLeader) Close() error { return l.client.Close() }
