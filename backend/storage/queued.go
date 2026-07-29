package storage

import (
	"bytes"
	"context"
	"io"
	"sort"
	"strings"
)

// QueuedStorage is the app-replica backend in the HA topology (MDNEST_ROLE=app).
// A replica is fully stateless: it owns no filesystem. Every read is served from
// the shared Redis working set (the writer hydrates it with the whole corpus on
// startup and keeps it current), and every mutation publishes to the working set
// for immediate cross-replica visibility and enqueues a durability op for the
// single writer to apply to the authoritative git tree.
//
// Directory listings and Stat are derived from the working-set index rather than
// a filesystem. As in git, empty sub-directories are not represented — a folder
// appears once it holds a note; empty namespaces are tracked explicitly so a
// freshly created workspace is still listed.
type QueuedStorage struct {
	ws       WorkingSet
	queue    DurabilityQueue
	maxBytes int64
}

// NewQueuedStorage builds an app-role backend. maxBytes <= 0 uses the default
// working-set body cap.
func NewQueuedStorage(ws WorkingSet, queue DurabilityQueue, maxBytes int64) *QueuedStorage {
	if maxBytes <= 0 {
		maxBytes = defaultWorkingSetMaxBytes
	}
	return &QueuedStorage{ws: ws, queue: queue, maxBytes: maxBytes}
}

func (q *QueuedStorage) Kind() string { return "app" }

// --- namespaces (from the working-set registry) ---

func (q *QueuedStorage) ListNamespaces(ctx context.Context) ([]string, error) {
	names, err := q.ws.Namespaces(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if !strings.HasPrefix(n, ".") {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out, nil
}

func (q *QueuedStorage) NamespaceExists(ctx context.Context, ns string) (bool, error) {
	names, err := q.ws.Namespaces(ctx)
	if err != nil {
		return false, err
	}
	for _, n := range names {
		if n == ns {
			return true, nil
		}
	}
	return false, nil
}

// --- reads: the working set is authoritative on an app replica ---

func (q *QueuedStorage) ReadFile(ctx context.Context, ns, relPath string) ([]byte, error) {
	if data, ok, err := q.ws.Get(ctx, ns, relPath); err == nil && ok {
		return data, nil
	}
	return nil, ErrNotExist
}

func (q *QueuedStorage) Open(ctx context.Context, ns, relPath string) (io.ReadCloser, error) {
	if data, ok, err := q.ws.Get(ctx, ns, relPath); err == nil && ok {
		return io.NopCloser(bytes.NewReader(data)), nil
	}
	return nil, ErrNotExist
}

func (q *QueuedStorage) Stat(ctx context.Context, ns, relPath string) (FileInfo, error) {
	if relPath == "" {
		if ok, err := q.NamespaceExists(ctx, ns); err != nil || !ok {
			return FileInfo{}, ErrNotExist
		}
		return FileInfo{Name: ns, IsDir: true}, nil
	}
	if data, ok, _ := q.ws.Get(ctx, ns, relPath); ok {
		return FileInfo{Name: pathBase(relPath), Size: int64(len(data)), IsDir: false}, nil
	}
	// A directory exists if any note lives under it.
	list, err := q.ws.List(ctx, ns)
	if err != nil {
		return FileInfo{}, err
	}
	dirPrefix := relPath + "/"
	for _, p := range list {
		if strings.HasPrefix(p, dirPrefix) {
			return FileInfo{Name: pathBase(relPath), IsDir: true}, nil
		}
	}
	return FileInfo{}, ErrNotExist
}

func (q *QueuedStorage) ReadDir(ctx context.Context, ns, relPath string) ([]DirEntry, error) {
	list, err := q.ws.List(ctx, ns)
	if err != nil {
		return nil, err
	}
	prefix := ""
	if relPath != "" {
		prefix = relPath + "/"
	}
	found := relPath == ""
	children := map[string]*DirEntry{}
	for _, p := range list {
		if relPath != "" {
			if p == relPath { // relPath names a file, not a directory
				return nil, ErrNotExist
			}
			if !strings.HasPrefix(p, prefix) {
				continue
			}
			found = true
		}
		rest := p[len(prefix):]
		if rest == "" {
			continue
		}
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			name := rest[:i]
			if _, ok := children[name]; !ok {
				children[name] = &DirEntry{Name: name, IsDir: true}
			}
			continue
		}
		size := int64(0)
		if data, ok, _ := q.ws.Get(ctx, ns, p); ok {
			size = int64(len(data))
		}
		children[rest] = &DirEntry{Name: rest, IsDir: false, Size: size}
	}
	if !found {
		return nil, ErrNotExist
	}
	names := make([]string, 0, len(children))
	for name := range children {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]DirEntry, 0, len(names))
	for _, name := range names {
		out = append(out, *children[name])
	}
	return out, nil
}

func (q *QueuedStorage) Walk(ctx context.Context, ns, root string, fn WalkFunc) error {
	list, err := q.ws.List(ctx, ns)
	if err != nil {
		return err
	}
	nodes, ok := walkNodes(list, root)
	if !ok {
		return ErrNotExist
	}
	skipped := "" // prefix of a directory whose descendants are being skipped
	for _, n := range nodes {
		if skipped != "" && strings.HasPrefix(n.path, skipped) {
			continue
		}
		skipped = ""
		info := FileInfo{Name: n.name, IsDir: n.isDir}
		if !n.isDir {
			if data, ok, _ := q.ws.Get(ctx, ns, n.path); ok {
				info.Size = int64(len(data))
			}
		}
		werr := fn(n.label, info)
		if werr == SkipDir {
			if n.isDir {
				skipped = n.path + "/"
			}
			continue
		}
		if werr != nil {
			return werr
		}
	}
	return nil
}

// --- mutations: publish to the working set, then enqueue for the writer ---
//
// The bytes are durable once the writer applies them; enqueue failures surface
// to the caller (unlike the best-effort working-set updates) because the queue
// is the only durability path for an app replica.

func (q *QueuedStorage) WriteFile(ctx context.Context, ns, relPath string, data []byte) error {
	q.cache(ctx, ns, relPath, data)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: ns, Path: relPath, Data: data})
}

func (q *QueuedStorage) WriteFrom(ctx context.Context, ns, relPath string, r io.Reader, size int64) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	q.cache(ctx, ns, relPath, data)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: ns, Path: relPath, Data: data})
}

func (q *QueuedStorage) Append(ctx context.Context, ns, relPath string, data []byte) error {
	cur, _, _ := q.ws.Get(ctx, ns, relPath) // append to the latest body (working set is authoritative)
	full := make([]byte, 0, len(cur)+len(data))
	full = append(full, cur...)
	full = append(full, data...)
	q.cache(ctx, ns, relPath, full)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpWrite, NS: ns, Path: relPath, Data: full})
}

func (q *QueuedStorage) MkdirAll(ctx context.Context, ns, relPath string) error {
	// Only the namespace is materialised (empty sub-dirs are not represented, as
	// in git). Register it so an empty workspace is still listed.
	_ = q.ws.AddNamespace(ctx, ns)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpMkdir, NS: ns, Path: relPath})
}

func (q *QueuedStorage) Remove(ctx context.Context, ns, relPath string) error {
	_ = q.ws.Delete(ctx, ns, relPath)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpRemove, NS: ns, Path: relPath})
}

func (q *QueuedStorage) RemoveAll(ctx context.Context, ns, relPath string) error {
	if relPath == "" {
		_ = q.ws.RemoveNamespace(ctx, ns)
	} else {
		_ = q.ws.DeletePrefix(ctx, ns, relPath)
	}
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpRemoveAll, NS: ns, Path: relPath})
}

func (q *QueuedStorage) Rename(ctx context.Context, ns, from, to string) error {
	if data, ok, err := q.ws.Get(ctx, ns, from); err == nil && ok {
		_ = q.ws.Set(ctx, ns, to, data)
	}
	_ = q.ws.DeletePrefix(ctx, ns, from)
	return q.queue.Enqueue(ctx, DurabilityOp{Kind: OpRename, NS: ns, Path: from, To: to})
}

// cache publishes a body to the working set, dropping the key when it exceeds
// the cap so oversize/binary payloads are not held in Redis.
func (q *QueuedStorage) cache(ctx context.Context, ns, relPath string, data []byte) {
	if int64(len(data)) <= q.maxBytes {
		_ = q.ws.Set(ctx, ns, relPath, data)
	} else {
		_ = q.ws.Delete(ctx, ns, relPath)
	}
}

// pathBase returns the last slash-separated element of a namespace-relative path.
func pathBase(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// walkNode is one entry produced by walkNodes.
type walkNode struct {
	path  string // full namespace-relative path ("" for the namespace root)
	label string // path as reported to the WalkFunc ("." for the root)
	name  string // base name
	isDir bool
}

// walkNodes turns a flat list of file paths into the ordered set of directory
// and file nodes under root, mirroring filepath.Walk order (a parent before its
// contents). The bool is false when root does not exist.
func walkNodes(list []string, root string) ([]walkNode, bool) {
	prefix := ""
	if root != "" {
		prefix = root + "/"
	}
	isDir := map[string]bool{}
	exists := root == ""
	for _, p := range list {
		if root != "" {
			if p == root {
				return nil, false // root is a file, not a directory
			}
			if !strings.HasPrefix(p, prefix) {
				continue
			}
		}
		exists = true
		rel := p[len(prefix):]
		segs := strings.Split(rel, "/")
		cur := root
		for i := 0; i < len(segs)-1; i++ {
			if cur == "" {
				cur = segs[i]
			} else {
				cur += "/" + segs[i]
			}
			isDir[cur] = true
		}
		if _, ok := isDir[p]; !ok {
			isDir[p] = false
		}
	}
	if !exists {
		return nil, false
	}
	paths := make([]string, 0, len(isDir))
	for p := range isDir {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	nodes := make([]walkNode, 0, len(paths)+1)
	// The root directory is visited first.
	rootLabel := root
	rootName := pathBase(root)
	if root == "" {
		rootLabel, rootName = ".", "."
	}
	nodes = append(nodes, walkNode{path: root, label: rootLabel, name: rootName, isDir: true})
	for _, p := range paths {
		nodes = append(nodes, walkNode{path: p, label: p, name: pathBase(p), isDir: isDir[p]})
	}
	return nodes, true
}
