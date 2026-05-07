// Package updates polls the GitHub releases API for mdnest's latest tag and
// caches the result so /api/config can include an "update available" hint
// without making the frontend talk to GitHub on every page load. One HTTP
// request per server per 24h is the entire footprint.
package updates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	defaultRepo    = "mahsanamin/mdnest"
	checkInterval  = 24 * time.Hour
	requestTimeout = 10 * time.Second
	// Wait this long before the first check so a transient network blip at
	// boot doesn't show up in the logs as the first thing the operator sees.
	firstCheckDelay = 30 * time.Second
)

// Status is the snapshot the config endpoint exposes. CheckedAt is zero if a
// check has never succeeded — the frontend should treat that as "unknown,
// don't render a banner."
type Status struct {
	LatestVersion string    `json:"latestVersion,omitempty"`
	ReleaseURL    string    `json:"releaseUrl,omitempty"`
	CheckedAt     time.Time `json:"checkedAt,omitempty"`
}

// Checker holds the cached status and runs a background poll. Safe for
// concurrent reads via Status().
type Checker struct {
	repo   string
	client *http.Client

	mu     sync.RWMutex
	status Status
}

// New builds a checker for the given GitHub repo (e.g. "owner/name"). Empty
// repo falls back to the default mdnest repo.
func New(repo string) *Checker {
	if repo == "" {
		repo = defaultRepo
	}
	return &Checker{
		repo:   repo,
		client: &http.Client{Timeout: requestTimeout},
	}
}

// Status returns the most recent cached release info. Zero-value status
// (CheckedAt zero) means no successful check has happened yet.
func (c *Checker) Status() Status {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.status
}

// Start kicks off the background polling goroutine. It runs the first check
// after firstCheckDelay so a flaky network at boot doesn't dominate the log,
// then re-checks every checkInterval. ctx cancellation stops the goroutine.
func (c *Checker) Start(ctx context.Context) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(firstCheckDelay):
		}
		for {
			if err := c.checkOnce(ctx); err != nil {
				// Logged at info level — failure is expected on offline /
				// air-gapped installs and shouldn't pollute error logs.
				log.Printf("update check skipped: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(checkInterval):
			}
		}
	}()
}

func (c *Checker) checkOnce(ctx context.Context) error {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", c.repo)
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "mdnest-update-checker")

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d from %s", resp.StatusCode, url)
	}

	var release struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Draft   bool   `json:"draft"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return err
	}
	if release.Draft {
		return errors.New("latest release is a draft")
	}
	version := strings.TrimPrefix(strings.TrimSpace(release.TagName), "v")
	if version == "" {
		return errors.New("release has no tag_name")
	}

	c.mu.Lock()
	c.status = Status{
		LatestVersion: version,
		ReleaseURL:    release.HTMLURL,
		CheckedAt:     time.Now().UTC(),
	}
	c.mu.Unlock()
	return nil
}
