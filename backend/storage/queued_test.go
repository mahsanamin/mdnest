package storage

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func newTestQueued(t *testing.T) (*QueuedStorage, *fakeQueue, *fakeWorkingSet) {
	t.Helper()
	ws := newFakeWorkingSet()
	q := &fakeQueue{}
	qs := NewQueuedStorage(ws, q, defaultWorkingSetMaxBytes)
	_ = ws.AddNamespace(context.Background(), "ns")
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

func TestQueuedReadServesFromWorkingSetOnly(t *testing.T) {
	ctx := context.Background()
	qs, _, ws := newTestQueued(t)

	if _, err := qs.ReadFile(ctx, "ns", "missing.md"); err != ErrNotExist {
		t.Fatalf("miss should be ErrNotExist, got %v", err)
	}
	_ = ws.Set(ctx, "ns", "a.md", []byte("body"))
	got, err := qs.ReadFile(ctx, "ns", "a.md")
	if err != nil || string(got) != "body" {
		t.Fatalf("read: got %q err %v", got, err)
	}
}

func TestQueuedAppendUsesLatestBody(t *testing.T) {
	ctx := context.Background()
	qs, q, ws := newTestQueued(t)
	_ = ws.Set(ctx, "ns", "log.md", []byte("a"))

	if err := qs.Append(ctx, "ns", "log.md", []byte("b")); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if data, ok, _ := ws.Get(ctx, "ns", "log.md"); !ok || string(data) != "ab" {
		t.Fatalf("append working-set body = %q ok=%v, want ab", data, ok)
	}
	if op := lastOp(t, q); op.Kind != OpWrite || string(op.Data) != "ab" {
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
	if op := lastOp(t, q); op.Kind != OpRename || op.Path != "old.md" || op.To != "new.md" {
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

// TestQueuedListingFromIndex checks namespaces, ReadDir, Stat and Walk are all
// derived from the working-set index (no filesystem).
func TestQueuedListingFromIndex(t *testing.T) {
	ctx := context.Background()
	qs, _, ws := newTestQueued(t)
	_ = ws.AddNamespace(ctx, "empty") // empty workspace must still be listed
	for _, p := range []string{"root.md", "dir/a.md", "dir/sub/b.md"} {
		_ = ws.Set(ctx, "ns", p, []byte("x"))
	}

	nss, err := qs.ListNamespaces(ctx)
	if err != nil || !reflect.DeepEqual(nss, []string{"empty", "ns"}) {
		t.Fatalf("ListNamespaces = %v err %v, want [empty ns]", nss, err)
	}

	// ReadDir at root: root.md (file) + dir (directory).
	entries, err := qs.ReadDir(ctx, "ns", "")
	if err != nil {
		t.Fatalf("ReadDir root: %v", err)
	}
	if len(entries) != 2 || entries[0].Name != "dir" || !entries[0].IsDir || entries[1].Name != "root.md" || entries[1].IsDir {
		t.Fatalf("ReadDir root = %+v", entries)
	}

	// ReadDir of a nested dir.
	sub, err := qs.ReadDir(ctx, "ns", "dir")
	if err != nil {
		t.Fatalf("ReadDir dir: %v", err)
	}
	if len(sub) != 2 || sub[0].Name != "a.md" || sub[1].Name != "sub" || !sub[1].IsDir {
		t.Fatalf("ReadDir dir = %+v", sub)
	}

	// Stat: file, directory, namespace root, and a miss.
	if fi, err := qs.Stat(ctx, "ns", "root.md"); err != nil || fi.IsDir || fi.Size != 1 {
		t.Fatalf("Stat file = %+v err %v", fi, err)
	}
	if fi, err := qs.Stat(ctx, "ns", "dir"); err != nil || !fi.IsDir {
		t.Fatalf("Stat dir = %+v err %v", fi, err)
	}
	if fi, err := qs.Stat(ctx, "ns", ""); err != nil || !fi.IsDir {
		t.Fatalf("Stat ns root = %+v err %v", fi, err)
	}
	if _, err := qs.Stat(ctx, "ns", "nope.md"); err != ErrNotExist {
		t.Fatalf("Stat miss = %v, want ErrNotExist", err)
	}

	// Walk collects the three files and visits directories (SkipDir honored).
	var files []string
	if err := qs.Walk(ctx, "ns", "", func(rel string, info FileInfo) error {
		if !info.IsDir {
			files = append(files, rel)
		}
		return nil
	}); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{"dir/a.md", "dir/sub/b.md", "root.md"}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("Walk files = %v, want %v", files, want)
	}

	// SkipDir on "dir" prunes its subtree.
	var kept []string
	_ = qs.Walk(ctx, "ns", "", func(rel string, info FileInfo) error {
		if info.IsDir && rel == "dir" {
			return SkipDir
		}
		if !info.IsDir {
			kept = append(kept, rel)
		}
		return nil
	})
	if !reflect.DeepEqual(kept, []string{"root.md"}) {
		t.Fatalf("Walk with SkipDir kept = %v, want [root.md]", kept)
	}
}
