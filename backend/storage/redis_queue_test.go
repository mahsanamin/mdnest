package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// These tests need a real Redis and are skipped without one:
//
//	MDNEST_TEST_REDIS_URL=redis://localhost:6379/15 go test ./storage -run Redis
//
// They FLUSH that database and change its maxmemory, so point them at a
// throwaway Redis, never a shared one. They pin issue #147: applied entries
// must leave the durability stream, and a writer that loses leadership must
// win it back.

func testRedis(t *testing.T) (*redis.Client, string) {
	t.Helper()
	url := os.Getenv("MDNEST_TEST_REDIS_URL")
	if url == "" {
		t.Skip("MDNEST_TEST_REDIS_URL not set")
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	c := redis.NewClient(opt)
	ctx := context.Background()
	if err := c.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	t.Cleanup(func() {
		c.ConfigSet(context.Background(), "maxmemory", "0")
		c.FlushDB(context.Background())
		c.Close()
	})
	return c, url
}

func waitFor(t *testing.T, what string, d time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func streamLen(c *redis.Client) int64 {
	n, _ := c.XLen(context.Background(), durabilityStream).Result()
	return n
}

// countingApply records every applied path and fails the ones in fail.
type countingApply struct {
	mu      sync.Mutex
	applied []string
	fail    map[string]bool
}

func (a *countingApply) apply(_ context.Context, op DurabilityOp) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.fail[op.Path] {
		return errors.New("apply failed")
	}
	a.applied = append(a.applied, op.Path)
	return nil
}

func (a *countingApply) count() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.applied)
}

func consumeInBackground(t *testing.T, q *RedisStreamQueue, apply func(context.Context, DurabilityOp) error) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = q.Consume(ctx, apply); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return cancel
}

func TestRedisQueueDeletesAppliedEntries(t *testing.T) {
	c, url := testRedis(t)
	ctx := context.Background()
	q, err := NewRedisStreamQueue(ctx, url, "w1")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()

	body := []byte(strings.Repeat("x", 64<<10)) // a chat-sized body per entry
	for i := 0; i < 30; i++ {
		p := fmt.Sprintf("n%02d.md", i)
		if i == 5 {
			p = "fail.md"
		}
		if err := q.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: p, Data: body}); err != nil {
			t.Fatal(err)
		}
	}
	a := &countingApply{fail: map[string]bool{"fail.md": true}}
	cancel := consumeInBackground(t, q, a.apply)
	waitFor(t, "29 applied", 10*time.Second, func() bool { return a.count() == 29 })
	// Only the failing entry may stay; it must not hold the 24 after it.
	waitFor(t, "stream down to the failing entry", 5*time.Second, func() bool { return streamLen(c) == 1 })
	cancel()

	// A later term reclaims the failed entry; once it applies, nothing is left.
	a2 := &countingApply{}
	consumeInBackground(t, q, a2.apply)
	waitFor(t, "failed entry reapplied", 10*time.Second, func() bool { return a2.count() == 1 })
	waitFor(t, "empty stream", 5*time.Second, func() bool { return streamLen(c) == 0 })
	if a2.applied[0] != "fail.md" {
		t.Fatalf("reclaimed %q, want fail.md", a2.applied[0])
	}
}

// A stream left behind by an older version holds acked entries that were never
// deleted. The new writer must clear them without applying them again, and
// still apply what was pending or never delivered.
func TestRedisQueueTrimsBacklogFromOlderVersion(t *testing.T) {
	c, url := testRedis(t)
	ctx := context.Background()
	q, err := NewRedisStreamQueue(ctx, url, "old")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	for i := 0; i < 20; i++ {
		q.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: fmt.Sprintf("old%02d.md", i), Data: []byte("b")})
	}
	// What the old writer did: read, ack, never delete. The last one is left
	// pending, as after a crash mid-apply.
	res, err := c.XReadGroup(ctx, &redis.XReadGroupArgs{Group: durabilityGroup, Consumer: "old", Streams: []string{durabilityStream, ">"}, Count: 20}).Result()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range res[0].Messages[:19] {
		c.XAck(ctx, durabilityStream, durabilityGroup, m.ID)
	}
	for i := 0; i < 5; i++ {
		q.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: fmt.Sprintf("new%d.md", i), Data: []byte("b")})
	}
	if n := streamLen(c); n != 25 {
		t.Fatalf("setup: stream has %d entries, want 25", n)
	}

	q2, err := NewRedisStreamQueue(ctx, url, "new")
	if err != nil {
		t.Fatal(err)
	}
	defer q2.Close()
	a := &countingApply{}
	consumeInBackground(t, q2, a.apply)
	waitFor(t, "6 applied", 10*time.Second, func() bool { return a.count() == 6 })
	waitFor(t, "empty stream", 5*time.Second, func() bool { return streamLen(c) == 0 })
	time.Sleep(200 * time.Millisecond)
	if n := a.count(); n != 6 {
		t.Fatalf("applied %d ops, want 6 (19 acked ones must not run again): %v", n, a.applied)
	}
	for _, p := range a.applied {
		if strings.HasPrefix(p, "old") && p != "old19.md" {
			t.Fatalf("an already-applied entry ran again: %s", p)
		}
	}
}

// Trimming while app replicas keep enqueuing must never drop an entry that
// has not been applied.
func TestRedisQueueConcurrentEnqueueLosesNothing(t *testing.T) {
	c, url := testRedis(t)
	ctx := context.Background()
	q, err := NewRedisStreamQueue(ctx, url, "w1")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	a := &countingApply{}
	consumeInBackground(t, q, a.apply)

	const producers, each = 4, 250
	var wg sync.WaitGroup
	for p := 0; p < producers; p++ {
		wg.Add(1)
		go func(p int) {
			defer wg.Done()
			app, err := NewRedisStreamQueue(ctx, url, fmt.Sprintf("app%d", p))
			if err != nil {
				t.Error(err)
				return
			}
			defer app.Close()
			for i := 0; i < each; i++ {
				if err := app.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: fmt.Sprintf("p%d-%d.md", p, i), Data: []byte("b")}); err != nil {
					t.Error(err)
					return
				}
			}
		}(p)
	}
	wg.Wait()
	waitFor(t, "every op applied", 20*time.Second, func() bool { return a.count() == producers*each })
	waitFor(t, "empty stream", 5*time.Second, func() bool { return streamLen(c) == 0 })
	seen := map[string]bool{}
	for _, p := range a.applied {
		seen[p] = true
	}
	if len(seen) != producers*each {
		t.Fatalf("%d distinct ops applied, want %d", len(seen), producers*each)
	}
}

// The outage in issue #147: Redis reaches maxmemory, the leader renew is
// refused, the writer loses leadership. Once memory is back, the same writer
// process must campaign again and apply new saves, with no restart.
func TestWriterCampaignsAgainAfterRedisOOM(t *testing.T) {
	c, url := testRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	oldMin, oldMax := writerRetryMin, writerRetryMax
	writerRetryMin, writerRetryMax = 50*time.Millisecond, 200*time.Millisecond
	defer func() { writerRetryMin, writerRetryMax = oldMin, oldMax }()

	q, err := NewRedisStreamQueue(ctx, url, "writer-0")
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	leader, err := NewRedisLeader(ctx, url, "writer-0", 300*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer leader.Close()
	root := t.TempDir()
	gs, err := NewGitStorage(root, NoopCommitter{})
	if err != nil {
		t.Fatal(err)
	}
	w := NewWriter(gs, newFakeWorkingSet(), q, leader, defaultWorkingSetMaxBytes)
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()

	onDisk := func(p string) func() bool {
		return func() bool { _, err := os.Stat(filepath.Join(root, "team", p)); return err == nil }
	}
	if err := q.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: "before.md", Data: []byte("1")}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "first write applied", 10*time.Second, onDisk("before.md"))

	// Leadership lost (another owner holds the lock for a moment), and Redis
	// full: saves are refused, as users saw, and so is every campaign.
	if err := c.Set(ctx, leaderKey, "someone-else", 800*time.Millisecond).Err(); err != nil {
		t.Fatal(err)
	}
	if err := c.ConfigSet(ctx, "maxmemory", "1").Err(); err != nil {
		t.Fatal(err)
	}
	err = q.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: "refused.md", Data: []byte("x")})
	if err == nil || !strings.Contains(err.Error(), "OOM") {
		t.Fatalf("enqueue under maxmemory: err = %v, want an OOM refusal", err)
	}
	if err := c.SetNX(ctx, leaderKey+":probe", "x", time.Second).Err(); err == nil || !strings.Contains(err.Error(), "OOM") {
		t.Fatalf("a campaign under maxmemory must be refused, got %v", err)
	}
	time.Sleep(1500 * time.Millisecond) // the other lock expires meanwhile
	if err := c.ConfigSet(ctx, "maxmemory", "0").Err(); err != nil {
		t.Fatal(err)
	}

	// The same process must win the lock back without a restart.
	waitFor(t, "the writer to hold the lock again", 15*time.Second, func() bool {
		v, _ := c.Get(ctx, leaderKey).Result()
		return v == "writer-0"
	})
	if err := q.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: "after.md", Data: []byte("2")}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a write after the outage applied by the same writer", 15*time.Second, onDisk("after.md"))

	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second): // XREADGROUP blocks up to 5s
		t.Fatal("Run did not return after ctx was cancelled")
	}
}

// CompareAndSet is what keeps the writer from putting an older body over a
// newer append: it may fill a missing body or replace its own, never another.
func TestRedisWorkingSetCompareAndSet(t *testing.T) {
	_, url := testRedis(t)
	ctx := context.Background()
	ws, err := NewRedisWorkingSet(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	get := func() string { b, _, _ := ws.Get(ctx, "team", "chat.md"); return string(b) }

	if ok, err := ws.CompareAndSet(ctx, "team", "chat.md", []byte("old"), []byte("landed")); err != nil || !ok || get() != "landed" {
		t.Fatalf("missing body: ok=%v err=%v body=%q, want it filled", ok, err, get())
	}
	if paths, _ := ws.List(ctx, "team"); len(paths) != 1 || paths[0] != "chat.md" {
		t.Fatalf("a filled body must be indexed, got %v", paths)
	}
	if ok, _ := ws.CompareAndSet(ctx, "team", "chat.md", []byte("landed"), []byte("landed2")); !ok || get() != "landed2" {
		t.Fatalf("own body: ok=%v body=%q, want replaced", ok, get())
	}
	_ = ws.Set(ctx, "team", "chat.md", []byte("newer append"))
	if ok, _ := ws.CompareAndSet(ctx, "team", "chat.md", []byte("landed2"), []byte("stale")); ok || get() != "newer append" {
		t.Fatalf("newer body: ok=%v body=%q, want it kept", ok, get())
	}
	if err := ws.SetIfAbsent(ctx, "team", "chat.md", []byte("disk copy")); err != nil || get() != "newer append" {
		t.Fatalf("SetIfAbsent replaced an existing body: %q", get())
	}
}
