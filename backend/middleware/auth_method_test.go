package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Agent approvals refuse a decision made with an API token, so the auth
// middleware must record how each request was authenticated, in BOTH modes:
// a single-mode request carries no UserContext at all. These tests go
// through the real Wrap, not a hand-made context.

type fakeTokens struct{ owner *UserContext }

func (f fakeTokens) ValidateAPIToken(t string) bool { return t == "mdnest_good" }
func (f fakeTokens) ResolveAPITokenUser(string) *UserContext {
	if f.owner == nil {
		return nil
	}
	u := *f.owner
	return &u
}

func sessionJWT(t *testing.T, secret string) string {
	t.Helper()
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "pat", "user_id": 7, "role": "collaborator", "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAuthRecordsAPITokenUse(t *testing.T) {
	const secret = "s"
	owner := &UserContext{ID: 7, Username: "pat", Role: "collaborator"}
	for _, multi := range []bool{false, true} {
		a := NewAuthMiddleware(secret, multi, fakeTokens{owner}, fakeTokens{owner})
		cases := []struct {
			name      string
			header    string
			query     string
			wantToken bool
		}{
			{"bearer API token", "Bearer mdnest_good", "", true},
			{"API token in ?token=", "", "mdnest_good", true},
			{"browser session JWT", "Bearer " + sessionJWT(t, secret), "", false},
			{"session JWT in ?token=", "", sessionJWT(t, secret), false},
		}
		for _, c := range cases {
			var sawToken, sawUserFlag, called bool
			h := a.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				sawToken = RequestViaAPIToken(r)
				if u := UserFromContext(r.Context()); u != nil {
					sawUserFlag = u.ViaAPIToken
				}
			}))
			url := "/api/approvals"
			if c.query != "" {
				url += "?token=" + c.query
			}
			req := httptest.NewRequest(http.MethodGet, url, nil)
			if c.header != "" {
				req.Header.Set("Authorization", c.header)
			}
			h.ServeHTTP(httptest.NewRecorder(), req)
			if !called {
				t.Fatalf("multi=%v %s: request was refused", multi, c.name)
			}
			if sawToken != c.wantToken {
				t.Errorf("multi=%v %s: RequestViaAPIToken = %v, want %v", multi, c.name, sawToken, c.wantToken)
			}
			if multi && sawUserFlag != c.wantToken {
				t.Errorf("multi=%v %s: UserContext.ViaAPIToken = %v, want %v", multi, c.name, sawUserFlag, c.wantToken)
			}
		}
	}
	if owner.ViaAPIToken {
		t.Error("the resolver's UserContext was modified in place")
	}
}
