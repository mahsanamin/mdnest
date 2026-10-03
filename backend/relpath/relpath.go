// Package relpath holds the one lexical rule for namespace-relative paths.
// It has no imports from the rest of the backend so that both the permission
// middleware and the handlers can use it: the middleware must authorise the
// exact path a handler will act on, and two copies of this rule drift.
package relpath

import (
	"path/filepath"
	"strings"
)

// Clean validates a namespace-relative request path lexically and returns it
// cleaned with forward-slash separators. It returns ("", false) if the path is
// empty, absolute or escapes the namespace. It does no filesystem access.
func Clean(reqPath string) (string, bool) {
	if reqPath == "" {
		return "", false
	}
	cleaned := filepath.ToSlash(filepath.Clean(reqPath))
	if strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "..") || cleaned == "." {
		return "", false
	}
	return cleaned, true
}
