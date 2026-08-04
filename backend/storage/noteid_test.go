package storage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func withMarker(body, uuid string) []byte {
	return []byte(body + "\n\n<!-- mdnest:" + uuid + " -->\n")
}

// newGitStorageForTest builds a git-backed store with a manual-flush committer.
func newGitStorageForTest(t *testing.T) (context.Context, *GitStorage, *intervalCommitter) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	c := NewIntervalCommitter(root, time.Hour, time.Hour, "ci", "ci@example.com", remoteConfig{})
	t.Cleanup(func() { _ = c.Close() })
	g, err := NewGitStorage(root, c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}
	return context.Background(), g, c
}

func TestReconcileNoteMarker_RecoversAcrossRecreate(t *testing.T) {
	ctx, g, c := newGitStorageForTest(t)
	const (
		prev = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
		fresh = "11111111-2222-3333-4444-555555555555"
	)

	// Create the note with its original marker and commit it.
	if err := g.WriteFile(ctx, "team", "n.md", withMarker("# Note", prev)); err != nil {
		t.Fatal(err)
	}
	if uuid, _ := readMarker(t, ctx, g); uuid != prev {
		t.Fatalf("fresh note: marker = %q, want %q (should be kept)", uuid, prev)
	}
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}

	// Delete the note (its comment sidecar would remain) and commit the delete.
	if err := g.Remove(ctx, "team", "n.md"); err != nil {
		t.Fatal(err)
	}
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}

	// Recreate at the same path with a brand-new marker: the prior marker must
	// be recovered from git so the note keeps its identity (and its comments).
	if err := g.WriteFile(ctx, "team", "n.md", withMarker("# Note rewritten", fresh)); err != nil {
		t.Fatal(err)
	}
	if uuid, _ := readMarker(t, ctx, g); uuid != prev {
		t.Fatalf("recreated note: marker = %q, want recovered %q", uuid, prev)
	}
}

func TestReconcileNoteMarker_KeepsExistingMarkerOnEdit(t *testing.T) {
	ctx, g, _ := newGitStorageForTest(t)
	const (
		orig = "aaaaaaaa-1111-2222-3333-444444444444"
		other = "bbbbbbbb-5555-6666-7777-888888888888"
	)
	if err := g.WriteFile(ctx, "team", "n.md", withMarker("# v1", orig)); err != nil {
		t.Fatal(err)
	}
	// An edit that arrives with a different marker is snapped back to the one
	// already on disk — no note silently changes identity.
	if err := g.WriteFile(ctx, "team", "n.md", withMarker("# v2", other)); err != nil {
		t.Fatal(err)
	}
	if uuid, _ := readMarker(t, ctx, g); uuid != orig {
		t.Fatalf("edited note: marker = %q, want stable %q", uuid, orig)
	}
}

func TestReconcileNoteMarker_NewNoteKeepsItsMarker(t *testing.T) {
	ctx, g, _ := newGitStorageForTest(t)
	const fresh = "cccccccc-9999-0000-1111-222222222222"
	if err := g.WriteFile(ctx, "team", "brand-new.md", withMarker("# new", fresh)); err != nil {
		t.Fatal(err)
	}
	b, err := g.ReadFile(ctx, "team", "brand-new.md")
	if err != nil {
		t.Fatal(err)
	}
	if uuid, _ := extractNoteMarker(b); uuid != fresh {
		t.Fatalf("new note: marker = %q, want %q", uuid, fresh)
	}
}

func readMarker(t *testing.T, ctx context.Context, g *GitStorage) (string, bool) {
	t.Helper()
	b, err := g.ReadFile(ctx, "team", "n.md")
	if err != nil {
		t.Fatal(err)
	}
	return extractNoteMarker(b)
}

func TestIsNoteFile(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"note.md", true},
		{"DC2 Design/brief.md", true},
		{".mdnest/comments/abc.jsonl", false},
		{".mdnest/comments/abc.md", false},
		{"image.png", false},
		{"notes.txt", false},
	}
	for _, tc := range cases {
		if got := isNoteFile(tc.path); got != tc.want {
			t.Errorf("isNoteFile(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestSetNoteMarker(t *testing.T) {
	// Swap in place, preserving surrounding text.
	in := []byte("# Title\n\n<!-- mdnest:0dd0aaaa-1111 -->\n")
	out := setNoteMarker(in, "beef0000-2222")
	if uuid, _ := extractNoteMarker(out); uuid != "beef0000-2222" {
		t.Fatalf("swap: got %q", uuid)
	}
	if string(out) != "# Title\n\n<!-- mdnest:beef0000-2222 -->\n" {
		t.Fatalf("swap altered formatting: %q", out)
	}
	// Append when absent.
	out = setNoteMarker([]byte("# Title\n"), "ffff0000")
	if uuid, ok := extractNoteMarker(out); !ok || uuid != "ffff0000" {
		t.Fatalf("append: got %q ok=%v", uuid, ok)
	}
}
