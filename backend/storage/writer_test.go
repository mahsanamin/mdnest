package storage

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

// fakeLeader grants leadership immediately and never revokes it.
type fakeLeader struct{}

func (fakeLeader) Campaign(ctx context.Context) (context.Context, error) { return ctx, nil }
func (fakeLeader) Close() error                                          { return nil }

// fakeQueue is a synchronous in-memory DurabilityQueue: Consume drains every
// enqueued op once (in order) and returns, so writer orchestration can be
// asserted deterministically without a real Redis stream.
type fakeQueue struct {
	ops     []DurabilityOp
	applied []DurabilityOp
}

func (q *fakeQueue) Enqueue(_ context.Context, op DurabilityOp) error {
	q.ops = append(q.ops, op)
	return nil
}
func (q *fakeQueue) Consume(ctx context.Context, apply func(context.Context, DurabilityOp) error) error {
	for _, op := range q.ops {
		if err := apply(ctx, op); err != nil {
			return err
		}
		q.applied = append(q.applied, op)
	}
	return nil
}
func (q *fakeQueue) Close() error { return nil }

func newTestWriter(t *testing.T) (*Writer, *fakeQueue, *fakeWorkingSet, *GitStorage) {
	t.Helper()
	// NoopCommitter keeps the durable tree on disk without spawning git.
	gs, err := NewGitStorage(t.TempDir(), NoopCommitter{})
	if err != nil {
		t.Fatalf("NewGitStorage: %v", err)
	}
	q := &fakeQueue{}
	ws := newFakeWorkingSet()
	w := NewWriter(gs, ws, q, fakeLeader{}, defaultWorkingSetMaxBytes)
	return w, q, ws, gs
}

// TestWriterAppliesQueuedWrite runs the full orchestration: leadership, hydrate,
// then draining a queued write onto the durable tree and into the working set.
func TestWriterAppliesQueuedWrite(t *testing.T) {
	ctx := context.Background()
	w, q, ws, gs := newTestWriter(t)

	_ = q.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: "team", Path: "a/b.md", Data: []byte("hi")})
	if err := w.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	got, err := gs.ReadFile(ctx, "team", "a/b.md")
	if err != nil {
		t.Fatalf("durable ReadFile: %v", err)
	}
	if string(got) != "hi" {
		t.Fatalf("durable body = %q, want %q", got, "hi")
	}
	if data, ok, _ := ws.Get(ctx, "team", "a/b.md"); !ok || string(data) != "hi" {
		t.Fatalf("working set not reflected: ok=%v data=%q", ok, data)
	}
}

func TestWriterApplyAllKinds(t *testing.T) {
	ctx := context.Background()
	w, _, ws, gs := newTestWriter(t)

	must := func(op DurabilityOp) {
		if err := w.apply(ctx, op); err != nil {
			t.Fatalf("apply %s: %v", op.Kind, err)
		}
	}

	// write, then rename, then remove-all a directory, then remove a file.
	must(DurabilityOp{Kind: OpWrite, NS: "ns", Path: "old.md", Data: []byte("v")})
	must(DurabilityOp{Kind: OpRename, NS: "ns", Path: "old.md", To: "new.md"})
	if _, err := gs.ReadFile(ctx, "ns", "new.md"); err != nil {
		t.Fatalf("rename dest missing: %v", err)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "old.md"); ok {
		t.Fatal("rename left source in working set")
	}

	must(DurabilityOp{Kind: OpWrite, NS: "ns", Path: "dir/x.md", Data: []byte("x")})
	must(DurabilityOp{Kind: OpRemoveAll, NS: "ns", Path: "dir"})
	if _, ok, _ := ws.Get(ctx, "ns", "dir/x.md"); ok {
		t.Fatal("remove-all left entry in working set")
	}

	must(DurabilityOp{Kind: OpWrite, NS: "ns", Path: "gone.md", Data: []byte("g")})
	must(DurabilityOp{Kind: OpRemove, NS: "ns", Path: "gone.md"})
	if _, err := gs.ReadFile(ctx, "ns", "gone.md"); err != ErrNotExist {
		t.Fatalf("remove left file: %v", err)
	}
}

// TestWriterApplyIdempotent verifies at-least-once redelivery converges: applying
// the same remove twice is not an error.
func TestWriterApplyIdempotent(t *testing.T) {
	ctx := context.Background()
	w, _, _, _ := newTestWriter(t)
	if err := w.apply(ctx, DurabilityOp{Kind: OpRemove, NS: "ns", Path: "never.md"}); err != nil {
		t.Fatalf("removing an absent file should be a no-op, got %v", err)
	}
}

// TestWriterHydrateLoadsCorpus checks startup hydration populates the working set
// from the durable tree and skips oversize bodies.
func TestWriterHydrateLoadsCorpus(t *testing.T) {
	ctx := context.Background()
	w, _, ws, gs := newTestWriter(t)
	w.maxBytes = 8

	if err := gs.MkdirAll(ctx, "ns", ""); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := gs.WriteFile(ctx, "ns", "small.md", []byte("tiny")); err != nil {
		t.Fatalf("WriteFile small: %v", err)
	}
	if err := gs.WriteFile(ctx, "ns", "big.md", []byte(strings.Repeat("z", 100))); err != nil {
		t.Fatalf("WriteFile big: %v", err)
	}

	if err := w.hydrate(ctx); err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if data, ok, _ := ws.Get(ctx, "ns", "small.md"); !ok || !bytes.Equal(data, []byte("tiny")) {
		t.Fatalf("small body not hydrated: ok=%v data=%q", ok, data)
	}
	if _, ok, _ := ws.Get(ctx, "ns", "big.md"); ok {
		t.Fatal("oversize body was hydrated into the working set")
	}
}
