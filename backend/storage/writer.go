package storage

import (
	"context"
	"log"
)

// Writer is the out-of-process single writer. It owns the durable git tree
// (dst) and is the only process that mutates it: it wins leadership, hydrates
// the Redis working set from the tree so app replicas can serve every read from
// Redis, then drains the durability queue, applying each op to git and
// reflecting the result back into the working set.
//
// This replaces the in-process committer's role in the HA topology: app
// replicas no longer touch a filesystem, they enqueue ops and read from Redis.
// The single-box path (no Redis) keeps the in-process GitStorage committer and
// never constructs a Writer.
type Writer struct {
	dst      Storage         // durable tree (GitStorage) — only this process writes it
	ws       WorkingSet      // shared coherence tier reflected on apply + hydrate
	queue    DurabilityQueue // handoff from app replicas
	leader   Leader          // single-writer election
	maxBytes int64           // working-set body cap (mirrors CoherentStorage)
}

// NewWriter assembles a writer. maxBytes <= 0 uses the default working-set cap.
func NewWriter(dst Storage, ws WorkingSet, queue DurabilityQueue, leader Leader, maxBytes int64) *Writer {
	if maxBytes <= 0 {
		maxBytes = defaultWorkingSetMaxBytes
	}
	return &Writer{dst: dst, ws: ws, queue: queue, leader: leader, maxBytes: maxBytes}
}

// Run campaigns for leadership, hydrates the working set, then consumes the
// durability queue until the leader context is cancelled (leadership lost or
// ctx cancelled). It returns the terminating error, if any.
func (w *Writer) Run(ctx context.Context) error {
	lctx, err := w.leader.Campaign(ctx)
	if err != nil {
		return err
	}
	log.Println("storage: became durability writer (leader)")
	if err := w.hydrate(lctx); err != nil {
		log.Printf("storage: writer hydrate warning: %v", err)
	}
	return w.queue.Consume(lctx, w.apply)
}

// hydrate loads every cached-eligible note body from the durable tree into the
// working set so replicas reading from Redis see the full corpus. Bodies over
// the cap are left out (served from the tree via the writer proxy in a later
// increment).
func (w *Writer) hydrate(ctx context.Context) error {
	namespaces, err := w.dst.ListNamespaces(ctx)
	if err != nil {
		return err
	}
	for _, ns := range namespaces {
		_ = w.ws.AddNamespace(ctx, ns) // list even empty namespaces
		err := w.dst.Walk(ctx, ns, "", func(relPath string, info FileInfo) error {
			if info.IsDir || info.Size > w.maxBytes {
				return nil
			}
			data, rerr := w.dst.ReadFile(ctx, ns, relPath)
			if rerr != nil {
				return nil // skip unreadable entries, keep hydrating
			}
			_ = w.ws.Set(ctx, ns, relPath, data)
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// apply applies one durability op to the git tree and reflects the outcome into
// the working set. It is idempotent so an at-least-once redelivery converges.
func (w *Writer) apply(ctx context.Context, op DurabilityOp) error {
	switch op.Kind {
	case OpWrite:
		if err := w.dst.MkdirAll(ctx, op.NS, ""); err != nil {
			return err
		}
		if err := w.dst.WriteFile(ctx, op.NS, op.Path, op.Data); err != nil {
			return err
		}
		// The git backend may reconcile a note's mdnest marker on write, so
		// cache what actually landed rather than the queued bytes; otherwise
		// replicas would serve the pre-reconcile content from the working set.
		if b, rerr := w.dst.ReadFile(ctx, op.NS, op.Path); rerr == nil {
			cacheBody(ctx, w.ws, op.NS, op.Path, b, w.maxBytes)
		} else {
			cacheBody(ctx, w.ws, op.NS, op.Path, op.Data, w.maxBytes)
		}
	case OpMkdir:
		if err := w.dst.MkdirAll(ctx, op.NS, op.Path); err != nil {
			return err
		}
		_ = w.ws.AddNamespace(ctx, op.NS)
	case OpRemove:
		if err := w.dst.Remove(ctx, op.NS, op.Path); err != nil && err != ErrNotExist {
			return err
		}
		_ = w.ws.Delete(ctx, op.NS, op.Path)
	case OpRemoveAll:
		if err := w.dst.RemoveAll(ctx, op.NS, op.Path); err != nil {
			return err
		}
		if op.Path == "" {
			_ = w.ws.RemoveNamespace(ctx, op.NS)
		} else {
			_ = w.ws.DeletePrefix(ctx, op.NS, op.Path)
		}
	case OpRename:
		if err := w.dst.MkdirAll(ctx, op.NS, ""); err != nil {
			return err
		}
		if err := w.dst.Rename(ctx, op.NS, op.Path, op.To); err != nil && err != ErrNotExist {
			return err
		}
		_ = w.ws.DeletePrefix(ctx, op.NS, op.Path)
		_ = w.ws.DeletePrefix(ctx, op.NS, op.To)
	default:
		// Unknown op: ack it (return nil) so a poison entry does not wedge the
		// queue; the durable tree is unchanged.
		log.Printf("storage: writer skipping unknown op kind %q", op.Kind)
	}
	return nil
}
