package handlers

import (
	"testing"

	"github.com/mdnest/mdnest/backend/store"
)

// fakeTokenStore is an in-memory store.TokenStore for handler tests.
type fakeTokenStore struct {
	tokens []store.APIToken
}

func (f *fakeTokenStore) Add(t store.APIToken) error {
	f.tokens = append(f.tokens, t)
	return nil
}

func (f *fakeTokenStore) All() ([]store.APIToken, error) {
	out := make([]store.APIToken, len(f.tokens))
	copy(out, f.tokens)
	return out, nil
}

func (f *fakeTokenStore) FindByHash(hash string) (*store.APIToken, error) {
	for i := range f.tokens {
		if f.tokens[i].TokenHash == hash {
			cp := f.tokens[i]
			return &cp, nil
		}
	}
	return nil, nil
}

func (f *fakeTokenStore) DeleteByID(id string) (bool, error) {
	for i := range f.tokens {
		if f.tokens[i].ID == id {
			f.tokens = append(f.tokens[:i], f.tokens[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

// The middleware validates and resolves API tokens through the handler, so the
// hash lookup and the multi-mode user binding must both work regardless of the
// backend (file or Postgres).
func TestTokenHandler_ValidateAndResolve(t *testing.T) {
	h := NewTokenHandler(&fakeTokenStore{})

	raw, _, err := h.CreateAPIToken("ci", 7, "alice", "collaborator")
	if err != nil {
		t.Fatal(err)
	}

	if !h.ValidateAPIToken(raw) {
		t.Error("a freshly minted token was rejected")
	}
	if h.ValidateAPIToken("mdnest_bogus") {
		t.Error("a bogus token was accepted")
	}

	uc := h.ResolveAPITokenUser(raw)
	if uc == nil || uc.ID != 7 || uc.Username != "alice" || uc.Role != "collaborator" {
		t.Errorf("ResolveAPITokenUser = %+v, want id=7 alice/collaborator", uc)
	}

	// A single-mode / legacy token (UserID 0) has no user binding and must
	// resolve to nil so the middleware falls back to single-mode handling.
	rawLegacy, _, err := h.CreateAPIToken("legacy", 0, "admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if uc := h.ResolveAPITokenUser(rawLegacy); uc != nil {
		t.Errorf("legacy token (UserID 0) resolved to %+v, want nil", uc)
	}
}
