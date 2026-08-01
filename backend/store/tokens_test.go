package store

import (
	"os"
	"path/filepath"
	"testing"
)

// TestFileTokenStore_RoundTripAndReload covers the single-mode file backend,
// including the cache-miss reload that must pick up tokens minted by the
// one-shot `mdnest-server create-token` CLI in a separate process.
func TestFileTokenStore_RoundTripAndReload(t *testing.T) {
	dir := t.TempDir()
	s := NewFileTokenStore(dir)

	tok := APIToken{ID: "a1", Name: "ci", TokenHash: "hashA", TokenSuffix: "aaaa", CreatedAt: "2026-01-01T00:00:00Z", UserID: 7, Username: "alice", UserRole: "collaborator"}
	if err := s.Add(tok); err != nil {
		t.Fatal(err)
	}

	got, err := s.FindByHash("hashA")
	if err != nil || got == nil || got.ID != "a1" || got.UserID != 7 {
		t.Fatalf("FindByHash: got=%v err=%v", got, err)
	}
	if miss, _ := s.FindByHash("nope"); miss != nil {
		t.Fatalf("FindByHash(nope) should be nil, got %v", miss)
	}

	if data, _ := os.ReadFile(filepath.Join(dir, "tokens.json")); len(data) == 0 {
		t.Fatal("tokens.json was not written")
	}

	// A second store over the same dir simulates the CLI writing while the
	// server runs. The first store must find a token added by the second one
	// after its cache misses and triggers a reload.
	s2 := NewFileTokenStore(dir)
	extra := APIToken{ID: "b2", Name: "cli", TokenHash: "hashB", TokenSuffix: "bbbb", CreatedAt: "2026-01-02T00:00:00Z"}
	if err := s2.Add(extra); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.FindByHash("hashB"); got == nil {
		t.Fatal("cache-miss reload did not pick up the CLI-minted token")
	}

	removed, err := s.DeleteByID("a1")
	if err != nil || !removed {
		t.Fatalf("DeleteByID(a1): removed=%v err=%v", removed, err)
	}
	if got, _ := s.FindByHash("hashA"); got != nil {
		t.Fatal("token still present after delete")
	}
	if removed, _ := s.DeleteByID("missing"); removed {
		t.Fatal("DeleteByID(missing) reported a removal")
	}
}
