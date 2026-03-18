package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

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
