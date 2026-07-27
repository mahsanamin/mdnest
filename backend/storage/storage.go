// Package storage provides a pluggable backend for note persistence.
//
// The default backend ("local") is a thin, behaviour-preserving wrapper
// around the os.* / filepath.* calls the handlers used before this package
// existed, so enabling it changes nothing. An alternative "s3" backend
// stores notes in any S3-compatible object store, which lets the backend
// run with multiple replicas (no ReadWriteMany PVC) and decouples the data
// from the pod filesystem.
//
// All operations are namespace-scoped. A namespace maps to a top-level
// directory for the local backend and to a key prefix for the S3 backend.
// Paths passed to this package are namespace-relative and must already be
// validated for traversal by the caller (see handlers.SafeRelPath).
package storage

import (
	"context"
	"errors"
	"io"
	"time"
)

// ErrNotExist is returned when a namespace, file or directory does not
// exist. Callers should test with errors.Is(err, storage.ErrNotExist)
// instead of os.IsNotExist so the check works across backends.
var ErrNotExist = errors.New("storage: does not exist")

// ErrExist is returned when creating something that already exists.
var ErrExist = errors.New("storage: already exists")

// SkipDir, when returned by a WalkFunc for a directory, tells Walk to skip
// that directory's contents. It mirrors filepath.SkipDir.
var SkipDir = errors.New("storage: skip this directory")

// FileInfo is a backend-agnostic subset of fs.FileInfo.
type FileInfo struct {
	Name    string    // base name of the file
	Size    int64     // length in bytes; 0 for directories
	IsDir   bool      // true for directories / prefixes
	ModTime time.Time // last modification time (zero if unknown)
}

// DirEntry is a single child returned by ReadDir.
type DirEntry struct {
	Name  string // base name
	IsDir bool
	Size  int64 // file size in bytes (0 for directories)
}

// WalkFunc is called by Walk for each file and directory found under a
// root. relPath is namespace-relative (uses "/" separators). Returning
// SkipDir for a directory skips its contents; any other non-nil error
// aborts the walk.
type WalkFunc func(relPath string, info FileInfo) error

// Storage is the persistence abstraction used by the note handlers.
//
// Implementations MUST be safe for concurrent use. Paths are
// namespace-relative, slash-separated, and already traversal-checked by
// the caller. Namespaces are validated by the implementation.
type Storage interface {
	// Kind returns the backend identifier ("local" or "s3"). Handlers use
	// it to gate behaviour that only makes sense on a real filesystem
	// (e.g. git-backed history/sync).
	Kind() string

	// --- Namespace operations ---

	// ListNamespaces returns the sorted list of existing namespaces,
	// excluding hidden ones (names starting with ".").
	ListNamespaces(ctx context.Context) ([]string, error)

	// NamespaceExists reports whether the namespace exists.
	NamespaceExists(ctx context.Context, ns string) (bool, error)

	// CreateNamespace creates an empty namespace. It returns ErrExist if
	// the namespace already exists.
	CreateNamespace(ctx context.Context, ns string) error

	// --- File operations (relPath is namespace-relative) ---

	// ReadFile returns the full contents of a file. It returns
	// ErrNotExist if the file is missing.
	ReadFile(ctx context.Context, ns, relPath string) ([]byte, error)

	// Open returns a streaming reader for a file. The caller must Close
	// it. It returns ErrNotExist if the file is missing.
	Open(ctx context.Context, ns, relPath string) (io.ReadCloser, error)

	// WriteFile writes data to a file, creating parent directories as
	// needed and overwriting any existing content.
	WriteFile(ctx context.Context, ns, relPath string, data []byte) error

	// WriteFrom streams the reader into a file, creating parent
	// directories as needed. size may be -1 if unknown.
	WriteFrom(ctx context.Context, ns, relPath string, r io.Reader, size int64) error

	// Append appends data to a file, creating it (and parents) if absent.
	Append(ctx context.Context, ns, relPath string, data []byte) error

	// Stat returns metadata for a file or directory.
	Stat(ctx context.Context, ns, relPath string) (FileInfo, error)

	// MkdirAll ensures a directory exists (no-op if already present).
	MkdirAll(ctx context.Context, ns, relPath string) error

	// Remove deletes a single file. It returns ErrNotExist if missing.
	Remove(ctx context.Context, ns, relPath string) error

	// RemoveAll recursively deletes a file or directory tree. It is a
	// no-op if the target does not exist.
	RemoveAll(ctx context.Context, ns, relPath string) error

	// Rename moves a file or directory tree from one path to another.
	Rename(ctx context.Context, ns, from, to string) error

	// ReadDir lists the immediate children of a directory (one level).
	ReadDir(ctx context.Context, ns, relPath string) ([]DirEntry, error)

	// Walk recursively visits every file and directory under root,
	// invoking fn for each. Hidden entries are still reported; callers
	// filter them.
	Walk(ctx context.Context, ns, root string, fn WalkFunc) error
}
