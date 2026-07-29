package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
)

// QueuedStorage is the app-replica backend in the HA topology (MDNEST_ROLE=app).
// The replica owns no authoritative filesystem: it reads its local git-sync'd
// clone for the cold corpus (listing, Stat, Walk, older bodies) with the shared
// Redis working set layered on top for strong read-after-write, and it never
// writes the clone — every mutation is published to the working set (immediate
// cross-replica visibility) and enqueued on the durability queue for the single
// writer to apply to the authoritative git tree.
//
// The embedded *LocalStorage supplies the read-only clone view (Stat, ReadDir,
// Walk, namespaces, range-served attachments via the promoted OpenSeek); the
// methods below override the note-body reads and every mutation.
type QueuedStorage struct {
	*LocalStorage // read-only view of the local git-sync'd clone
	ws            WorkingSet
	queue         DurabilityQueue
	maxBytes      int64
}

// NewQueuedStorage builds an app-role backend over the clone rooted at
// cloneRoot. maxBytes <= 0 uses the default working-set body cap.
func NewQueuedStorage(cloneRoot string, ws WorkingSet, queue DurabilityQueue, maxBytes int64) (*QueuedStorage, error) {
	ls, err := NewLocalStorage(cloneRoot)
	if err != nil {
		return nil, err
	}
	if maxBytes <= 0 {
		maxBytes = defaultWorkingSetMaxBytes
	}
	return &QueuedStorage{LocalStorage: ls, ws: ws, queue: queue, maxBytes: maxBytes}, nil
}

func (q *QueuedStorage) Kind() string { return "app" }

// --- reads: working set first, clone fallback (hydrating on a body miss) ---

func (q *QueuedStorage) ReadFile(ctx context.Context, ns, relPath string) ([]byte, error) {
	if data, ok, err := q.ws.Get(ctx, ns, relPath); err == nil && ok {
		return data, nil
	}
	data, err := q.LocalStorage.ReadFile(ctx, ns, relPath)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) <= q.maxBytes {
		_ = q.ws.Set(ctx, ns, relPath, data)
	}
	return data, nil
}

func (q *QueuedStorage) Open(ctx context.Context, ns, relPath string) (io.ReadCloser, error) {
	if data, ok, err := q.ws.Get(ctx, ns, relPath); err == nil && ok {
		return io.NopCloser(bytes.NewReader(data)), nil
	}
	return q.LocalStorage.Open(ctx, ns, relPath)
}

// --- mutations: publish to the working set, then enqueue for the writer ---
//
// The bytes are durable once the writer applies them; enqueue failures surface
// to the caller (unlike the best-effort working-set updates) because the queue
// is the only durability path for an app replica.

func (q *QueuedStorage) WriteFile(ctx context.Context, ns, relPath string, data []byte) error {
	q.cache(ctx, ns, relPath, data)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: ns, Path: relPath, Data: data})
}

func (q *QueuedStorage) WriteFrom(ctx context.Context, ns, relPath string, r io.Reader, size int64) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	q.cache(ctx, ns, relPath, data)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: ns, Path: relPath, Data: data})
}

func (q *QueuedStorage) Append(ctx context.Context, ns, relPath string, data []byte) error {
	cur, err := q.ReadFile(ctx, ns, relPath) // working-set first, so we append to the latest body
	if err != nil {
		if !errors.Is(err, ErrNotExist) {
			return err
		}
		cur = nil
	}
	full := make([]byte, 0, len(cur)+len(data))
	full = append(full, cur...)
	full = append(full, data...)
	q.cache(ctx, ns, relPath, full)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: ns, Path: relPath, Data: full})
}

func (q *QueuedStorage) MkdirAll(ctx context.Context, ns, relPath string) error {
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpMkdir, NS: ns, Path: relPath})
}

func (q *QueuedStorage) Remove(ctx context.Context, ns, relPath string) error {
	_ = q.ws.Delete(ctx, ns, relPath)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpRemove, NS: ns, Path: relPath})
}

func (q *QueuedStorage) RemoveAll(ctx context.Context, ns, relPath string) error {
	_ = q.ws.DeletePrefix(ctx, ns, relPath)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpRemoveAll, NS: ns, Path: relPath})
}

func (q *QueuedStorage) Rename(ctx context.Context, ns, from, to string) error {
	// Move a single cached body across immediately for read-after-write; for a
	// directory rename the destination children re-hydrate from the clone after
	// git-sync (the source keys are invalidated below either way).
	if data, ok, err := q.ws.Get(ctx, ns, from); err == nil && ok {
		_ = q.ws.Set(ctx, ns, to, data)
	}
	_ = q.ws.DeletePrefix(ctx, ns, from)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpRename, NS: ns, Path: from, To: to})
}

// cache publishes a body to the working set, dropping the key when it exceeds
// the cache cap so oversize/binary payloads are not held in Redis.
func (q *QueuedStorage) cache(ctx context.Context, ns, relPath string, data []byte) {
	if int64(len(data)) <= q.maxBytes {
		_ = q.ws.Set(ctx, ns, relPath, data)
	} else {
		_ = q.ws.Delete(ctx, ns, relPath)
	}
}
