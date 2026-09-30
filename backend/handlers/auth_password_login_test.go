package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// SSO_DISABLE_PASSWORD_LOGIN exists because, on an internet-facing SSO
// install, POST /api/auth/login is a password prompt that bypasses the IdP.
// Pin both directions: with the flag, even the RIGHT password gets no token;
// without it, password login is unchanged.

func postLogin(h *AuthHandler, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.Login(w, r)
	return w
}

func TestPasswordLoginAllowedByDefault(t *testing.T) {
	h := NewAuthHandler("admin", "s3cret", "jwt-secret", t.TempDir())
	w := postLogin(h, `{"username":"admin","password":"s3cret"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"token"`) {
		t.Fatalf("password login without the flag must work: %d %s", w.Code, w.Body.String())
	}
}

func TestPasswordLoginRefusedWhenDisabled(t *testing.T) {
	h := NewAuthHandler("admin", "s3cret", "jwt-secret", t.TempDir())
	h.DisablePasswordLogin()
	for _, body := range []string{
		`{"username":"admin","password":"s3cret"}`, // correct credentials
		`{"username":"admin","password":"wrong"}`,  // wrong ones answer the same
	} {
		w := postLogin(h, body)
		if w.Code != http.StatusForbidden {
			t.Fatalf("want 403 with password login disabled, got %d %s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), `"token"`) {
			t.Fatalf("a token was issued with password login disabled: %s", w.Body.String())
		}
	}
}
