package storage

import (
	"context"
	"io"
)

// defaultWorkingSetMaxBytes caps the size of a body cached in the Redis working
// set. Note bodies are small Markdown text and fit comfortably; anything larger
// (an accidental big file, a binary) is not cached — reads for it fall through
// to the inner Storage. Overridable via REDIS_WORKINGSET_MAX_BYTES.
const defaultWorkingSetMaxBytes = 1 << 20 // 1 MiB

// cacheBody publishes a note body to the working set, dropping the key when it
// exceeds the cap so oversize/binary payloads are not held in Redis. Best-effort:
// working-set failures never fail the durable write that preceded them.
func cacheBody(ctx context.Context, ws WorkingSet, ns, relPath string, data []byte, maxBytes int64) {
	if int64(len(data)) <= maxBytes {
		_ = ws.Set(ctx, ns, relPath, data)
	} else {
		_ = ws.Delete(ctx, ns, relPath)
	}
}

// makeReflector builds a reconcileFn that reflects notes changed by a git pull
// into the working set: changed paths are re-read from the durable tree and
// cached, removed paths are dropped, and the namespace is (re)registered. Used
// by the writer and the single-box coherent path so notes edited directly on a
// remote reach stateless replicas and the UI.
func makeReflector(inner Storage, ws WorkingSet, maxBytes int64) reconcileFn {
	return func(ctx context.Context, ns string, changed, removed []string) {
		for _, p := range removed {
			_ = ws.Delete(ctx, ns, p)
		}
		for _, p := range changed {
			data, err := inner.ReadFile(ctx, ns, p)
			if err != nil {
				continue
			}
			cacheBody(ctx, ws, ns, p, data, maxBytes)
		}
		_ = ws.AddNamespace(ctx, ns)
	}
}

// CoherentStorage layers a shared WorkingSet (Redis) over an inner Storage to
// give strong read-after-write of note bodies across replicas. Every mutation
// is written through to the inner Storage first (that remains the durability
// and history layer — the filesystem/git backend); the working set is updated
// only after the durable write returns. Reads consult the working set first and
// hydrate it on a miss.
//
// Scope of this tier (the "Redis working-set" increment): it covers the note
// body read/write path used by the editor — ReadFile / WriteFile / WriteFrom /
// Append / Remove / RemoveAll / Rename. Streaming reads (Open, used by search),
// metadata (Stat / ReadDir / Walk) and range-served attachments (OpenSeek) are
// delegated unchanged to the inner Storage: they are correct as long as the
// inner tree is shared or single-box, and gain cross-replica coherence in the
// later single-writer / attachments increments. When no Redis is configured the
// factory does not construct this type at all, so behaviour falls back to the
// inner Storage.
type CoherentStorage struct {
	Storage  // inner backend; promotes Stat/ReadDir/Walk/MkdirAll/namespaces/Kind
	ws       WorkingSet
	maxBytes int64
}

// newCoherentStorage wraps inner with a working set. When inner can serve range
// requests (RangeReadable, e.g. local/git) the returned value preserves that
// capability so attachment range/conditional-GET serving keeps working.
func newCoherentStorage(inner Storage, ws WorkingSet, maxBytes int64) Storage {
	if maxBytes <= 0 {
		maxBytes = defaultWorkingSetMaxBytes
	}
	c := &CoherentStorage{Storage: inner, ws: ws, maxBytes: maxBytes}
	if _, ok := inner.(RangeReadable); ok {
		return &coherentRangeStorage{c}
	}
	return c
}

// SetSyncStatusSink forwards a sync-status sink to the inner git storage so the
// writer reports per-namespace mirror outcomes. No-op when the inner backend
// does not support it. Promoted to coherentRangeStorage via embedding.
func (c *CoherentStorage) SetSyncStatusSink(s SyncStatusSink) {
	if g, ok := c.Storage.(interface{ SetSyncStatusSink(SyncStatusSink) }); ok {
		g.SetSyncStatusSink(s)
	}
}

// Close tears down the inner backend (if it is a Closer, e.g. GitStorage stops
// its committer) and the working set connection.
func (c *CoherentStorage) Close() error {
	var err error
	if cl, ok := c.Storage.(io.Closer); ok {
		err = cl.Close()
	}
	if e := c.ws.Close(); e != nil && err == nil {
		err = e
	}
	return err
}

// --- reads: working set first, hydrate on miss ---

func (c *CoherentStorage) ReadFile(ctx context.Context, ns, relPath string) ([]byte, error) {
	if data, ok, err := c.ws.Get(ctx, ns, relPath); err == nil && ok {
		return data, nil
	}
	data, err := c.Storage.ReadFile(ctx, ns, relPath)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) <= c.maxBytes {
		_ = c.ws.Set(ctx, ns, relPath, data)
	}
	return data, nil
}

// --- mutations: durable write first, then reflect into the working set ---
//
// Working-set errors are swallowed: the durable write already succeeded, so a
// transient Redis failure only degrades cross-replica immediacy (the next read
// re-hydrates from the inner tree) rather than failing the request.

func (c *CoherentStorage) WriteFile(ctx context.Context, ns, relPath string, data []byte) error {
	if err := c.Storage.WriteFile(ctx, ns, relPath, data); err != nil {
		return err
	}
	// Re-read rather than caching the input: the inner git backend may
	// reconcile a note's mdnest marker on write, so the coherence tier must
	// reflect what actually landed on disk, not the pre-reconcile bytes.
	c.publish(ctx, ns, relPath)
	return nil
}

func (c *CoherentStorage) WriteFrom(ctx context.Context, ns, relPath string, r io.Reader, size int64) error {
	if err := c.Storage.WriteFrom(ctx, ns, relPath, r, size); err != nil {
		return err
	}
	if size >= 0 && size > c.maxBytes {
		_ = c.ws.Delete(ctx, ns, relPath) // too large to cache; drop any stale entry
		return nil
	}
	c.publish(ctx, ns, relPath)
	return nil
}

func (c *CoherentStorage) Append(ctx context.Context, ns, relPath string, data []byte) error {
	if err := c.Storage.Append(ctx, ns, relPath, data); err != nil {
		return err
	}
	c.publish(ctx, ns, relPath) // append changes the whole body; re-read and republish
	return nil
}

func (c *CoherentStorage) Remove(ctx context.Context, ns, relPath string) error {
	if err := c.Storage.Remove(ctx, ns, relPath); err != nil {
		return err
	}
	_ = c.ws.Delete(ctx, ns, relPath)
	return nil
}

func (c *CoherentStorage) RemoveAll(ctx context.Context, ns, relPath string) error {
	if err := c.Storage.RemoveAll(ctx, ns, relPath); err != nil {
		return err
	}
	_ = c.ws.DeletePrefix(ctx, ns, relPath)
	return nil
}

func (c *CoherentStorage) Rename(ctx context.Context, ns, from, to string) error {
	if err := c.Storage.Rename(ctx, ns, from, to); err != nil {
		return err
	}
	// Invalidate both ends: the source no longer exists and the destination's
	// cached entries (if any) are stale. Reads re-hydrate the destination from
	// the inner tree on demand.
	_ = c.ws.DeletePrefix(ctx, ns, from)
	_ = c.ws.DeletePrefix(ctx, ns, to)
	return nil
}

// publish reflects the current inner content of relPath into the working set,
// dropping the key when the file is gone or too large to cache.
func (c *CoherentStorage) publish(ctx context.Context, ns, relPath string) {
	data, err := c.Storage.ReadFile(ctx, ns, relPath)
	if err != nil {
		_ = c.ws.Delete(ctx, ns, relPath)
		return
	}
	cacheBody(ctx, c.ws, ns, relPath, data, c.maxBytes)
}

// coherentRangeStorage adds RangeReadable back when the inner backend supports
// it. Range/conditional-GET serving (attachments via /api/files/) is delegated
// to the inner backend rather than the working set, which only holds small note
// bodies.
type coherentRangeStorage struct {
	*CoherentStorage
}

func (c *coherentRangeStorage) OpenSeek(ctx context.Context, ns, relPath string) (io.ReadSeekCloser, FileInfo, error) {
	return c.Storage.(RangeReadable).OpenSeek(ctx, ns, relPath)
}
