package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sort"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Storage persists notes in an S3-compatible object store. A namespace
// maps to a top-level key prefix ("<ns>/") inside a single bucket and a
// note maps to an object ("<ns>/<relPath>"). Because object stores have no
// real directories, empty namespaces and folders are represented by a
// zero-byte "directory marker" object whose key ends in "/".
//
// This backend lets the API run with multiple replicas (no ReadWriteMany
// PVC). Git-backed history and sync are unavailable in this mode; those
// handlers degrade gracefully because no .git directory is present.
type S3Storage struct {
	client *minio.Client
	bucket string
}

// S3Config holds the connection settings for the S3 backend.
type S3Config struct {
	Endpoint  string // host:port, no scheme
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	UseSSL    bool
	PathStyle bool // force path-style addressing (Ceph/RGW, MinIO)
}

// NewS3Storage connects to the object store and ensures the bucket exists.
func NewS3Storage(ctx context.Context, cfg S3Config) (*S3Storage, error) {
	lookup := minio.BucketLookupAuto
	if cfg.PathStyle {
		lookup = minio.BucketLookupPath
	}
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       cfg.UseSSL,
		Region:       cfg.Region,
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, err
	}
	s := &S3Storage{client: client, bucket: cfg.Bucket}
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, err
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *S3Storage) Kind() string { return "s3" }

// objKey returns the object key for a namespace-relative file path.
func objKey(ns, relPath string) string {
	if relPath == "" {
		return ns + "/"
	}
	return ns + "/" + strings.TrimPrefix(relPath, "/")
}

// dirPrefix returns the listing prefix for a namespace-relative directory
// (always ending in "/").
func dirPrefix(ns, relPath string) string {
	relPath = strings.Trim(relPath, "/")
	if relPath == "" {
		return ns + "/"
	}
	return ns + "/" + relPath + "/"
}

func isNoSuchKey(err error) bool {
	if err == nil {
		return false
	}
	resp := minio.ToErrorResponse(err)
	return resp.Code == "NoSuchKey" || resp.Code == "NoSuchBucket" || resp.StatusCode == 404
}

func (s *S3Storage) ListNamespaces(ctx context.Context) ([]string, error) {
	seen := map[string]struct{}{}
	for oi := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Recursive: false}) {
		if oi.Err != nil {
			return nil, oi.Err
		}
		name := strings.TrimSuffix(oi.Key, "/")
		if name == "" || strings.HasPrefix(name, ".") || strings.Contains(name, "/") {
			continue
		}
		seen[name] = struct{}{}
	}
	names := make([]string, 0, len(seen))
	for n := range seen {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

func (s *S3Storage) NamespaceExists(ctx context.Context, ns string) (bool, error) {
	prefix := ns + "/"
	for oi := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true, MaxKeys: 1}) {
		if oi.Err != nil {
			return false, oi.Err
		}
		return true, nil
	}
	return false, nil
}

func (s *S3Storage) CreateNamespace(ctx context.Context, ns string) error {
	exists, err := s.NamespaceExists(ctx, ns)
	if err != nil {
		return err
	}
	if exists {
		return ErrExist
	}
	return s.putMarker(ctx, ns+"/")
}

func (s *S3Storage) putMarker(ctx context.Context, key string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(nil), 0, minio.PutObjectOptions{})
	return err
}

func (s *S3Storage) ReadFile(ctx context.Context, ns, relPath string) ([]byte, error) {
	rc, err := s.Open(ctx, ns, relPath)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

func (s *S3Storage) Open(ctx context.Context, ns, relPath string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, objKey(ns, relPath), minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// GetObject is lazy; force a stat so a missing object surfaces now as
	// ErrNotExist instead of on first Read.
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		if isNoSuchKey(err) {
			return nil, ErrNotExist
		}
		return nil, err
	}
	return obj, nil
}

func (s *S3Storage) WriteFile(ctx context.Context, ns, relPath string, data []byte) error {
	_, err := s.client.PutObject(ctx, s.bucket, objKey(ns, relPath), bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: "text/markdown"})
	return err
}

func (s *S3Storage) WriteFrom(ctx context.Context, ns, relPath string, r io.Reader, size int64) error {
	_, err := s.client.PutObject(ctx, s.bucket, objKey(ns, relPath), r, size, minio.PutObjectOptions{})
	return err
}

func (s *S3Storage) Append(ctx context.Context, ns, relPath string, data []byte) error {
	existing, err := s.ReadFile(ctx, ns, relPath)
	if err != nil && !errors.Is(err, ErrNotExist) {
		return err
	}
	return s.WriteFile(ctx, ns, relPath, append(existing, data...))
}

func (s *S3Storage) Stat(ctx context.Context, ns, relPath string) (FileInfo, error) {
	oi, err := s.client.StatObject(ctx, s.bucket, objKey(ns, relPath), minio.StatObjectOptions{})
	if err == nil {
		return FileInfo{
			Name:    baseName(relPath),
			Size:    oi.Size,
			IsDir:   false,
			ModTime: oi.LastModified,
		}, nil
	}
	if !isNoSuchKey(err) {
		return FileInfo{}, err
	}
	// Not a file — maybe a directory prefix with children.
	prefix := dirPrefix(ns, relPath)
	for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true, MaxKeys: 1}) {
		if o.Err != nil {
			return FileInfo{}, o.Err
		}
		return FileInfo{Name: baseName(relPath), IsDir: true}, nil
	}
	return FileInfo{}, ErrNotExist
}

func (s *S3Storage) MkdirAll(ctx context.Context, ns, relPath string) error {
	if strings.Trim(relPath, "/") == "" {
		return nil
	}
	return s.putMarker(ctx, dirPrefix(ns, relPath))
}

func (s *S3Storage) Remove(ctx context.Context, ns, relPath string) error {
	return s.client.RemoveObject(ctx, s.bucket, objKey(ns, relPath), minio.RemoveObjectOptions{})
}

func (s *S3Storage) RemoveAll(ctx context.Context, ns, relPath string) error {
	// Delete the object itself (file case) and everything under its prefix
	// (directory case).
	_ = s.client.RemoveObject(ctx, s.bucket, objKey(ns, relPath), minio.RemoveObjectOptions{})
	prefix := dirPrefix(ns, relPath)
	objectsCh := make(chan minio.ObjectInfo)
	go func() {
		defer close(objectsCh)
		for oi := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if oi.Err != nil {
				continue
			}
			objectsCh <- oi
		}
	}()
	for rerr := range s.client.RemoveObjects(ctx, s.bucket, objectsCh, minio.RemoveObjectsOptions{}) {
		if rerr.Err != nil {
			return rerr.Err
		}
	}
	return nil
}

func (s *S3Storage) Rename(ctx context.Context, ns, from, to string) error {
	// File case: copy the single object then delete the source.
	if _, err := s.client.StatObject(ctx, s.bucket, objKey(ns, from), minio.StatObjectOptions{}); err == nil {
		if err := s.copy(ctx, objKey(ns, from), objKey(ns, to)); err != nil {
			return err
		}
		return s.client.RemoveObject(ctx, s.bucket, objKey(ns, from), minio.RemoveObjectOptions{})
	} else if !isNoSuchKey(err) {
		return err
	}
	// Directory case: copy every object under the source prefix, then
	// remove the whole source tree.
	srcPrefix := dirPrefix(ns, from)
	dstPrefix := dirPrefix(ns, to)
	found := false
	for oi := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: srcPrefix, Recursive: true}) {
		if oi.Err != nil {
			return oi.Err
		}
		found = true
		dstKey := dstPrefix + strings.TrimPrefix(oi.Key, srcPrefix)
		if err := s.copy(ctx, oi.Key, dstKey); err != nil {
			return err
		}
	}
	if !found {
		return ErrNotExist
	}
	return s.RemoveAll(ctx, ns, from)
}

func (s *S3Storage) copy(ctx context.Context, srcKey, dstKey string) error {
	_, err := s.client.CopyObject(ctx,
		minio.CopyDestOptions{Bucket: s.bucket, Object: dstKey},
		minio.CopySrcOptions{Bucket: s.bucket, Object: srcKey},
	)
	return err
}

func (s *S3Storage) ReadDir(ctx context.Context, ns, relPath string) ([]DirEntry, error) {
	prefix := dirPrefix(ns, relPath)
	type ent struct {
		isDir bool
		size  int64
	}
	entries := map[string]ent{}
	any := false
	for oi := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: false}) {
		if oi.Err != nil {
			return nil, oi.Err
		}
		any = true
		if oi.Key == prefix {
			continue // the directory marker itself
		}
		name := strings.TrimPrefix(oi.Key, prefix)
		if strings.HasSuffix(name, "/") {
			entries[strings.TrimSuffix(name, "/")] = ent{isDir: true}
		} else if name != "" {
			entries[name] = ent{size: oi.Size}
		}
	}
	if !any {
		return nil, ErrNotExist
	}
	out := make([]DirEntry, 0, len(entries))
	for name, e := range entries {
		if name == "" {
			continue
		}
		out = append(out, DirEntry{Name: name, IsDir: e.isDir, Size: e.size})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *S3Storage) Walk(ctx context.Context, ns, root string, fn WalkFunc) error {
	info, err := s.Stat(ctx, ns, root)
	if err != nil {
		return err
	}
	return s.walk(ctx, ns, strings.Trim(root, "/"), info, fn)
}

func (s *S3Storage) walk(ctx context.Context, ns, rel string, info FileInfo, fn WalkFunc) error {
	if !info.IsDir {
		return fn(rel, info)
	}
	if err := fn(rel, info); err != nil {
		if err == SkipDir {
			return nil
		}
		return err
	}
	children, err := s.ReadDir(ctx, ns, rel)
	if err != nil {
		if errors.Is(err, ErrNotExist) {
			return nil
		}
		return err
	}
	for _, c := range children {
		childRel := c.Name
		if rel != "" {
			childRel = rel + "/" + c.Name
		}
		childInfo, err := s.Stat(ctx, ns, childRel)
		if err != nil {
			if errors.Is(err, ErrNotExist) {
				continue
			}
			return err
		}
		if err := s.walk(ctx, ns, childRel, childInfo, fn); err != nil {
			return err
		}
	}
	return nil
}

func baseName(relPath string) string {
	relPath = strings.TrimSuffix(relPath, "/")
	if i := strings.LastIndex(relPath, "/"); i >= 0 {
		return relPath[i+1:]
	}
	return relPath
}
