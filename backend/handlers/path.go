package handlers

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/mdnest/mdnest/backend/storage"
)

// ValidNamespaceName reports whether ns is a syntactically valid namespace
// name: a single path segment with no separators, no traversal and no
// leading dot. It performs no filesystem access.
func ValidNamespaceName(ns string) bool {
	if ns == "" {
		return false
	}
	cleaned := filepath.Clean(ns)
	if cleaned != ns || strings.Contains(ns, "/") || strings.Contains(ns, "\\") || strings.HasPrefix(ns, ".") {
		return false
	}
	return true
}

// SafeRelPath validates a namespace-relative request path lexically and
// returns it cleaned with forward-slash separators. It returns ("", false)
// if the path is empty, absolute or attempts traversal. Unlike SafePath it
// does no filesystem access, so it is valid for object-store backends too.
func SafeRelPath(reqPath string) (string, bool) {
	if reqPath == "" {
		return "", false
	}
	cleaned := filepath.ToSlash(filepath.Clean(reqPath))
	if strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "..") || cleaned == "." {
		return "", false
	}
	return cleaned, true
}

// RequireNamespaceStore extracts and validates the "ns" query parameter
// and confirms the namespace exists in the storage backend. It returns the
// namespace name, or "" after writing an error response.
func RequireNamespaceStore(ctx context.Context, stg storage.Storage, w http.ResponseWriter, r *http.Request) string {
	ns := r.URL.Query().Get("ns")
	if ns == "" {
		http.Error(w, `{"error":"ns parameter is required"}`, http.StatusBadRequest)
		return ""
	}
	if !ValidNamespaceName(ns) {
		http.Error(w, `{"error":"invalid namespace"}`, http.StatusBadRequest)
		return ""
	}
	exists, err := stg.NamespaceExists(ctx, ns)
	if err != nil {
		http.Error(w, `{"error":"failed to check namespace"}`, http.StatusInternalServerError)
		return ""
	}
	if !exists {
		http.Error(w, `{"error":"namespace not found"}`, http.StatusNotFound)
		return ""
	}
	return ns
}

// SafePath resolves and validates the requested path is inside baseDir.
// Returns the resolved absolute path or an empty string if invalid.
func SafePath(baseDir, reqPath string) string {
	if reqPath == "" {
		return ""
	}

	cleaned := filepath.Clean(reqPath)
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, "..") {
		return ""
	}

	target := filepath.Join(baseDir, cleaned)

	resolved, err := filepath.EvalSymlinks(filepath.Dir(target))
	if err != nil {
		check := target
		for {
			parent := filepath.Dir(check)
			if parent == check {
				break
			}
			real, err := filepath.EvalSymlinks(parent)
			if err == nil {
				baseReal, err2 := filepath.EvalSymlinks(baseDir)
				if err2 != nil {
					return ""
				}
				if !strings.HasPrefix(real+string(filepath.Separator), baseReal+string(filepath.Separator)) && real != baseReal {
					return ""
				}
				return target
			}
			check = parent
		}
		return ""
	}

	fullResolved := filepath.Join(resolved, filepath.Base(target))

	baseReal, err := filepath.EvalSymlinks(baseDir)
	if err != nil {
		return ""
	}

	if !strings.HasPrefix(fullResolved+string(filepath.Separator), baseReal+string(filepath.Separator)) && fullResolved != baseReal {
		return ""
	}

	return target
}

// RequireNamespace extracts and validates the "ns" query parameter.
// A namespace is a top-level directory inside notesDir (created at mount time).
// Returns the namespace base directory or writes an error and returns "".
func RequireNamespace(notesDir string, w http.ResponseWriter, r *http.Request) string {
	ns := r.URL.Query().Get("ns")
	if ns == "" {
		http.Error(w, `{"error":"ns parameter is required"}`, http.StatusBadRequest)
		return ""
	}

	// Namespace must be a simple name — no slashes, no dots, no traversal
	cleaned := filepath.Clean(ns)
	if cleaned != ns || strings.Contains(ns, "/") || strings.Contains(ns, "\\") || strings.HasPrefix(ns, ".") {
		http.Error(w, `{"error":"invalid namespace"}`, http.StatusBadRequest)
		return ""
	}

	nsDir := filepath.Join(notesDir, ns)
	info, err := os.Stat(nsDir)
	if err != nil || !info.IsDir() {
		http.Error(w, `{"error":"namespace not found"}`, http.StatusNotFound)
		return ""
	}

	return nsDir
}
