package collab

import (
	"context"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"
)

// redisChannel is the single pub/sub channel all mdnest instances share.
const redisChannel = "mdnest:collab"

// redisBackplane implements Backplane over Redis pub/sub. It is only
// constructed when REDIS_URL is configured; otherwise the hub keeps its
// default nopBackplane and behaves as a single instance.
type redisBackplane struct {
	ctx    context.Context
	client *redis.Client
	sub    *redis.PubSub
}

// newRedisBackplane connects to Redis and verifies reachability before
// returning. The url uses the standard redis:// / rediss:// form parsed by
// go-redis (host, port, db, auth, TLS all encoded there).
func newRedisBackplane(ctx context.Context, url string) (*redisBackplane, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &redisBackplane{ctx: ctx, client: client}, nil
}

// Publish marshals and sends an envelope on the shared channel. Failures are
// logged, not fatal: a transient Redis outage degrades cross-instance sync but
// never breaks local collaboration.
func (r *redisBackplane) Publish(m wireMsg) {
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	if err := r.client.Publish(r.ctx, redisChannel, data).Err(); err != nil {
		log.Printf("collab: redis publish failed: %v", err)
	}
}

// Start subscribes and delivers decoded envelopes to deliver in a background
// goroutine until the context is cancelled or Close is called.
func (r *redisBackplane) Start(deliver func(wireMsg)) {
	r.sub = r.client.Subscribe(r.ctx, redisChannel)
	go func() {
		for msg := range r.sub.Channel() {
			var m wireMsg
			if err := json.Unmarshal([]byte(msg.Payload), &m); err != nil {
				continue
			}
			deliver(m)
		}
	}()
}

// Close tears down the subscription and client.
func (r *redisBackplane) Close() error {
	if r.sub != nil {
		_ = r.sub.Close()
	}
	return r.client.Close()
}
