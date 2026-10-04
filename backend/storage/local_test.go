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

// ResolveLinks answers "which file does this request really reach?" so the
// permission layer can authorise the target as well as the name.
func TestLocalResolveLinks(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "ns")
	os.MkdirAll(filepath.Join(base, "Private"), 0o755)
	os.MkdirAll(filepath.Join(base, "Shared"), 0o755)
	os.WriteFile(filepath.Join(base, "Private", "p.md"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(base, "Shared", "a.md"), []byte("x"), 0o644)
	if err := os.Symlink(filepath.Join(base, "Private", "p.md"), filepath.Join(base, "Shared", "link.md")); err != nil {
		t.Skip("no symlinks")
	}
	os.Symlink(filepath.Join(base, "Private"), filepath.Join(base, "Shared", "ldir"))
	os.Symlink("a.md", filepath.Join(base, "Shared", "rel.md")) // relative target
	l, _ := NewLocalStorage(root)
	for in, want := range map[string]string{
		"Shared/a.md":          "Shared/a.md",
		"Shared/link.md":       "Private/p.md",
		"Shared/ldir/p.md":     "Private/p.md",
		"Shared/ldir/new/x.md": "Private/new/x.md", // does not exist yet
		"Shared/rel.md":        "Shared/a.md",
		"Shared/missing.md":    "Shared/missing.md",
		"":                     "",
	} {
		got, err := l.ResolveLinks(context.Background(), "ns", in)
		if err != nil || got != want {
			t.Errorf("ResolveLinks(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

// Every storage stack a deployment builds must answer the link question; a
// wrapper that forgot to forward it would make the permission layer refuse
// (fail closed) every request.
func TestStacksImplementLinkResolver(t *testing.T) {
	root := t.TempDir()
	local, _ := NewLocalStorage(root)
	git, err := NewGitStorage(root, NoopCommitter{})
	if err != nil {
		t.Fatal(err)
	}
	for name, s := range map[string]Storage{
		"local": local, "git": git,
		"coherent(range)": newCoherentStorage(git, nil, 0),
		"coherent":        &CoherentStorage{Storage: git},
	} {
		if _, ok := s.(LinkResolver); !ok {
			t.Errorf("%s does not implement LinkResolver", name)
		}
	}
}

// The local backend refuses a .git path segment outright, whatever the caller
// validated: nothing in mdnest reads or writes a repository's internals
// through storage, and a write there (core.fsmonitor, a hook) runs commands.
func TestLocalRefusesGitInternals(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "ns", ".git"), 0o755)
	l, _ := NewLocalStorage(root)
	ctx := context.Background()
	for _, p := range []string{".git/config", ".GIT/config", "sub/.git/hooks/pre-commit", ".git"} {
		if err := l.WriteFile(ctx, "ns", p, []byte("x")); err == nil {
			t.Errorf("WriteFile(%q) succeeded", p)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "ns", ".git", "config")); err == nil {
		t.Fatal(".git/config was written")
	}
}

// A link is followed by the filesystem, so containment and the .git rule must
// hold for the file it REACHES, not just for its name: a link to .git/config
// let a write plant core.fsmonitor, and a link out of the namespace was
// served whole. Links that stay inside the namespace (including into
// .mdnest, which the server itself writes) keep working.
func TestLocalRefusesLinksIntoGitOrOutOfNamespace(t *testing.T) {
	root := t.TempDir()
	ns := filepath.Join(root, "ns")
	for _, d := range []string{".git", "Shared", ".mdnest/comments"} {
		os.MkdirAll(filepath.Join(ns, d), 0o755)
	}
	os.MkdirAll(filepath.Join(root, "other"), 0o755)
	os.WriteFile(filepath.Join(ns, ".git", "config"), []byte("[core]\n"), 0o644)
	os.WriteFile(filepath.Join(root, "other", "secret.md"), []byte("OTHER-SECRET"), 0o644)
	os.WriteFile(filepath.Join(ns, "Shared", "a.md"), []byte("ok"), 0o644)
	os.WriteFile(filepath.Join(ns, ".mdnest", "comments", "x.jsonl"), []byte("c"), 0o644)
	if err := os.Symlink("../.git/config", filepath.Join(ns, "Shared", "cfg.md")); err != nil {
		t.Skip("no symlinks")
	}
	os.Symlink("../.git", filepath.Join(ns, "Shared", "gitdir"))
	os.Symlink("../../other/secret.md", filepath.Join(ns, "Shared", "out.md"))
	os.Symlink("../../other/new.md", filepath.Join(ns, "Shared", "dangling.md"))
	os.Symlink("a.md", filepath.Join(ns, "Shared", "ok.md"))
	os.Symlink("../.mdnest/comments/x.jsonl", filepath.Join(ns, "Shared", "srv.md"))
	l, _ := NewLocalStorage(root)
	ctx := context.Background()
	for _, p := range []string{"Shared/cfg.md", "Shared/gitdir/config", "Shared/out.md", "Shared/dangling.md"} {
		if b, err := l.ReadFile(ctx, "ns", p); err == nil {
			t.Errorf("ReadFile(%q) followed the link: %q", p, b)
		}
		if err := l.WriteFile(ctx, "ns", p, []byte("[core]\n\tfsmonitor = x\n")); err == nil {
			t.Errorf("WriteFile(%q) followed the link", p)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(ns, ".git", "config")); string(b) != "[core]\n" {
		t.Fatalf(".git/config was written through a link: %q", b)
	}
	if _, err := os.Stat(filepath.Join(root, "other", "new.md")); err == nil {
		t.Fatal("a dangling link created a file outside the namespace")
	}
	for _, p := range []string{"Shared/ok.md", "Shared/srv.md"} {
		if _, err := l.ReadFile(ctx, "ns", p); err != nil {
			t.Errorf("ReadFile(%q) of an in-namespace link: %v", p, err)
		}
	}
}

// A cross-namespace move notes the other side in each commit; every git
// stack must keep that capability (a wrapper that forgot to forward it would
// silently drop the note).
func TestStacksImplementAnnotator(t *testing.T) {
	root := t.TempDir()
	git, err := NewGitStorage(root, NoopCommitter{})
	if err != nil {
		t.Fatal(err)
	}
	for name, s := range map[string]Storage{
		"git": git, "coherent(range)": newCoherentStorage(git, nil, 0), "coherent": &CoherentStorage{Storage: git},
	} {
		if _, ok := s.(Annotator); !ok {
			t.Errorf("%s does not implement Annotator", name)
		}
	}
}
