package handlers

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// A personal namespace with no active backup must stay local-only. If this
// returned ok=false with no error instead, the git writer would fall back to
// GIT_REMOTE_URL and push someone's private notes into the shared repository
// group, which cannot be taken back.
func TestWorkspaceRemoteResolver(t *testing.T) {
	rows := map[string]*store.WorkspaceRemote{
		"team": {Transport: "https", RemoteURL: "https://git.example/team.git", Branch: "main"},
	}
	r := WorkspaceRemoteResolver(func(ns string) (*store.WorkspaceRemote, error) { return rows[ns], nil })

	if _, ok, err := r.ResolveRemote("jane@example.com"); ok || !errors.Is(err, storage.ErrLocalOnly) {
		t.Fatalf("personal namespace without a backup: ok=%v err=%v, want ok=false and ErrLocalOnly", ok, err)
	}
	if _, ok, err := r.ResolveRemote("notes"); ok || err != nil {
		t.Fatalf("team namespace without a row: ok=%v err=%v, want the env default (ok=false, nil)", ok, err)
	}
	spec, ok, err := r.ResolveRemote("team")
	if !ok || err != nil || spec.RemoteURL != "https://git.example/team.git" {
		t.Fatalf("team namespace with a row: spec=%+v ok=%v err=%v", spec, ok, err)
	}

	boom := errors.New("db down")
	failing := WorkspaceRemoteResolver(func(string) (*store.WorkspaceRemote, error) { return nil, boom })
	if _, _, err := failing.ResolveRemote("jane@example.com"); !errors.Is(err, boom) {
		t.Fatalf("lookup error must be returned as is, got %v", err)
	}
}

// The deployment's Git connection is reconciled at boot with the token of that
// moment, sealed in the database. When the deployment rotates the token file
// (a mounted Secret holding a short-lived token), pushes must use the new
// token without a restart; other namespaces keep their own credential.
func TestLiveProvisionedCredential(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	write := func(s string) {
		t.Helper()
		if err := os.WriteFile(tokenFile, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	current := func() string {
		b, _ := os.ReadFile(tokenFile)
		return strings.TrimSpace(string(b))
	}
	rows := map[string]store.WorkspaceRemote{
		"team": {Transport: "https", RemoteURL: "https://git.example/group/team.git", Credential: "sealed-at-boot", Provisioned: true},
		"own":  {Transport: "https", RemoteURL: "https://git.example/own.git", Credential: "own-token"},
	}
	lookup := func(ns string) (*store.WorkspaceRemote, error) {
		r, ok := rows[ns]
		if !ok {
			return nil, nil
		}
		return &r, nil
	}
	r := WorkspaceRemoteResolver(LiveProvisionedCredential(lookup, current))
	credential := func(ns string) string {
		t.Helper()
		spec, ok, err := r.ResolveRemote(ns)
		if !ok || err != nil {
			t.Fatalf("%s: ok=%v err=%v", ns, ok, err)
		}
		return spec.Credential
	}

	write("token-1\n")
	if got := credential("team"); got != "token-1" {
		t.Fatalf("provisioned namespace = %q, want the token file content", got)
	}
	write("token-2")
	if got := credential("team"); got != "token-2" {
		t.Fatalf("after rotation = %q, want the new token without a restart", got)
	}
	write("")
	if got := credential("team"); got != "sealed-at-boot" {
		t.Fatalf("empty token file = %q, want the sealed copy kept", got)
	}
	write("token-3")
	if got := credential("own"); got != "own-token" {
		t.Fatalf("namespace with its own Git backup = %q, want its own credential", got)
	}
	if _, ok, err := r.ResolveRemote("notes"); ok || err != nil {
		t.Fatalf("namespace without a row: ok=%v err=%v, want the env default", ok, err)
	}
	boom := errors.New("db down")
	failing := LiveProvisionedCredential(func(string) (*store.WorkspaceRemote, error) { return nil, boom }, current)
	if _, err := failing("team"); !errors.Is(err, boom) {
		t.Fatalf("lookup error must be returned as is, got %v", err)
	}
}
