package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
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

// --- API token ownership scoping -------------------------------------------
//
// The store layer deliberately does not scope: DeleteByID deletes whatever id
// it is given, and All() returns every token. The ONLY thing standing between
// a collaborator and another user's tokens is the check inside listTokens /
// revokeToken. Nothing pinned that before, so removing both checks left the
// suite green. These tests fail if either check is weakened.

func twoUsersTokens() *fakeTokenStore {
	return &fakeTokenStore{tokens: []store.APIToken{
		{ID: "tok-alice", Name: "alice-cli", TokenHash: "ha", TokenSuffix: "aaaa", UserID: 1},
		{ID: "tok-bob", Name: "bob-cli", TokenHash: "hb", TokenSuffix: "bbbb", UserID: 2},
	}}
}

func tokenReq(h *TokenHandler, method, id string, uc *middleware.UserContext) *httptest.ResponseRecorder {
	target := "/api/auth/tokens"
	if id != "" {
		target += "?id=" + id
	}
	r := httptest.NewRequest(method, target, nil)
	if uc != nil {
		r = middleware.WithUser(r, uc)
	}
	w := httptest.NewRecorder()
	h.HandleTokens(w, r)
	return w
}

func TestTokenListIsScopedToOwner(t *testing.T) {
	h := NewTokenHandler(twoUsersTokens())

	// A collaborator sees only their own token.
	w := tokenReq(h, http.MethodGet, "", &middleware.UserContext{ID: 1, Username: "alice", Role: "collaborator"})
	body := w.Body.String()
	if !strings.Contains(body, "tok-alice") {
		t.Errorf("alice should see her own token, got %s", body)
	}
	if strings.Contains(body, "tok-bob") {
		t.Errorf("alice must NOT see bob's token, got %s", body)
	}

	// A namespace admin is not privileged over tokens either.
	w = tokenReq(h, http.MethodGet, "", &middleware.UserContext{ID: 1, Username: "alice", Role: "admin"})
	if strings.Contains(w.Body.String(), "tok-bob") {
		t.Errorf("a namespace admin must NOT see another user's token, got %s", w.Body.String())
	}

	// A superadmin's own list (Settings) holds only their own tokens too: another
	// person's token there looks like theirs. Auditing is /api/admin/tokens.
	w = tokenReq(h, http.MethodGet, "", &middleware.UserContext{ID: 1, Username: "alice", Role: "superadmin"})
	if !strings.Contains(w.Body.String(), "tok-alice") || strings.Contains(w.Body.String(), "tok-bob") {
		t.Errorf("a superadmin's own list must hold only their tokens, got %s", w.Body.String())
	}

	// Single mode (nil user context) is unaffected.
	w = tokenReq(h, http.MethodGet, "", nil)
	if !strings.Contains(w.Body.String(), "tok-alice") || !strings.Contains(w.Body.String(), "tok-bob") {
		t.Errorf("single mode should see every token, got %s", w.Body.String())
	}
}

func TestTokenRevokeIsScopedToOwner(t *testing.T) {
	// A collaborator cannot revoke someone else's token.
	fs := twoUsersTokens()
	h := NewTokenHandler(fs)
	w := tokenReq(h, http.MethodDelete, "tok-bob", &middleware.UserContext{ID: 1, Username: "alice", Role: "collaborator"})
	if w.Code != http.StatusForbidden {
		t.Errorf("alice revoking bob's token: want 403, got %d (%s)", w.Code, w.Body.String())
	}
	if all, _ := fs.All(); len(all) != 2 {
		t.Errorf("bob's token must survive a refused revoke, have %d tokens", len(all))
	}

	// Their own token revokes fine.
	w = tokenReq(h, http.MethodDelete, "tok-alice", &middleware.UserContext{ID: 1, Username: "alice", Role: "collaborator"})
	if w.Code != http.StatusOK {
		t.Errorf("alice revoking her own token: want 200, got %d (%s)", w.Code, w.Body.String())
	}

	// A superadmin cannot revoke someone else's token from their own list either.
	fs = twoUsersTokens()
	h = NewTokenHandler(fs)
	w = tokenReq(h, http.MethodDelete, "tok-bob", &middleware.UserContext{ID: 9, Username: "root", Role: "superadmin"})
	if w.Code != http.StatusForbidden {
		t.Errorf("superadmin revoking bob's token through /api/auth/tokens: want 403, got %d (%s)", w.Code, w.Body.String())
	}
	if all, _ := fs.All(); len(all) != 2 {
		t.Errorf("bob's token must survive, have %d tokens", len(all))
	}
}

func adminTokenReq(h *TokenHandler, method, id string, uc *middleware.UserContext) *httptest.ResponseRecorder {
	target := "/api/admin/tokens"
	if id != "" {
		target += "?id=" + id
	}
	r := middleware.WithUser(httptest.NewRequest(method, target, nil), uc)
	w := httptest.NewRecorder()
	h.HandleAdminTokens(w, r)
	return w
}

// The admin endpoint (superadmin, enforced by the route) lists every token with
// its owner, so whose token it is shows before anyone revokes it.
func TestAdminTokensListEveryTokenWithItsOwner(t *testing.T) {
	fs := twoUsersTokens()
	fs.tokens[1].Username = "bob"
	h := NewTokenHandler(fs)
	w := adminTokenReq(h, http.MethodGet, "", &middleware.UserContext{ID: 9, Username: "root", Role: "superadmin"})
	body := w.Body.String()
	if w.Code != http.StatusOK || !strings.Contains(body, "tok-alice") || !strings.Contains(body, `"username":"bob"`) {
		t.Errorf("admin list: want every token with its owner, got %d %s", w.Code, body)
	}
	if strings.Contains(body, "hb") || strings.Contains(body, "token_hash") {
		t.Errorf("admin list must not expose hashes, got %s", body)
	}
}

func TestAdminTokensRevokeAnyToken(t *testing.T) {
	fs := twoUsersTokens()
	h := NewTokenHandler(fs)
	w := adminTokenReq(h, http.MethodDelete, "tok-bob", &middleware.UserContext{ID: 9, Username: "root", Role: "superadmin"})
	if w.Code != http.StatusOK {
		t.Errorf("admin revoking bob's token: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	if all, _ := fs.All(); len(all) != 1 || all[0].ID != "tok-alice" {
		t.Errorf("only bob's token must be gone, have %+v", all)
	}
	if w := adminTokenReq(h, http.MethodDelete, "tok-bob", &middleware.UserContext{ID: 9, Role: "superadmin"}); w.Code != http.StatusNotFound {
		t.Errorf("revoking a gone token: want 404, got %d", w.Code)
	}
}
