package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/store"
)

// DevLoginHandler is an INSECURE backdoor that mints a session JWT for
// any email that already exists in the local users table — without
// going through the IdP. It exists only to make local SSO testing
// painless (you can't run the OIDC dance against accounts.google.com
// from a `?login=dev` form on localhost without a real browser flow,
// and you don't want to invent test users with passwords on a
// federated install).
//
// Strictly opt-in via INSECURE_DEV_LOGIN=true in mdnest.conf. The route
// is only registered in main.go when the flag is set; without it,
// POST /api/auth/dev-login 404s. The /api/config response surfaces a
// devLoginEnabled boolean so the frontend can show a loud warning bar
// + render the dev-login page when navigated to.
//
// Identity rules match SSO: the email must already exist (no auto-
// provisioning). Blocked users still can't sign in. The minted JWT is
// the full 30-day token, identical in shape to a real SSO login —
// totp_enabled is forced to false (the IdP owns MFA in SSO mode and
// dev-login is a stand-in for the IdP).
type DevLoginHandler struct {
	userStore store.UserStore
	secret    []byte
}

// NewDevLoginHandler builds the handler. Caller (main.go) is responsible
// for only registering this when INSECURE_DEV_LOGIN=true.
func NewDevLoginHandler(userStore store.UserStore, jwtSecret string) *DevLoginHandler {
	return &DevLoginHandler{userStore: userStore, secret: []byte(jwtSecret)}
}

type devLoginRequest struct {
	Email string `json:"email"`
}

type devLoginResponse struct {
	Token string `json:"token"`
}

// HandleDevLogin handles POST /api/auth/dev-login. Body: {"email": "..."}.
// On success returns {"token": "<jwt>"} which the frontend stores
// exactly like an SSO redirect token.
func (h *DevLoginHandler) HandleDevLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req devLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
		http.Error(w, `{"error":"email is required"}`, http.StatusBadRequest)
		return
	}

	user, err := h.userStore.GetUserByEmail(req.Email)
	if err != nil {
		log.Printf("dev-login: lookup failed for %s: %v", req.Email, err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if user == nil {
		http.Error(w, `{"error":"no mdnest account for that email"}`, http.StatusUnauthorized)
		return
	}
	if user.Blocked {
		http.Error(w, `{"error":"account is blocked"}`, http.StatusForbidden)
		return
	}

	// JWT shape mirrors the SSO callback exactly so the rest of the
	// app sees a normal session.
	sub := user.Username
	if sub == "" {
		sub = user.Email
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":          sub,
		"user_id":      user.ID,
		"role":         user.Role,
		"totp_enabled": false,
		"iat":          time.Now().Unix(),
		"exp":          time.Now().Add(30 * 24 * time.Hour).Unix(),
	})
	signed, err := token.SignedString(h.secret)
	if err != nil {
		log.Printf("dev-login: jwt sign failed: %v", err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("INSECURE_DEV_LOGIN: minted token for %s (user_id=%d, role=%s)", user.Email, user.ID, user.Role)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(devLoginResponse{Token: signed})
}
