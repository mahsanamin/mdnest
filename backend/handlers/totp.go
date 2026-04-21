package handlers

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"log"
	"math/big"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

// TOTPHandler handles 2FA setup, verification, and management.
// The actual TOTP state (secret, enabled flag, recovery codes) is kept in
// whatever store.TOTPStore impl we're given — Postgres locally, or Firestore
// when running in Firebase mode.
type TOTPHandler struct {
	secret    []byte
	userStore store.UserStore
	totpStore store.TOTPStore
	issuer    string // TOTP issuer name shown in authenticator app
}

// NewTOTPHandler creates a new TOTP handler.
func NewTOTPHandler(jwtSecret string, userStore store.UserStore, totpStore store.TOTPStore, issuer string) *TOTPHandler {
	if issuer == "" {
		issuer = "mdnest"
	}
	return &TOTPHandler{
		secret:    []byte(jwtSecret),
		userStore: userStore,
		totpStore: totpStore,
		issuer:    issuer,
	}
}

// --- TOTP Setup ---

type setupTOTPResponse struct {
	Secret string `json:"secret"` // base32 secret for manual entry
	QRCode string `json:"qrCode"` // base64-encoded PNG QR code
	URL    string `json:"url"`    // otpauth:// URL
}

// HandleSetupTOTP generates a new TOTP secret and QR code.
// POST /api/auth/totp/setup (authenticated)
func (h *TOTPHandler) HandleSetupTOTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	user, err := h.userStore.GetUserByID(uc.ID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	_, enabled, _, err := h.totpStore.Get(uc.ID)
	if err != nil {
		http.Error(w, `{"error":"failed to read 2FA state"}`, http.StatusInternalServerError)
		return
	}
	if enabled {
		http.Error(w, `{"error":"2FA is already enabled. Disable it first to re-setup."}`, http.StatusBadRequest)
		return
	}

	// Generate TOTP key
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      h.issuer,
		AccountName: user.Email,
	})
	if err != nil {
		http.Error(w, `{"error":"failed to generate TOTP secret"}`, http.StatusInternalServerError)
		return
	}

	// Generate QR code as base64 PNG
	img, err := key.Image(256, 256)
	if err != nil {
		http.Error(w, `{"error":"failed to generate QR code"}`, http.StatusInternalServerError)
		return
	}

	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		http.Error(w, `{"error":"failed to encode QR code"}`, http.StatusInternalServerError)
		return
	}
	qrBase64 := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBuf.Bytes())

	// Store the secret (not yet enabled — user must verify first)
	recoveryCodes := generateRecoveryCodes(10)
	hashedCodes := hashRecoveryCodes(recoveryCodes)
	codesJSON, _ := json.Marshal(hashedCodes)

	if err := h.totpStore.Set(user.ID, key.Secret(), string(codesJSON)); err != nil {
		http.Error(w, `{"error":"failed to save TOTP secret"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"secret":        key.Secret(),
		"qrCode":        qrBase64,
		"url":           key.URL(),
		"recoveryCodes": recoveryCodes,
	})
}

// HandleVerifySetup verifies the first TOTP code and enables 2FA.
// POST /api/auth/totp/verify-setup (authenticated)
func (h *TOTPHandler) HandleVerifySetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
		return
	}

	user, err := h.userStore.GetUserByID(uc.ID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	secret, _, _, err := h.totpStore.Get(user.ID)
	if err != nil {
		http.Error(w, `{"error":"failed to read 2FA state"}`, http.StatusInternalServerError)
		return
	}
	if secret == "" {
		http.Error(w, `{"error":"TOTP not set up. Call /api/auth/totp/setup first."}`, http.StatusBadRequest)
		return
	}

	// Verify the code
	if !totp.Validate(req.Code, secret) {
		http.Error(w, `{"error":"invalid code"}`, http.StatusUnauthorized)
		return
	}

	// Enable 2FA
	if err := h.totpStore.Enable(user.ID); err != nil {
		http.Error(w, `{"error":"failed to enable 2FA"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("2FA enabled for user: %s (id: %d)", user.Username, user.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// HandleDisableTOTP disables 2FA for the current user.
// POST /api/auth/totp/disable (authenticated)
// In local mode the user re-authenticates with their password. In Firebase
// mode there is no local password — the client is already authenticated via
// Firebase, and the current JWT is sufficient.
func (h *TOTPHandler) HandleDisableTOTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	// Body is optional in Firebase mode; decode errors are non-fatal.
	_ = json.NewDecoder(r.Body).Decode(&req)

	user, err := h.userStore.GetUserByID(uc.ID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	// Only verify password if one exists on the account (local-mode users).
	if user.PasswordHash != "" {
		if !store.CheckPassword(user, req.Password) {
			http.Error(w, `{"error":"incorrect password"}`, http.StatusUnauthorized)
			return
		}
	}

	if err := h.totpStore.Disable(user.ID); err != nil {
		http.Error(w, `{"error":"failed to disable 2FA"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("2FA disabled for user: %s (id: %d)", user.Username, user.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// --- Forced TOTP Setup (during login, with temp token) ---

// HandleSetupTOTPWithTemp generates TOTP for a user during forced setup (no full auth).
// POST /api/auth/totp/setup-with-temp { tempToken }
func (h *TOTPHandler) HandleSetupTOTPWithTemp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TempToken string `json:"tempToken"`
		Code      string `json:"code"` // empty for setup, filled for verify
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
		return
	}

	claims, err := parseTempToken(req.TempToken, h.secret)
	if err != nil {
		http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
		return
	}

	userID := int(claims["user_id"].(float64))
	user, err := h.userStore.GetUserByID(userID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	// If code is provided, verify and enable 2FA
	if req.Code != "" {
		secret, _, _, err := h.totpStore.Get(user.ID)
		if err != nil {
			http.Error(w, `{"error":"failed to read 2FA state"}`, http.StatusInternalServerError)
			return
		}
		if secret == "" {
			http.Error(w, `{"error":"TOTP not set up yet"}`, http.StatusBadRequest)
			return
		}
		if !totp.Validate(req.Code, secret) {
			http.Error(w, `{"error":"invalid code"}`, http.StatusUnauthorized)
			return
		}
		if err := h.totpStore.Enable(user.ID); err != nil {
			http.Error(w, `{"error":"failed to enable 2FA"}`, http.StatusInternalServerError)
			return
		}
		log.Printf("2FA enabled for user: %s (id: %d) via forced setup", user.Username, user.ID)

		// Issue full JWT with totp_enabled=true (they just enabled it).
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub":          user.Username,
			"user_id":      user.ID,
			"role":         user.Role,
			"totp_enabled": true,
			"iat":          time.Now().Unix(),
			"exp":          time.Now().Add(30 * 24 * time.Hour).Unix(),
		})
		tokenString, err := token.SignedString(h.secret)
		if err != nil {
			http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"token": tokenString})
		return
	}

	// No code — generate TOTP secret and QR
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      h.issuer,
		AccountName: user.Email,
	})
	if err != nil {
		http.Error(w, `{"error":"failed to generate TOTP"}`, http.StatusInternalServerError)
		return
	}

	img, err := key.Image(256, 256)
	if err != nil {
		http.Error(w, `{"error":"failed to generate QR code"}`, http.StatusInternalServerError)
		return
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		http.Error(w, `{"error":"failed to encode QR"}`, http.StatusInternalServerError)
		return
	}
	qrBase64 := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBuf.Bytes())

	recoveryCodes := generateRecoveryCodes(10)
	hashedCodes := hashRecoveryCodes(recoveryCodes)
	codesJSON, _ := json.Marshal(hashedCodes)

	if err := h.totpStore.Set(user.ID, key.Secret(), string(codesJSON)); err != nil {
		http.Error(w, `{"error":"failed to save TOTP"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"secret":        key.Secret(),
		"qrCode":        qrBase64,
		"url":           key.URL(),
		"recoveryCodes": recoveryCodes,
	})
}

// --- Login TOTP Verification ---

// HandleVerifyLoginTOTP verifies TOTP during the login flow.
// POST /api/auth/verify-totp { temp_token, code }
func (h *TOTPHandler) HandleVerifyLoginTOTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TempToken string `json:"tempToken"`
		Code      string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
		return
	}

	// Validate temp token
	claims, err := parseTempToken(req.TempToken, h.secret)
	if err != nil {
		http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
		return
	}

	userID := int(claims["user_id"].(float64))
	user, err := h.userStore.GetUserByID(userID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	secret, _, recoveryJSON, err := h.totpStore.Get(user.ID)
	if err != nil {
		http.Error(w, `{"error":"failed to read 2FA state"}`, http.StatusInternalServerError)
		return
	}
	if secret == "" {
		http.Error(w, `{"error":"2FA not configured"}`, http.StatusBadRequest)
		return
	}

	// Try TOTP code first
	valid := totp.Validate(req.Code, secret)

	// If not valid, try recovery codes
	if !valid && recoveryJSON != "" {
		valid = h.tryRecoveryCode(user.ID, secret, recoveryJSON, req.Code)
	}

	if !valid {
		http.Error(w, `{"error":"invalid code"}`, http.StatusUnauthorized)
		return
	}

	// Issue full JWT with totp_enabled=true — gate was passed.
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":          user.Username,
		"user_id":      user.ID,
		"role":         user.Role,
		"totp_enabled": true,
		"iat":          time.Now().Unix(),
		"exp":          time.Now().Add(30 * 24 * time.Hour).Unix(),
	})

	tokenString, err := token.SignedString(h.secret)
	if err != nil {
		http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": tokenString})
}

// --- Admin: Reset 2FA ---

// HandleAdminResetTOTP allows admins to reset another user's 2FA.
// POST /api/admin/reset-2fa { userId }
// In Firebase mode this deletes the Firestore doc, which affects the user
// on every mdnest server sharing the same Firebase project. The admin UI
// surfaces that warning before calling this.
func (h *TOTPHandler) HandleAdminResetTOTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		UserID int `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
		return
	}

	user, err := h.userStore.GetUserByID(req.UserID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	if err := h.totpStore.Disable(req.UserID); err != nil {
		http.Error(w, `{"error":"failed to reset 2FA"}`, http.StatusInternalServerError)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	adminName := "unknown"
	if uc != nil {
		adminName = uc.Username
	}
	log.Printf("2FA reset for user %s (id: %d) by admin %s", user.Username, user.ID, adminName)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// --- Helpers ---

// CreateTempToken creates a short-lived token for multi-step login.
func CreateTempToken(user *store.User, secret []byte, purpose string) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":     user.Username,
		"user_id": user.ID,
		"role":    user.Role,
		"purpose": purpose, // "totp" or "change_password"
		"iat":     time.Now().Unix(),
		"exp":     time.Now().Add(10 * time.Minute).Unix(),
	})
	return token.SignedString(secret)
}

func parseTempToken(tokenString string, secret []byte) (jwt.MapClaims, error) {
	token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, fmt.Errorf("invalid claims")
	}
	return claims, nil
}

func generateRecoveryCodes(count int) []string {
	codes := make([]string, count)
	for i := 0; i < count; i++ {
		codes[i] = randomCode(8)
	}
	return codes
}

func randomCode(length int) string {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no I, O, 0, 1
	b := make([]byte, length)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		b[i] = charset[n.Int64()]
	}
	return string(b)
}

func hashRecoveryCodes(codes []string) []string {
	hashed := make([]string, len(codes))
	for i, code := range codes {
		h, _ := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
		hashed[i] = string(h)
	}
	return hashed
}

// tryRecoveryCode attempts to match `code` against the user's recovery codes.
// On success, the consumed code is removed and the new list persisted via
// totpStore.Set — same flow regardless of backing store.
func (h *TOTPHandler) tryRecoveryCode(userID int, secret, recoveryJSON, code string) bool {
	var hashedCodes []string
	if err := json.Unmarshal([]byte(recoveryJSON), &hashedCodes); err != nil {
		return false
	}

	for i, hashed := range hashedCodes {
		if bcrypt.CompareHashAndPassword([]byte(hashed), []byte(code)) == nil {
			// Remove used code
			hashedCodes = append(hashedCodes[:i], hashedCodes[i+1:]...)
			codesJSON, _ := json.Marshal(hashedCodes)
			h.totpStore.Set(userID, secret, string(codesJSON))
			log.Printf("recovery code used by user id: %d, %d codes remaining", userID, len(hashedCodes))
			return true
		}
	}
	return false
}
