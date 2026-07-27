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

// abs joins root/ns/relPath and guards against escaping the namespace
// root. relPath is expected to be already lexically validated by the
// caller (handlers.SafeRelPath); this is defence in depth.
func (l *LocalStorage) abs(ns, relPath string) string {
	nsDir := filepath.Join(l.root, ns)
	if relPath == "" {
		return nsDir
	}
	target := filepath.Join(nsDir, filepath.FromSlash(relPath))
	if target != nsDir && !strings.HasPrefix(target, nsDir+string(filepath.Separator)) {
		return ""
	}
	return target
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

func (l *LocalStorage) CreateNamespace(ctx context.Context, ns string) error {
	err := os.Mkdir(filepath.Join(l.root, ns), 0755)
	if os.IsExist(err) {
		return ErrExist
	}
	return err
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
