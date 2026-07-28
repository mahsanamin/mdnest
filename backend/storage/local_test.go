package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestLocalStorageSymlinkContainment pins the security property that the
// storage abstraction must preserve: on the local backend, a symlink placed
// inside a namespace (e.g. via git-sync or a host-side restore) must not let
// reads or writes escape that namespace. The lexical SafeRelPath check the
// handlers run is not enough on a real filesystem, so LocalStorage.abs()
// resolves symlinks and re-verifies containment (mirroring the old
// handlers.SafePath). This is the regression the maintainer flagged on the
// storage-interface PR.
func TestLocalStorageSymlinkContainment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	ctx := context.Background()
	root := t.TempDir()
	l, err := NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}

	for _, ns := range []string{"team_a", "team_b"} {
		if err := os.Mkdir(filepath.Join(root, ns), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "team_b", "salaries.md"), []byte("SECRET-B"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A directory symlink inside team_a that points at the sibling namespace.
	if err := os.Symlink(filepath.Join(root, "team_b"), filepath.Join(root, "team_a", "peek")); err != nil {
		t.Fatal(err)
	}
	// A directory symlink inside team_a that points outside NOTES_DIR entirely.
	hostDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(hostDir, "id_rsa"), []byte("PRIVATE-KEY"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(hostDir, filepath.Join(root, "team_a", "host")); err != nil {
		t.Fatal(err)
	}

	t.Run("cross-namespace read is blocked", func(t *testing.T) {
		if _, err := l.ReadFile(ctx, "team_a", "peek/salaries.md"); !errors.Is(err, ErrNotExist) {
			t.Fatalf("got err=%v, want ErrNotExist (blocked)", err)
		}
	})
	t.Run("host-path read is blocked", func(t *testing.T) {
		if _, err := l.ReadFile(ctx, "team_a", "host/id_rsa"); !errors.Is(err, ErrNotExist) {
			t.Fatalf("got err=%v, want ErrNotExist (blocked)", err)
		}
	})
	t.Run("cross-namespace write is blocked", func(t *testing.T) {
		if err := l.WriteFile(ctx, "team_a", "peek/planted.md", []byte("PLANTED")); !errors.Is(err, ErrNotExist) {
			t.Fatalf("write got err=%v, want ErrNotExist (blocked)", err)
		}
		if _, err := os.Stat(filepath.Join(root, "team_b", "planted.md")); !os.IsNotExist(err) {
			t.Fatalf("write escaped into team_b via symlink")
		}
	})

	// The containment check must not break the legitimate case of creating a
	// note in a brand-new (not-yet-existing) subfolder.
	t.Run("new-folder write still works", func(t *testing.T) {
		if err := l.WriteFile(ctx, "team_a", "notes/new/hello.md", []byte("hi")); err != nil {
			t.Fatalf("legitimate new-folder write failed: %v", err)
		}
		got, err := l.ReadFile(ctx, "team_a", "notes/new/hello.md")
		if err != nil || string(got) != "hi" {
			t.Fatalf("legitimate read back failed: got=%q err=%v", got, err)
		}
	})
}

// TestLocalStorageOpenSeek verifies the optional RangeReadable capability the
// local backend exposes so /api/files/ can serve range/conditional GETs.
func TestLocalStorageOpenSeek(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	l, err := NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "ns"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := l.WriteFile(ctx, "ns", "a/b.txt", []byte("hello world")); err != nil {
		t.Fatal(err)
	}

	var _ RangeReadable = l // compile-time: local backend implements the capability

	rs, info, err := l.OpenSeek(ctx, "ns", "a/b.txt")
	if err != nil {
		t.Fatalf("OpenSeek: %v", err)
	}
	defer rs.Close()
	if info.Size != int64(len("hello world")) || info.ModTime.IsZero() {
		t.Fatalf("unexpected FileInfo: %+v", info)
	}
	if _, err := rs.Seek(6, 0); err != nil {
		t.Fatalf("seek: %v", err)
	}
	buf := make([]byte, 5)
	if _, err := rs.Read(buf); err != nil {
		t.Fatalf("read after seek: %v", err)
	}
	if string(buf) != "world" {
		t.Fatalf("seek/read got %q, want %q", buf, "world")
	}

	if _, _, err := l.OpenSeek(ctx, "ns", "missing.txt"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("missing file: got err=%v, want ErrNotExist", err)
	}
}
