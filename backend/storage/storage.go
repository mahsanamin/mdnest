// Package storage provides a pluggable backend for note persistence.
//
// The default backend ("local") is a thin, behaviour-preserving wrapper
// around the os.* / filepath.* calls the handlers used before this package
// existed, so enabling it changes nothing. The interface is deliberately
// backend-agnostic so alternative backends (e.g. an object store) can be
// added later behind the STORAGE_BACKEND flag without touching call sites.
//
// All operations are namespace-scoped. A namespace maps to a top-level
// directory for the local backend. Paths passed to this package are
// namespace-relative and must already be validated for traversal by the
// caller (see handlers.SafeRelPath).
//
// SafeRelPath is a *lexical* contract only: it rejects absolute paths and
// ".." traversal without touching the filesystem, so it is valid for every
// backend (including object stores, which have no symlinks). A backend that
// resolves paths against a real filesystem therefore owes an *additional*
// symlink-containment check, because a namespace directory is a first-class
// authoring surface (git-sync writes into it, host-side restores preserve
// symlinks) and a symlink placed inside it could otherwise redirect reads or
// writes outside the namespace. The local backend does this in abs(); see
// LocalStorage.
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
// namespace-relative, slash-separated, and already lexically traversal-checked
// by the caller (handlers.SafeRelPath). A filesystem-backed implementation
// additionally owes a symlink-containment check (see the package doc).
// Namespaces are validated by the implementation.
type Storage interface {
	// Kind returns the backend identifier ("local"). Handlers use it to gate
	// behaviour that only makes sense on a real filesystem (e.g. git-backed
	// history/sync).
	Kind() string

	// --- Namespace operations ---

	// ListNamespaces returns the sorted list of existing namespaces,
	// excluding hidden ones (names starting with ".").
	ListNamespaces(ctx context.Context) ([]string, error)

	// NamespaceExists reports whether the namespace exists.
	NamespaceExists(ctx context.Context, ns string) (bool, error)

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

// RangeReadable is an optional capability implemented by backends that can
// hand out a seekable reader. Handlers use it to serve HTTP range requests
// and conditional GETs via http.ServeContent (preserving Accept-Ranges/206
// and Last-Modified/If-Modified-Since/304). Backends that can only stream
// (e.g. object stores) do not implement it and are served with a plain copy.
type RangeReadable interface {
	// OpenSeek returns a seekable reader for a file together with its
	// metadata. The caller must Close the reader. It returns ErrNotExist if
	// the file is missing.
	OpenSeek(ctx context.Context, ns, relPath string) (io.ReadSeekCloser, FileInfo, error)
}
