package storage

import (
	"context"
	"strings"
	"testing"
)

// fakeWorkingSet is an in-memory WorkingSet mirroring RedisWorkingSet semantics
// (a body map plus per-namespace path index), so CoherentStorage can be tested
// without a real Redis — matching the project convention (the collab Redis
// backplane is likewise exercised via a fake, not a live server).
type fakeWorkingSet struct {
	data map[string][]byte // key: ns + "\x00" + relPath
}

func newFakeWorkingSet() *fakeWorkingSet {
	return &fakeWorkingSet{data: make(map[string][]byte)}
}

func fwKey(ns, p string) string { return ns + "\x00" + p }

func (f *fakeWorkingSet) Get(_ context.Context, ns, p string) ([]byte, bool, error) {
	d, ok := f.data[fwKey(ns, p)]
	return d, ok, nil
}
func (f *fakeWorkingSet) Set(_ context.Context, ns, p string, d []byte) error {
	cp := make([]byte, len(d))
	copy(cp, d)
	f.data[fwKey(ns, p)] = cp
	return nil
}
func (f *fakeWorkingSet) Delete(_ context.Context, ns, p string) error {
	delete(f.data, fwKey(ns, p))
	return nil
}
func (f *fakeWorkingSet) DeletePrefix(_ context.Context, ns, p string) error {
	for k := range f.data {
		parts := strings.SplitN(k, "\x00", 2)
		if parts[0] != ns {
			continue
		}
		rel := parts[1]
		if p == "" || rel == p || strings.HasPrefix(rel, p+"/") {
			delete(f.data, k)
		}
	}
	return nil
}
func (f *fakeWorkingSet) Close() error { return nil }

func newTestCoherent(t *testing.T) (*CoherentStorage, *fakeWorkingSet, *LocalStorage) {
	t.Helper()
	inner, err := NewLocalStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	if err := inner.MkdirAll(context.Background(), "ns", ""); err != nil {
		t.Fatalf("create namespace: %v", err)
	}
	ws := newFakeWorkingSet()
	c := &CoherentStorage{Storage: inner, ws: ws, maxBytes: defaultWorkingSetMaxBytes}
	return c, ws, inner
}

// TestReadServesFromWorkingSetAcrossReplicas simulates a cross-replica read:
// after a write-through, the working set alone (with the inner tree emptied)
// must still serve the body — this is the read-after-write coherence guarantee.
func TestReadServesFromWorkingSetAcrossReplicas(t *testing.T) {
	ctx := context.Background()
	c, ws, inner := newTestCoherent(t)

	if err := c.WriteFile(ctx, "ns", "a/b.md", []byte("hello")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "a/b.md"); !ok {
		t.Fatal("write-through did not populate the working set")
	}

	// Drop the body from the inner tree: a peer replica would not have it on its
	// local filesystem, so a correct read must come from the working set.
	if err := inner.Remove(ctx, "ns", "a/b.md"); err != nil {
		t.Fatalf("inner.Remove: %v", err)
	}
	got, err := c.ReadFile(ctx, "ns", "a/b.md")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("got %q, want %q", got, "hello")
	}
}

// TestReadHydratesWorkingSetOnMiss verifies a miss falls back to the inner tree
// and populates the working set for subsequent reads.
func TestReadHydratesWorkingSetOnMiss(t *testing.T) {
	ctx := context.Background()
	c, ws, inner := newTestCoherent(t)

	// Populate the inner tree directly (bypassing the coherence layer).
	if err := inner.WriteFile(ctx, "ns", "note.md", []byte("world")); err != nil {
		t.Fatalf("inner.WriteFile: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "note.md"); ok {
		t.Fatal("working set unexpectedly primed")
	}

	got, err := c.ReadFile(ctx, "ns", "note.md")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "world" {
		t.Fatalf("got %q, want %q", got, "world")
	}
	if _, ok, _ := ws.Get(ctx, "ns", "note.md"); !ok {
		t.Fatal("read miss did not hydrate the working set")
	}
}

func TestRemoveInvalidatesWorkingSet(t *testing.T) {
	ctx := context.Background()
	c, ws, _ := newTestCoherent(t)

	if err := c.WriteFile(ctx, "ns", "gone.md", []byte("x")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := c.Remove(ctx, "ns", "gone.md"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "gone.md"); ok {
		t.Fatal("Remove did not evict the working-set entry")
	}
}

func TestRemoveAllInvalidatesPrefix(t *testing.T) {
	ctx := context.Background()
	c, ws, _ := newTestCoherent(t)

	for _, p := range []string{"dir/a.md", "dir/sub/b.md", "keep.md"} {
		if err := c.WriteFile(ctx, "ns", p, []byte("x")); err != nil {
			t.Fatalf("WriteFile %s: %v", p, err)
		}
	}
	if err := c.RemoveAll(ctx, "ns", "dir"); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "dir/a.md"); ok {
		t.Fatal("RemoveAll left dir/a.md in the working set")
	}
	if _, ok, _ := ws.Get(ctx, "ns", "dir/sub/b.md"); ok {
		t.Fatal("RemoveAll left dir/sub/b.md in the working set")
	}
	if _, ok, _ := ws.Get(ctx, "ns", "keep.md"); !ok {
		t.Fatal("RemoveAll evicted an unrelated sibling (keep.md)")
	}
}

func TestRenameInvalidatesBothEnds(t *testing.T) {
	ctx := context.Background()
	c, ws, _ := newTestCoherent(t)

	if err := c.WriteFile(ctx, "ns", "old.md", []byte("v")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := c.Rename(ctx, "ns", "old.md", "new.md"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "old.md"); ok {
		t.Fatal("Rename left the source in the working set")
	}
	// Destination re-hydrates from the inner tree on read.
	got, err := c.ReadFile(ctx, "ns", "new.md")
	if err != nil {
		t.Fatalf("ReadFile new.md: %v", err)
	}
	if string(got) != "v" {
		t.Fatalf("got %q, want %q", got, "v")
	}
}

func TestOversizedBodyNotCached(t *testing.T) {
	ctx := context.Background()
	c, ws, _ := newTestCoherent(t)
	c.maxBytes = 8 // tiny cap for the test

	if err := c.WriteFile(ctx, "ns", "big.bin", []byte("0123456789")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "big.bin"); ok {
		t.Fatal("body over the size cap was cached")
	}
	// A read of an oversized file must still work (served from the inner tree)
	// and must not hydrate the working set.
	got, err := c.ReadFile(ctx, "ns", "big.bin")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "0123456789" {
		t.Fatalf("got %q", got)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "big.bin"); ok {
		t.Fatal("oversized read hydrated the working set")
	}
}

func TestAppendRepublishesWholeBody(t *testing.T) {
	ctx := context.Background()
	c, ws, inner := newTestCoherent(t)

	if err := c.WriteFile(ctx, "ns", "log.md", []byte("a")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := c.Append(ctx, "ns", "log.md", []byte("b")); err != nil {
		t.Fatalf("Append: %v", err)
	}
	// Working set must hold the full post-append body, visible cross-replica.
	if err := inner.Remove(ctx, "ns", "log.md"); err != nil {
		t.Fatalf("inner.Remove: %v", err)
	}
	got, err := c.ReadFile(ctx, "ns", "log.md")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "ab" {
		t.Fatalf("got %q, want %q", got, "ab")
	}
	_ = ws
}

// TestRangeReadablePreserved verifies the constructor keeps the RangeReadable
// capability when the inner backend has it, so attachment range serving via
// http.ServeContent keeps working through the coherence wrapper.
func TestRangeReadablePreserved(t *testing.T) {
	ctx := context.Background()
	inner, err := NewLocalStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	if err := inner.MkdirAll(ctx, "ns", ""); err != nil {
		t.Fatalf("create namespace: %v", err)
	}
	stg := newCoherentStorage(inner, newFakeWorkingSet(), 0)

	rr, ok := stg.(RangeReadable)
	if !ok {
		t.Fatal("coherent wrapper dropped RangeReadable from a range-capable inner")
	}
	if err := stg.WriteFile(ctx, "ns", "a.md", []byte("hello")); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	rs, info, err := rr.OpenSeek(ctx, "ns", "a.md")
	if err != nil {
		t.Fatalf("OpenSeek: %v", err)
	}
	defer rs.Close()
	if info.Size != 5 {
		t.Fatalf("info.Size = %d, want 5", info.Size)
	}
}
