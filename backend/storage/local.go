package storage

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// LocalStorage persists notes on the local filesystem. It is a thin,
// behaviour-preserving wrapper around the os.* calls the handlers used
// before the storage abstraction existed: a namespace is a top-level
// directory under root and a relPath is joined onto root/ns.
type LocalStorage struct {
	root string // absolute NOTES_DIR
}

// NewLocalStorage returns a LocalStorage rooted at the given (absolute)
// notes directory, creating it if necessary.
func NewLocalStorage(root string) (*LocalStorage, error) {
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, err
	}
	return &LocalStorage{root: root}, nil
}

func (l *LocalStorage) Kind() string { return "local" }

// abs joins root/ns/relPath and guards against escaping the namespace root.
// relPath is expected to be already lexically validated by the caller
// (handlers.SafeRelPath); the lexical prefix check below is defence in depth.
//
// It additionally resolves symlinks and re-verifies containment, mirroring
// what handlers.SafePath did before the storage abstraction existed. This is
// the filesystem-specific half of the path contract (see the package doc):
// a namespace directory can contain symlinks (git-sync writes into it, host
// restores preserve them), and without this check a symlink inside the
// namespace pointing outside it would be silently followed. abs returns ""
// when the resolved target would escape the namespace.
func (l *LocalStorage) abs(ns, relPath string) string {
	nsDir := filepath.Join(l.root, ns)
	if relPath == "" {
		return nsDir
	}
	target := filepath.Join(nsDir, filepath.FromSlash(relPath))
	if target != nsDir && !strings.HasPrefix(target, nsDir+string(filepath.Separator)) {
		return ""
	}
	if !containedAfterSymlinks(nsDir, target) {
		return ""
	}
	return target
}

// containedAfterSymlinks reports whether target stays within base once
// symlinks are resolved. It mirrors handlers.SafePath: it resolves the parent
// directory of target so an intermediate directory symlink that escapes the
// namespace is caught, and when that parent does not fully exist yet it walks
// up to the nearest existing ancestor. target itself need not exist, so
// creating a new note in a new folder still works.
func containedAfterSymlinks(base, target string) bool {
	baseReal, err := filepath.EvalSymlinks(base)
	if err != nil {
		return false
	}
	within := func(p string) bool {
		return p == baseReal ||
			strings.HasPrefix(p+string(filepath.Separator), baseReal+string(filepath.Separator))
	}
	if resolved, err := filepath.EvalSymlinks(filepath.Dir(target)); err == nil {
		return within(filepath.Join(resolved, filepath.Base(target)))
	}
	// Parent directory does not fully exist yet; find the nearest existing
	// ancestor and verify it is within base.
	check := target
	for {
		parent := filepath.Dir(check)
		if parent == check {
			return false
		}
		if real, err := filepath.EvalSymlinks(parent); err == nil {
			return within(real)
		}
		check = parent
	}
}

func translate(err error) error {
	if err == nil {
		return nil
	}
	if os.IsNotExist(err) {
		return ErrNotExist
	}
	return err
}

func (l *LocalStorage) ListNamespaces(ctx context.Context) ([]string, error) {
	entries, err := os.ReadDir(l.root)
	if err != nil {
		return nil, translate(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

func (l *LocalStorage) NamespaceExists(ctx context.Context, ns string) (bool, error) {
	info, err := os.Stat(filepath.Join(l.root, ns))
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	return info.IsDir(), nil
}

func (l *LocalStorage) ReadFile(ctx context.Context, ns, relPath string) ([]byte, error) {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return nil, ErrNotExist
	}
	data, err := os.ReadFile(abs)
	return data, translate(err)
}

func (l *LocalStorage) Open(ctx context.Context, ns, relPath string) (io.ReadCloser, error) {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return nil, ErrNotExist
	}
	f, err := os.Open(abs)
	return f, translate(err)
}

// OpenSeek implements RangeReadable: os.File is already an io.ReadSeekCloser,
// so the local backend can serve range requests and conditional GETs.
func (l *LocalStorage) OpenSeek(ctx context.Context, ns, relPath string) (io.ReadSeekCloser, FileInfo, error) {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return nil, FileInfo{}, ErrNotExist
	}
	f, err := os.Open(abs)
	if err != nil {
		return nil, FileInfo{}, translate(err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, FileInfo{}, translate(err)
	}
	return f, FileInfo{
		Name:    info.Name(),
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime(),
	}, nil
}

func (l *LocalStorage) WriteFile(ctx context.Context, ns, relPath string, data []byte) error {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return err
	}
	return os.WriteFile(abs, data, 0644)
}

func (l *LocalStorage) WriteFrom(ctx context.Context, ns, relPath string, r io.Reader, size int64) error {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return err
	}
	f, err := os.Create(abs)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, r)
	return err
}

func (l *LocalStorage) Append(ctx context.Context, ns, relPath string, data []byte) error {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(abs, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
}

func (l *LocalStorage) Stat(ctx context.Context, ns, relPath string) (FileInfo, error) {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return FileInfo{}, ErrNotExist
	}
	info, err := os.Stat(abs)
	if err != nil {
		return FileInfo{}, translate(err)
	}
	return FileInfo{
		Name:    info.Name(),
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime(),
	}, nil
}

func (l *LocalStorage) MkdirAll(ctx context.Context, ns, relPath string) error {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return ErrNotExist
	}
	return os.MkdirAll(abs, 0755)
}

func (l *LocalStorage) Remove(ctx context.Context, ns, relPath string) error {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return ErrNotExist
	}
	return translate(os.Remove(abs))
}

func (l *LocalStorage) RemoveAll(ctx context.Context, ns, relPath string) error {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return ErrNotExist
	}
	return os.RemoveAll(abs)
}

func (l *LocalStorage) Rename(ctx context.Context, ns, from, to string) error {
	absFrom := l.abs(ns, from)
	absTo := l.abs(ns, to)
	if absFrom == "" || absTo == "" {
		return ErrNotExist
	}
	if err := os.MkdirAll(filepath.Dir(absTo), 0755); err != nil {
		return err
	}
	return translate(os.Rename(absFrom, absTo))
}

func (l *LocalStorage) ReadDir(ctx context.Context, ns, relPath string) ([]DirEntry, error) {
	abs := l.abs(ns, relPath)
	if abs == "" {
		return nil, ErrNotExist
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, translate(err)
	}
	out := make([]DirEntry, 0, len(entries))
	for _, e := range entries {
		de := DirEntry{Name: e.Name(), IsDir: e.IsDir()}
		if !de.IsDir {
			if info, ierr := e.Info(); ierr == nil {
				de.Size = info.Size()
			}
		}
		out = append(out, de)
	}
	return out, nil
}

func (l *LocalStorage) Walk(ctx context.Context, ns, root string, fn WalkFunc) error {
	base := l.abs(ns, root)
	if base == "" {
		return ErrNotExist
	}
	nsDir := filepath.Join(l.root, ns)
	return filepath.Walk(base, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(nsDir, p)
		if rerr != nil {
			return rerr
		}
		werr := fn(filepath.ToSlash(rel), FileInfo{
			Name:    info.Name(),
			Size:    info.Size(),
			IsDir:   info.IsDir(),
			ModTime: info.ModTime(),
		})
		if werr == SkipDir {
			return filepath.SkipDir
		}
		return werr
	})
}
