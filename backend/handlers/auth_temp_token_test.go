package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/pquerna/otp/totp"

	"github.com/mdnest/mdnest/backend/store"
)

// A login step token (claim "purpose") is good for exactly one endpoint: the
// one that consumes that step. Before v4.6.2 every consumer accepted any
// purpose, so a "totp" token (issued after the password, before the code)
// could re-enrol a fresh TOTP secret through setup-with-temp, or skip the code
// entirely by changing the password.

type tempUsers struct {
	store.UserStore
	user        store.User
	newPassword string
}

func (u *tempUsers) GetUserByID(id int) (*store.User, error) {
	if id != u.user.ID {
		return nil, nil
	}
	c := u.user
	return &c, nil
}

func (u *tempUsers) UpdatePassword(id int, pw string) error {
	u.newPassword = pw
	u.user.MustChangePassword = false
	return nil
}

type tempTOTP struct {
	secret  string
	enabled bool
}

func (s *tempTOTP) Get(int) (string, bool, string, error) { return s.secret, s.enabled, "", nil }
func (s *tempTOTP) Set(_ int, secret, _ string) error {
	s.secret = secret
	return nil
}
func (s *tempTOTP) Enable(int) error  { s.enabled = true; return nil }
func (s *tempTOTP) Disable(int) error { s.enabled = false; return nil }

const tempSecret = "temp-token-test"

func tempTokenFor(t *testing.T, u store.User, purpose string) string {
	t.Helper()
	if purpose == "" { // a full session token
		s, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub": u.Username, "user_id": u.ID, "role": u.Role,
			"exp": time.Now().Add(time.Hour).Unix(),
		}).SignedString([]byte(tempSecret))
		return s
	}
	s, err := CreateTempToken(&u, []byte(tempSecret), purpose)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func postJSON(fn http.HandlerFunc, path string, body map[string]any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	fn(w, httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(b))))
	return w
}

func TestTempToken_SetupWithTempNeedsTheSetupStep(t *testing.T) {
	u := store.User{ID: 7, Username: "eve", Email: "eve@x", Role: "collaborator"}
	enrolled, _ := totp.Generate(totp.GenerateOpts{Issuer: "t", AccountName: "eve"})
	ts := &tempTOTP{secret: enrolled.Secret(), enabled: true}
	h := NewTOTPHandler(tempSecret, &tempUsers{user: u}, ts, "t")

	// A user who already has 2FA holds a "totp" token after the password.
	for _, purpose := range []string{"totp", "change_password", ""} {
		w := postJSON(h.HandleSetupTOTPWithTemp, "/api/auth/totp/setup-with-temp",
			map[string]any{"tempToken": tempTokenFor(t, u, purpose)})
		if w.Code == http.StatusOK {
			t.Errorf("purpose %q re-enrolled TOTP (%d)", purpose, w.Code)
		}
	}
	// Even the setup token cannot replace a secret that is already enabled.
	w := postJSON(h.HandleSetupTOTPWithTemp, "/api/auth/totp/setup-with-temp",
		map[string]any{"tempToken": tempTokenFor(t, u, "totp_setup")})
	if w.Code == http.StatusOK {
		t.Errorf("setup token replaced an enabled secret (%d)", w.Code)
	}
	if ts.secret != enrolled.Secret() {
		t.Fatal("the enrolled TOTP secret was replaced")
	}

	// The real forced-setup flow still works for a user without 2FA.
	fresh := &tempTOTP{}
	h = NewTOTPHandler(tempSecret, &tempUsers{user: u}, fresh, "t")
	w = postJSON(h.HandleSetupTOTPWithTemp, "/api/auth/totp/setup-with-temp",
		map[string]any{"tempToken": tempTokenFor(t, u, "totp_setup")})
	if w.Code != http.StatusOK || fresh.secret == "" {
		t.Fatalf("forced setup broke: %d %s", w.Code, w.Body.String())
	}
	code, _ := totp.GenerateCode(fresh.secret, time.Now())
	w = postJSON(h.HandleSetupTOTPWithTemp, "/api/auth/totp/setup-with-temp",
		map[string]any{"tempToken": tempTokenFor(t, u, "totp_setup"), "code": code})
	if w.Code != http.StatusOK || !fresh.enabled {
		t.Fatalf("forced setup verify broke: %d %s", w.Code, w.Body.String())
	}
}

func TestTempToken_VerifyTOTPNeedsTheTOTPStep(t *testing.T) {
	u := store.User{ID: 7, Username: "eve", Role: "collaborator"}
	key, _ := totp.Generate(totp.GenerateOpts{Issuer: "t", AccountName: "eve"})
	h := NewTOTPHandler(tempSecret, &tempUsers{user: u}, &tempTOTP{secret: key.Secret(), enabled: true}, "t")
	code, _ := totp.GenerateCode(key.Secret(), time.Now())
	for _, purpose := range []string{"totp_setup", "change_password", ""} {
		w := postJSON(h.HandleVerifyLoginTOTP, "/api/auth/verify-totp",
			map[string]any{"tempToken": tempTokenFor(t, u, purpose), "code": code})
		if w.Code != http.StatusUnauthorized {
			t.Errorf("purpose %q accepted by verify-totp: %d", purpose, w.Code)
		}
	}
	w := postJSON(h.HandleVerifyLoginTOTP, "/api/auth/verify-totp",
		map[string]any{"tempToken": tempTokenFor(t, u, "totp"), "code": code})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "token") {
		t.Fatalf("the real TOTP step broke: %d %s", w.Code, w.Body.String())
	}
}

func TestTempToken_ForcedPasswordChangeNeedsItsStep(t *testing.T) {
	u := store.User{ID: 7, Username: "eve", Role: "collaborator", MustChangePassword: true}
	users := &tempUsers{user: u}
	h := NewMultiAuthHandler(tempSecret, users, &tempTOTP{secret: "x", enabled: true}, false)
	for _, purpose := range []string{"totp", "totp_setup", ""} {
		w := postJSON(h.HandleForcedPasswordChange, "/api/auth/change-password-forced",
			map[string]any{"tempToken": tempTokenFor(t, u, purpose), "newPassword": "n3w-passw0rd!"})
		if w.Code != http.StatusUnauthorized || users.newPassword != "" {
			t.Errorf("purpose %q changed the password: %d", purpose, w.Code)
		}
	}
	w := postJSON(h.HandleForcedPasswordChange, "/api/auth/change-password-forced",
		map[string]any{"tempToken": tempTokenFor(t, u, "change_password"), "newPassword": "n3w-passw0rd!"})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "totp_required") {
		t.Fatalf("the real change step broke: %d %s", w.Code, w.Body.String())
	}
}

// With 2FA required and none enrolled, changing the forced password must lead
// to TOTP setup, not straight to a session.
func TestTempToken_ForcedPasswordChangeStillRequiresTOTPSetup(t *testing.T) {
	u := store.User{ID: 7, Username: "eve", Role: "collaborator", MustChangePassword: true}
	h := NewMultiAuthHandler(tempSecret, &tempUsers{user: u}, &tempTOTP{}, true)
	w := postJSON(h.HandleForcedPasswordChange, "/api/auth/change-password-forced",
		map[string]any{"tempToken": tempTokenFor(t, u, "change_password"), "newPassword": "n3w-passw0rd!"})
	var resp loginResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Token != "" || resp.Status != "totp_setup_required" {
		t.Fatalf("forced change skipped required 2FA setup: %d %s", w.Code, w.Body.String())
	}
}

// A change_password step token is good once: after the forced change the user
// no longer has to change their password, and the same token (valid for ten
// minutes) must not reset it again.
func TestTempToken_ForcedPasswordChangeIsOneShot(t *testing.T) {
	u := store.User{ID: 7, Username: "eve", Role: "collaborator", MustChangePassword: true}
	users := &tempUsers{user: u}
	h := NewMultiAuthHandler(tempSecret, users, &tempTOTP{}, false)
	tok := tempTokenFor(t, u, "change_password")
	w := postJSON(h.HandleForcedPasswordChange, "/api/auth/change-password-forced",
		map[string]any{"tempToken": tok, "newPassword": "first-passw0rd!"})
	if w.Code != http.StatusOK {
		t.Fatalf("first change: %d %s", w.Code, w.Body.String())
	}
	w = postJSON(h.HandleForcedPasswordChange, "/api/auth/change-password-forced",
		map[string]any{"tempToken": tok, "newPassword": "second-passw0rd!"})
	if w.Code == http.StatusOK || users.newPassword != "first-passw0rd!" {
		t.Fatalf("a replayed step token changed the password again: %d (%q)", w.Code, users.newPassword)
	}
}
