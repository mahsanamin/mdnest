package storage

import (
	"context"
	"strings"
	"testing"
)

func newTestQueued(t *testing.T) (*QueuedStorage, *fakeQueue, *fakeWorkingSet) {
	t.Helper()
	ws := newFakeWorkingSet()
	q := &fakeQueue{}
	qs, err := NewQueuedStorage(t.TempDir(), ws, q, defaultWorkingSetMaxBytes)
	if err != nil {
		t.Fatalf("NewQueuedStorage: %v", err)
	}
	// The app role never creates namespaces on its own clone; seed one directly
	// so the read-fallback paths have somewhere to read from.
	if err := qs.LocalStorage.MkdirAll(context.Background(), "ns", ""); err != nil {
		t.Fatalf("seed namespace: %v", err)
	}
	return qs, q, ws
}

func lastOp(t *testing.T, q *fakeQueue) DurabilityOp {
	t.Helper()
	if len(q.ops) == 0 {
		t.Fatal("no op enqueued")
	}
	return q.ops[len(q.ops)-1]
}

func TestQueuedWritePublishesAndEnqueues(t *testing.T) {
	ctx := context.Background()
	qs, q, ws := newTestQueued(t)

	if err := qs.WriteFile(ctx, "ns", "a.md", []byte("hi")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if data, ok, _ := ws.Get(ctx, "ns", "a.md"); !ok || string(data) != "hi" {
		t.Fatalf("working set not published: ok=%v data=%q", ok, data)
	}
	op := lastOp(t, q)
	if op.Kind != OpWrite || op.NS != "ns" || op.Path != "a.md" || string(op.Data) != "hi" {
		t.Fatalf("bad enqueued op: %+v", op)
	}
}

func TestQueuedReadPrefersWorkingSetThenClone(t *testing.T) {
	ctx := context.Background()
	qs, _, ws := newTestQueued(t)

	// Only in the clone: a read must fall back and hydrate the working set.
	if err := qs.LocalStorage.WriteFile(ctx, "ns", "cold.md", []byte("cold")); err != nil {
		t.Fatalf("seed clone: %v", err)
	}
	got, err := qs.ReadFile(ctx, "ns", "cold.md")
	if err != nil || string(got) != "cold" {
		t.Fatalf("clone fallback: got %q err %v", got, err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "cold.md"); !ok {
		t.Fatal("clone read did not hydrate the working set")
	}

	// Working set wins over a diverging clone (fresh write not yet synced).
	_ = ws.Set(ctx, "ns", "cold.md", []byte("hot"))
	got, _ = qs.ReadFile(ctx, "ns", "cold.md")
	if string(got) != "hot" {
		t.Fatalf("working set did not take precedence: %q", got)
	}
}

func TestQueuedAppendUsesLatestBody(t *testing.T) {
	ctx := context.Background()
	qs, q, ws := newTestQueued(t)

	// Current body lives only in the clone; append must read it (not treat the
	// file as empty) and enqueue the full concatenated body.
	if err := qs.LocalStorage.WriteFile(ctx, "ns", "log.md", []byte("a")); err != nil {
		t.Fatalf("seed clone: %v", err)
	}
	if err := qs.Append(ctx, "ns", "log.md", []byte("b")); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if data, ok, _ := ws.Get(ctx, "ns", "log.md"); !ok || string(data) != "ab" {
		t.Fatalf("append working-set body = %q ok=%v, want ab", data, ok)
	}
	op := lastOp(t, q)
	if op.Kind != OpWrite || string(op.Data) != "ab" {
		t.Fatalf("append enqueued %+v, want full-body OpWrite ab", op)
	}
}

func TestQueuedRemoveInvalidatesAndEnqueues(t *testing.T) {
	ctx := context.Background()
	qs, q, ws := newTestQueued(t)
	_ = ws.Set(ctx, "ns", "a.md", []byte("x"))

	if err := qs.Remove(ctx, "ns", "a.md"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "a.md"); ok {
		t.Fatal("Remove did not evict the working-set entry")
	}
	if op := lastOp(t, q); op.Kind != OpRemove || op.Path != "a.md" {
		t.Fatalf("bad remove op: %+v", op)
	}
}

func TestQueuedRenameMovesBodyAndEnqueues(t *testing.T) {
	ctx := context.Background()
	qs, q, ws := newTestQueued(t)
	_ = ws.Set(ctx, "ns", "old.md", []byte("v"))

	if err := qs.Rename(ctx, "ns", "old.md", "new.md"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "old.md"); ok {
		t.Fatal("Rename left source in working set")
	}
	if data, ok, _ := ws.Get(ctx, "ns", "new.md"); !ok || string(data) != "v" {
		t.Fatalf("Rename did not move body to dest: ok=%v data=%q", ok, data)
	}
	op := lastOp(t, q)
	if op.Kind != OpRename || op.Path != "old.md" || op.To != "new.md" {
		t.Fatalf("bad rename op: %+v", op)
	}
}

func TestQueuedOversizeNotCachedButEnqueued(t *testing.T) {
	ctx := context.Background()
	qs, q, ws := newTestQueued(t)
	qs.maxBytes = 4

	big := []byte(strings.Repeat("z", 10))
	if err := qs.WriteFile(ctx, "ns", "big.bin", big); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "big.bin"); ok {
		t.Fatal("oversize body cached in working set")
	}
	if op := lastOp(t, q); op.Kind != OpWrite || len(op.Data) != 10 {
		t.Fatalf("oversize write not enqueued with full data: %+v", op)
	}
}

// TestQueuedImplementsRangeReadable pins that attachment range serving keeps
// working on an app replica (delegated to the clone).
func TestQueuedImplementsRangeReadable(t *testing.T) {
	qs, _, _ := newTestQueued(t)
	if _, ok := interface{}(qs).(RangeReadable); !ok {
		t.Fatal("QueuedStorage lost RangeReadable")
	}
}
