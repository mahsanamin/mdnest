package storage

import (
	"context"
	"log"
	"path"
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
			// App replicas cannot resolve a link, so a linked path is not
			// served from the working set at all (see LinkResolver).
			if linkedPath(ctx, w.dst, ns, relPath) {
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
	// Reserved system namespaces (e.g. the hidden Marp theme catalog) are
	// excluded from ListNamespaces, so hydrate them explicitly — otherwise
	// app-role replicas, which read only from the coherence tier, would never
	// see them. A missing directory (nothing seeded yet) is not an error.
	for _, ns := range SystemNamespaces {
		_ = w.dst.Walk(ctx, ns, "", func(relPath string, info FileInfo) error {
			if info.IsDir || info.Size > w.maxBytes {
				return nil
			}
			if data, rerr := w.dst.ReadFile(ctx, ns, relPath); rerr == nil {
				_ = w.ws.Set(ctx, ns, relPath, data)
			}
			return nil
		})
	}
	return nil
}

// apply applies one durability op to the git tree and reflects the outcome into
// the working set. It is idempotent so an at-least-once redelivery converges.
func (w *Writer) apply(ctx context.Context, op DurabilityOp) error {
	// The app replica that accepted this op authorised the paths it was
	// given and cannot see links. An op whose path runs through a linked
	// folder would land wherever that link points, which the grant may not
	// cover: refuse it (ack, so the queue keeps moving). A link as the final
	// component of a remove or rename is fine — that acts on the link itself.
	if linkedOp(ctx, w.dst, op) {
		log.Printf("storage: writer refused a %s through a symlink: %s:%s", op.Kind, op.NS, op.Path)
		_ = w.ws.Delete(ctx, op.NS, op.Path)
		return nil
	}
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
		// The source is gone; drop its cached entries. The destination must be
		// re-hydrated from the durable tree, not deleted: app replicas read only
		// from the working set, so dropping the destination stranded the moved
		// body (and, for a directory, its whole subtree) and made every read of
		// it 404 until the next full hydrate.
		_ = w.ws.DeletePrefix(ctx, op.NS, op.Path)
		_ = w.ws.DeletePrefix(ctx, op.NS, op.To)
		w.recacheDest(ctx, op.NS, op.To)
	default:
		// Unknown op: ack it (return nil) so a poison entry does not wedge the
		// queue; the durable tree is unchanged.
		log.Printf("storage: writer skipping unknown op kind %q", op.Kind)
	}
	return nil
}

// recacheDest reflects a rename destination back into the working set from the
// durable tree, mirroring hydrate's caching rules. It handles both a single
// file and a moved directory subtree so app replicas (which read only from the
// working set) can see the destination immediately after a rename.
func (w *Writer) recacheDest(ctx context.Context, ns, path string) {
	if linkedPath(ctx, w.dst, ns, path) {
		return
	}
	if data, err := w.dst.ReadFile(ctx, ns, path); err == nil {
		cacheBody(ctx, w.ws, ns, path, data, w.maxBytes)
		return
	}
	// Not a file (directory, or gone): re-hydrate every moved file under it.
	_ = w.dst.Walk(ctx, ns, path, func(relPath string, info FileInfo) error {
		if info.IsDir || info.Size > w.maxBytes || linkedPath(ctx, w.dst, ns, relPath) {
			return nil
		}
		if data, rerr := w.dst.ReadFile(ctx, ns, relPath); rerr == nil {
			cacheBody(ctx, w.ws, ns, relPath, data, w.maxBytes)
		}
		return nil
	})
}

// linkedOp reports whether op reaches anything through a symbolic link (see
// Writer.apply). Writes and mkdirs are judged on the whole path; removes and
// renames on the parent folders, since they act on a final-component link
// itself rather than on its target.
func linkedOp(ctx context.Context, dst Storage, op DurabilityOp) bool {
	parentLinked := func(p string) bool {
		dir := path.Dir(p)
		return dir != "." && dir != "/" && linkedPath(ctx, dst, op.NS, dir)
	}
	switch op.Kind {
	case OpWrite, OpMkdir:
		return op.Path != "" && linkedPath(ctx, dst, op.NS, op.Path)
	case OpRemove, OpRemoveAll:
		return op.Path != "" && parentLinked(op.Path)
	case OpRename:
		return parentLinked(op.Path) || parentLinked(op.To)
	}
	return false
}
