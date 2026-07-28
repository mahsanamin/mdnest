package storage

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// FromEnv constructs a Storage backend from environment variables.
//
//	STORAGE_BACKEND   local (default) | s3
//
// When STORAGE_BACKEND=s3 the following are read:
//
//	S3_ENDPOINT       host:port (no scheme), required
//	S3_BUCKET         bucket name, required
//	S3_ACCESS_KEY     access key id, required
//	S3_SECRET_KEY     secret access key, required
//	S3_REGION         region (default "us-east-1")
//	S3_USE_SSL        "true"/"false" (default true)
//	S3_PATH_STYLE     "true"/"false" (default true; needed for MinIO/Ceph)
//
// localRoot is the absolute NOTES_DIR used by the local backend.
func FromEnv(ctx context.Context, localRoot string) (Storage, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	switch backend {
	case "", "local":
		return NewLocalStorage(localRoot)
	case "s3":
		cfg := S3Config{
			Endpoint:  os.Getenv("S3_ENDPOINT"),
			Region:    envOr("S3_REGION", "us-east-1"),
			Bucket:    os.Getenv("S3_BUCKET"),
			AccessKey: os.Getenv("S3_ACCESS_KEY"),
			SecretKey: os.Getenv("S3_SECRET_KEY"),
			UseSSL:    envBool("S3_USE_SSL", true),
			PathStyle: envBool("S3_PATH_STYLE", true),
		}
		if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
			return nil, fmt.Errorf("storage: STORAGE_BACKEND=s3 requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY")
		}
		return NewS3Storage(ctx, cfg)
	default:
		return nil, fmt.Errorf("storage: unknown STORAGE_BACKEND %q (want local or s3)", backend)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch v {
	case "":
		return def
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
