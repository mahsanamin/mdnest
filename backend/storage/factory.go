package storage

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// FromEnv constructs a Storage backend from environment variables.
//
//	STORAGE_BACKEND   local (default)
//
// localRoot is the absolute NOTES_DIR used by the local backend. Only the
// filesystem-backed "local" backend exists today; the switch leaves room for
// additional backends to be added behind the same flag without touching call
// sites.
func FromEnv(ctx context.Context, localRoot string) (Storage, error) {
	backend := strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")))
	switch backend {
	case "", "local":
		return NewLocalStorage(localRoot)
	default:
		return nil, fmt.Errorf("storage: unknown STORAGE_BACKEND %q (want local)", backend)
	}
}
