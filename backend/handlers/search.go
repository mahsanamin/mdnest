package handlers

import (
	"bufio"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// SearchConfig holds tunable search parameters.
type SearchConfig struct {
	MaxResults  int   // Max results to return (default 30)
	MaxFileSize int64 // Skip files larger than this in bytes (default 1MB)
	Workers     int   // Concurrent file readers (default 8)
	CacheTTL    time.Duration // How long the file list cache lives (default 30s)
}

// fileEntry is a cached file path + size.
type fileEntry struct {
	relPath string
	size    int64
}

// nsCache caches the file list for a namespace.
type nsCache struct {
	files   []fileEntry
	built   time.Time
	mu      sync.Mutex
}

type SearchHandler struct {
	notesDir string
	config   SearchConfig
	caches   sync.Map // namespace -> *nsCache
}

type SearchResult struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Snippet string `json:"snippet"`
}

func NewSearchHandler(notesDir string) *SearchHandler {
	maxResults := envInt("SEARCH_MAX_RESULTS", 30)
	maxFileSize := envInt64("SEARCH_MAX_FILE_SIZE", 1<<20) // 1MB
	workers := envInt("SEARCH_WORKERS", 8)
	cacheTTL := envInt("SEARCH_CACHE_TTL", 30)

	cfg := SearchConfig{
		MaxResults:  maxResults,
		MaxFileSize: maxFileSize,
		Workers:     workers,
		CacheTTL:    time.Duration(cacheTTL) * time.Second,
	}

	log.Printf("search config: max_results=%d, max_file_size=%d, workers=%d, cache_ttl=%s",
		cfg.MaxResults, cfg.MaxFileSize, cfg.Workers, cfg.CacheTTL)

	return &SearchHandler{notesDir: notesDir, config: cfg}
}

// getFiles returns a cached or freshly-built file list for a namespace.
func (h *SearchHandler) getFiles(nsDir string) []fileEntry {
	ns := filepath.Base(nsDir)

	val, _ := h.caches.LoadOrStore(ns, &nsCache{})
	cache := val.(*nsCache)

	cache.mu.Lock()
	defer cache.mu.Unlock()

	if time.Since(cache.built) < h.config.CacheTTL && len(cache.files) > 0 {
		return cache.files
	}

	var files []fileEntry
	filepath.Walk(nsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() && strings.HasPrefix(info.Name(), ".") {
			return filepath.SkipDir
		}
		if !info.IsDir() && strings.HasSuffix(strings.ToLower(info.Name()), ".md") {
			rel, err := filepath.Rel(nsDir, path)
			if err == nil {
				files = append(files, fileEntry{relPath: rel, size: info.Size()})
			}
		}
		return nil
	})

	cache.files = files
	cache.built = time.Now()
	return files
}

// InvalidateCache clears the file list cache for a namespace.
// Called after write/create/delete/move operations.
func (h *SearchHandler) InvalidateCache(ns string) {
	h.caches.Delete(ns)
}

// HandleSearch handles GET /api/search?ns=...&q=...
func (h *SearchHandler) HandleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}

	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if query == "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]SearchResult{})
		return
	}

	files := h.getFiles(nsDir)

	// Phase 1: filename matches (instant, no file I/O)
	var results []SearchResult
	for _, f := range files {
		if strings.Contains(strings.ToLower(f.relPath), query) {
			results = append(results, SearchResult{
				Path:    f.relPath,
				Line:    0,
				Snippet: "filename match",
			})
			if len(results) >= h.config.MaxResults {
				break
			}
		}
	}

	// Phase 2: content search (parallel file reads)
	if len(results) < h.config.MaxResults {
		// Track which files already matched by filename so we don't double-report
		matched := make(map[string]bool, len(results))
		for _, r := range results {
			matched[r.path()] = true
		}
		// Use a separate slice to avoid lock contention with phase 1 results
		var contentResults []SearchResult
		var mu sync.Mutex
		var hitLimit int32

		sem := make(chan struct{}, h.config.Workers)
		var wg sync.WaitGroup
		remaining := h.config.MaxResults - len(results)

		for _, f := range files {
			if atomic.LoadInt32(&hitLimit) > 0 {
				break
			}
			// Skip files too large
			if f.size > h.config.MaxFileSize {
				continue
			}

			wg.Add(1)
			sem <- struct{}{}
			go func(fe fileEntry) {
				defer wg.Done()
				defer func() { <-sem }()

				if atomic.LoadInt32(&hitLimit) > 0 {
					return
				}

				absPath := filepath.Join(nsDir, fe.relPath)
				file, err := os.Open(absPath)
				if err != nil {
					return
				}
				defer file.Close()

				scanner := bufio.NewScanner(file)
				lineNum := 0
				for scanner.Scan() {
					lineNum++
					line := scanner.Text()
					if strings.Contains(strings.ToLower(line), query) {
						snippet := line
						if len(snippet) > 200 {
							snippet = snippet[:200] + "..."
						}

						mu.Lock()
						if len(contentResults) < remaining {
							contentResults = append(contentResults, SearchResult{
								Path:    fe.relPath,
								Line:    lineNum,
								Snippet: snippet,
							})
						}
						if len(contentResults) >= remaining {
							atomic.StoreInt32(&hitLimit, 1)
						}
						mu.Unlock()

						if atomic.LoadInt32(&hitLimit) > 0 {
							return
						}
					}
				}
			}(f)
		}

		wg.Wait()
		results = append(results, contentResults...)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

// helper: read field from SearchResult (avoid exporting path)
func (r SearchResult) path() string { return r.Path }

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envInt64(key string, fallback int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}
