package storage

import (
	"context"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// OpKind identifies a mutation carried on the durability queue.
type OpKind string

const (
	OpWrite     OpKind = "write"
	OpRemove    OpKind = "remove"
	OpRemoveAll OpKind = "removeAll"
	OpRename    OpKind = "rename"
	OpMkdir     OpKind = "mkdir"
)

// DurabilityOp is a single mutation to be applied to the durable git tree by
// the out-of-process writer. In the HA topology the app replicas own no
// filesystem: they publish note bodies to the Redis working set (immediate
// cross-replica reads) and enqueue a DurabilityOp so the single writer applies
// it to git. The write payload is carried inline so the writer needs no shared
// filesystem with the replicas.
type DurabilityOp struct {
	Seq  string // queue-assigned id (stream entry ID); empty when enqueuing
	Kind OpKind
	NS   string
	Path string
	To   string // rename destination (OpRename only)
	Data []byte // payload (OpWrite only)
}

// DurabilityQueue is the ordered, at-least-once handoff from app replicas to the
// single writer. Enqueue is called on the app side; Consume runs on the writer
// (the leader) and applies each op exactly once per successful ack.
type DurabilityQueue interface {
	// Enqueue appends an op to the durable queue.
	Enqueue(ctx context.Context, op DurabilityOp) error
	// Consume blocks, delivering ops to apply until ctx is cancelled. An op is
	// acknowledged only after apply returns nil; a failed apply is left pending
	// for redelivery (at-least-once). apply must therefore be idempotent — the
	// git mutators are (a rewrite/remove/rename converges to the same tree).
	Consume(ctx context.Context, apply func(context.Context, DurabilityOp) error) error
	// Close releases the underlying connection.
	Close() error
}

const (
	durabilityStream = "mdnest:durability"
	durabilityGroup  = "mdnest-writers"
)

// encodeOp renders an op as Redis stream fields. Empty optional fields are
// omitted; Data is stored as-is (Redis values are binary-safe).
func encodeOp(op DurabilityOp) map[string]any {
	m := map[string]any{
		"kind": string(op.Kind),
		"ns":   op.NS,
		"path": op.Path,
	}
	if op.To != "" {
		m["to"] = op.To
	}
	if op.Data != nil {
		m["data"] = op.Data
	}
	return m
}

// decodeOp reconstructs an op from a stream entry id and its fields. Field
// values come back from go-redis as strings (binary-safe).
func decodeOp(id string, values map[string]any) DurabilityOp {
	get := func(k string) string {
		if v, ok := values[k]; ok {
			if s, ok := v.(string); ok {
				return s
			}
		}
		return ""
	}
	op := DurabilityOp{
		Seq:  id,
		Kind: OpKind(get("kind")),
		NS:   get("ns"),
		Path: get("path"),
		To:   get("to"),
	}
	if v, ok := values["data"]; ok {
		switch d := v.(type) {
		case string:
			op.Data = []byte(d)
		case []byte:
			op.Data = d
		}
	}
	return op
}

// RedisStreamQueue implements DurabilityQueue over a Redis stream with a single
// consumer group. Ordering and at-least-once delivery come from the stream;
// pending entries from a crashed writer are reclaimed on start via XAUTOCLAIM so
// a failover writer resumes the previous writer's unacked backlog.
type RedisStreamQueue struct {
	client   *redis.Client
	consumer string
}

// NewRedisStreamQueue connects to Redis, ensures the consumer group exists, and
// returns a queue bound to the given consumer name (typically the pod name).
func NewRedisStreamQueue(ctx context.Context, url, consumer string) (*RedisStreamQueue, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	// MKSTREAM creates the stream lazily; BUSYGROUP means it already exists.
	if err := client.XGroupCreateMkStream(ctx, durabilityStream, durabilityGroup, "0").Err(); err != nil &&
		!strings.Contains(err.Error(), "BUSYGROUP") {
		_ = client.Close()
		return nil, err
	}
	if consumer == "" {
		consumer = "writer"
	}
	return &RedisStreamQueue{client: client, consumer: consumer}, nil
}

func (q *RedisStreamQueue) Enqueue(ctx context.Context, op DurabilityOp) error {
	return q.client.XAdd(ctx, &redis.XAddArgs{
		Stream: durabilityStream,
		Values: encodeOp(op),
	}).Err()
}

func (q *RedisStreamQueue) Consume(ctx context.Context, apply func(context.Context, DurabilityOp) error) error {
	// Reclaim any entries left pending by a previous (crashed) writer so a
	// failover writer drains the backlog before new work.
	if err := q.reclaimPending(ctx, apply); err != nil && ctx.Err() == nil {
		return err
	}
	q.trimApplied(ctx)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		res, err := q.client.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    durabilityGroup,
			Consumer: q.consumer,
			Streams:  []string{durabilityStream, ">"},
			Count:    64,
			Block:    5 * time.Second,
		}).Result()
		if err == redis.Nil {
			continue // block timed out with no new entries
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		for _, s := range res {
			for _, msg := range s.Messages {
				// go-redis does not cancel a blocked read with ctx, so the
				// read can return after leadership was lost. Leave the rest
				// pending for the next leader rather than apply it here.
				if ctx.Err() != nil {
					return ctx.Err()
				}
				q.applyAndAck(ctx, apply, decodeOp(msg.ID, msg.Values))
			}
		}
		q.trimApplied(ctx)
	}
}

// reclaimPending steals pending entries idle for 0ms from any consumer in the
// group (there is only ever one live writer thanks to the leader lock) and
// applies them.
func (q *RedisStreamQueue) reclaimPending(ctx context.Context, apply func(context.Context, DurabilityOp) error) error {
	start := "0-0"
	for {
		msgs, next, err := q.client.XAutoClaim(ctx, &redis.XAutoClaimArgs{
			Stream:   durabilityStream,
			Group:    durabilityGroup,
			Consumer: q.consumer,
			MinIdle:  0,
			Start:    start,
			Count:    64,
		}).Result()
		if err != nil {
			return err
		}
		for _, msg := range msgs {
			q.applyAndAck(ctx, apply, decodeOp(msg.ID, msg.Values))
		}
		if next == "0-0" || len(msgs) == 0 {
			return nil
		}
		start = next
	}
}

// applyAndAck applies one op, then acknowledges and deletes it. A failed apply
// is left pending for a later redelivery.
//
// The entry is deleted, not only acked: an acked entry stays in the stream
// with its whole payload (a full note body), and before v4.8.11 nothing ever
// removed one, so the stream grew until Redis hit maxmemory and refused every
// write (issue #147). Deleting by id removes exactly the entry that was just
// applied, so a failing op further back never holds later ones in memory.
func (q *RedisStreamQueue) applyAndAck(ctx context.Context, apply func(context.Context, DurabilityOp) error, op DurabilityOp) {
	if err := apply(ctx, op); err != nil {
		return // leave unacked; XAUTOCLAIM/redelivery retries it
	}
	if err := q.client.XAck(ctx, durabilityStream, durabilityGroup, op.Seq).Err(); err != nil {
		return // still pending: redelivered later, and apply is idempotent
	}
	q.client.XDel(ctx, durabilityStream, op.Seq)
}

// trimApplied removes every entry older than anything the writer still needs:
// the oldest pending entry if there is one, otherwise everything up to the
// last one delivered to the group. It clears entries acked by a version that
// did not delete them, and any entry whose XDEL failed.
//
// The group's last-delivered id is read BEFORE the pending list. An entry
// delivered in between is either still pending (and so above the trim point)
// or already acked, so the order never trims an entry that has not been
// applied. Entries added by app replicas meanwhile get newer ids and are never
// below the trim point.
func (q *RedisStreamQueue) trimApplied(ctx context.Context) {
	groups, err := q.client.XInfoGroups(ctx, durabilityStream).Result()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("storage: durability stream trim skipped: %v", err)
		}
		return
	}
	last := ""
	for _, g := range groups {
		if g.Name == durabilityGroup {
			last = g.LastDeliveredID
		}
	}
	minID, ok := nextStreamID(last)
	if !ok {
		return // nothing delivered yet
	}
	pending, err := q.client.XPending(ctx, durabilityStream, durabilityGroup).Result()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("storage: durability stream trim skipped: %v", err)
		}
		return
	}
	if pending.Count > 0 && pending.Lower != "" {
		minID = pending.Lower
	}
	if err := q.client.XTrimMinID(ctx, durabilityStream, minID).Err(); err != nil && ctx.Err() == nil {
		log.Printf("storage: durability stream trim failed: %v", err)
	}
}

// nextStreamID returns the smallest stream id after id ("5-3" -> "5-4"), so
// XTRIM MINID with it keeps nothing at or below id. It reports false for an
// empty or zero id (nothing delivered) and for anything it cannot parse.
func nextStreamID(id string) (string, bool) {
	ms, seq, found := strings.Cut(id, "-")
	if !found {
		return "", false
	}
	m, err1 := strconv.ParseUint(ms, 10, 64)
	n, err2 := strconv.ParseUint(seq, 10, 64)
	if err1 != nil || err2 != nil || (m == 0 && n == 0) {
		return "", false
	}
	if n == ^uint64(0) {
		return strconv.FormatUint(m+1, 10) + "-0", true
	}
	return ms + "-" + strconv.FormatUint(n+1, 10), true
}

func (q *RedisStreamQueue) Close() error { return q.client.Close() }
