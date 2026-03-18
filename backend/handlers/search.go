package handlers

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type SearchHandler struct {
	notesDir string
}

type SearchResult struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Snippet string `json:"snippet"`
}

func NewSearchHandler(notesDir string) *SearchHandler {
	return &SearchHandler{notesDir: notesDir}
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

	// Collect all .md files
	var files []string
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
				files = append(files, rel)
			}
		}
		return nil
	})

	// Search files concurrently, cap at 30 results
	const maxResults = 30
	var mu sync.Mutex
	var results []SearchResult
	done := make(chan struct{})

	var wg sync.WaitGroup
	// Limit concurrency
	sem := make(chan struct{}, 8)

	for _, relPath := range files {
		mu.Lock()
		if len(results) >= maxResults {
			mu.Unlock()
			break
		}
		mu.Unlock()

		wg.Add(1)
		sem <- struct{}{}
		go func(rp string) {
			defer wg.Done()
			defer func() { <-sem }()

			absPath := filepath.Join(nsDir, rp)
			f, err := os.Open(absPath)
			if err != nil {
				return
			}
			defer f.Close()

			scanner := bufio.NewScanner(f)
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
					if len(results) < maxResults {
						results = append(results, SearchResult{
							Path:    rp,
							Line:    lineNum,
							Snippet: snippet,
						})
					}
					mu.Unlock()

					if len(results) >= maxResults {
						return
					}
				}
			}
		}(relPath)
	}

	go func() {
		wg.Wait()
		close(done)
	}()
	<-done

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}
