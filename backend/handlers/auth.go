package handlers

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
	"golang.org/x/crypto/bcrypt"
)

// secretsFile stores hashed credentials on disk (single mode only).
type secretsFile struct {
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
}

// AuthHandler handles login and credential management.
type AuthHandler struct {
	// Single mode fields
	defaultUser     string
	defaultPassword string
	secretsPath     string
	mu              sync.RWMutex
	cached          *secretsFile

	// Shared
	secret []byte

	// Multi mode fields (nil in single mode)
	userStore  store.UserStore
	totpStore  store.TOTPStore
	require2FA bool
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token    string `json:"token,omitempty"`
	Status   string `json:"status,omitempty"`   // "ok", "change_password_required", "totp_required"
	TempToken string `json:"tempToken,omitempty"` // short-lived token for multi-step login
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewUsername      string `json:"newUsername"`
	NewPassword     string `json:"newPassword"`
}

// NewAuthHandler creates a new auth handler for single-user mode.
// secretsDir is where auth.json is stored (e.g. /data/secrets).
func NewAuthHandler(username, password, jwtSecret, secretsDir string) *AuthHandler {
	h := &AuthHandler{
		defaultUser:     username,
		defaultPassword: password,
		secret:          []byte(jwtSecret),
		secretsPath:     filepath.Join(secretsDir, "auth.json"),
	}

	// Ensure secrets directory exists
	os.MkdirAll(secretsDir, 0700)

	// Load existing secrets
	h.loadSecrets()

	return h
}

// NewMultiAuthHandler creates a new auth handler for multi-user mode.
func NewMultiAuthHandler(jwtSecret string, userStore store.UserStore, totpStore store.TOTPStore, require2FA bool) *AuthHandler {
	return &AuthHandler{
		secret:     []byte(jwtSecret),
		userStore:  userStore,
		totpStore:  totpStore,
		require2FA: require2FA,
	}
}

// IsMultiMode returns true if the handler is in multi-user mode.
func (h *AuthHandler) IsMultiMode() bool {
	return h.userStore != nil
}

func (h *AuthHandler) loadSecrets() {
	data, err := os.ReadFile(h.secretsPath)
	if err != nil {
		// No secrets file — will use defaults
		h.cached = nil
		return
	}
	var sf secretsFile
	if err := json.Unmarshal(data, &sf); err != nil {
		log.Printf("warning: failed to parse %s, using defaults", h.secretsPath)
		h.cached = nil
		return
	}
	h.cached = &sf
	log.Printf("loaded credentials from %s (user: %s)", h.secretsPath, sf.Username)
}

func (h *AuthHandler) saveSecrets(sf *secretsFile) error {
	data, err := json.MarshalIndent(sf, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(h.secretsPath, data, 0600); err != nil {
		return err
	}
	h.cached = sf
	return nil
}

// checkCredentials verifies username and password in single mode.
func (h *AuthHandler) checkCredentials(username, password string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if h.cached != nil {
		// Use hashed credentials from secrets file
		usernameMatch := subtle.ConstantTimeCompare([]byte(username), []byte(h.cached.Username)) == 1
		if !usernameMatch {
			return false
		}
		err := bcrypt.CompareHashAndPassword([]byte(h.cached.PasswordHash), []byte(password))
		return err == nil
	}

	// Fall back to plaintext defaults from env/config
	usernameMatch := subtle.ConstantTimeCompare([]byte(username), []byte(h.defaultUser)) == 1
	passwordMatch := subtle.ConstantTimeCompare([]byte(password), []byte(h.defaultPassword)) == 1
	return usernameMatch && passwordMatch
}

func (h *AuthHandler) currentUsername() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.cached != nil {
		return h.cached.Username
	}
	return h.defaultUser
}

// Login handles POST /api/auth/login.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if h.IsMultiMode() {
		h.loginMulti(w, req)
	} else {
		h.loginSingle(w, req)
	}
}

func (h *AuthHandler) loginSingle(w http.ResponseWriter, req loginRequest) {
	if !h.checkCredentials(req.Username, req.Password) {
		http.Error(w, `{"error":"invalid credentials"}`, http.StatusUnauthorized)
		return
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": req.Username,
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(30 * 24 * time.Hour).Unix(),
	})

	tokenString, err := token.SignedString(h.secret)
	if err != nil {
		http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(loginResponse{Token: tokenString})
}

func (h *AuthHandler) loginMulti(w http.ResponseWriter, req loginRequest) {
	user, err := h.userStore.GetUserByUsername(req.Username)
	if err != nil {
		log.Printf("login error: %v", err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if user == nil || !store.CheckPassword(user, req.Password) {
		http.Error(w, `{"error":"invalid credentials"}`, http.StatusUnauthorized)
		return
	}

	if user.Blocked {
		http.Error(w, `{"error":"your account has been blocked. Contact your administrator."}`, http.StatusForbidden)
		return
	}

	// Check if password change is required
	if user.MustChangePassword {
		tempToken, err := CreateTempToken(user, h.secret, "change_password")
		if err != nil {
			http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(loginResponse{
			Status:    "change_password_required",
			TempToken: tempToken,
		})
		return
	}

	// Consult the TOTP store — in local mode this reads the users table, in
	// Firebase mode it reads Firestore so 2FA state is shared across servers.
	_, totpEnabled, _, err := h.totpStore.Get(user.ID)
	if err != nil {
		log.Printf("failed to read totp state for user %d: %v", user.ID, err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if totpEnabled {
		tempToken, err := CreateTempToken(user, h.secret, "totp")
		if err != nil {
			http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(loginResponse{
			Status:    "totp_required",
			TempToken: tempToken,
		})
		return
	}

	// Check if 2FA is required by admin but user hasn't set it up yet
	if h.require2FA && !totpEnabled {
		tempToken, err := CreateTempToken(user, h.secret, "totp_setup")
		if err != nil {
			http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(loginResponse{
			Status:    "totp_setup_required",
			TempToken: tempToken,
		})
		return
	}

	// No extra steps — issue full JWT
	h.issueFullToken(w, user, totpEnabled)
}

// issueFullToken mints the long-lived mdnest JWT. totpEnabled is embedded as a
// claim so the frontend/middleware can tell whether the user has 2FA set up
// without hitting the TOTP store on every request. It's informational only —
// real 2FA enforcement happens at login time, not on claim inspection.
func (h *AuthHandler) issueFullToken(w http.ResponseWriter, user *store.User, totpEnabled bool) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":          user.Username,
		"user_id":      user.ID,
		"role":         user.Role,
		"totp_enabled": totpEnabled,
		"iat":          time.Now().Unix(),
		"exp":          time.Now().Add(30 * 24 * time.Hour).Unix(),
	})

	tokenString, err := token.SignedString(h.secret)
	if err != nil {
		http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(loginResponse{Token: tokenString})
}

// HandleForcedPasswordChange handles password change during first login.
// POST /api/auth/change-password-forced { tempToken, newPassword }
func (h *AuthHandler) HandleForcedPasswordChange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TempToken   string `json:"tempToken"`
		NewPassword string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
		return
	}

	if req.NewPassword == "" {
		http.Error(w, `{"error":"new password is required"}`, http.StatusBadRequest)
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

	// Update password (also clears must_change_password)
	if err := h.userStore.UpdatePassword(userID, req.NewPassword); err != nil {
		http.Error(w, `{"error":"failed to update password"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("forced password change for user: %s (id: %d)", user.Username, user.ID)

	// If 2FA is enabled (per the TOTP store, which may be Firestore), require TOTP next.
	_, totpEnabled, _, err := h.totpStore.Get(user.ID)
	if err != nil {
		log.Printf("failed to read totp state for user %d: %v", user.ID, err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if totpEnabled {
		tempToken, err := CreateTempToken(user, h.secret, "totp")
		if err != nil {
			http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(loginResponse{
			Status:    "totp_required",
			TempToken: tempToken,
		})
		return
	}

	// No 2FA — issue full JWT
	h.issueFullToken(w, user, false)
}

// ChangePassword handles POST /api/auth/change-password (authenticated).
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req changePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.NewPassword == "" {
		http.Error(w, `{"error":"new password is required"}`, http.StatusBadRequest)
		return
	}

	if h.IsMultiMode() {
		h.changePasswordMulti(w, r, req)
	} else {
		h.changePasswordSingle(w, req)
	}
}

func (h *AuthHandler) changePasswordSingle(w http.ResponseWriter, req changePasswordRequest) {
	// Verify current password
	currentUser := h.currentUsername()
	if !h.checkCredentials(currentUser, req.CurrentPassword) {
		http.Error(w, `{"error":"current password is incorrect"}`, http.StatusUnauthorized)
		return
	}

	// Hash new password
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		http.Error(w, `{"error":"failed to hash password"}`, http.StatusInternalServerError)
		return
	}

	newUsername := req.NewUsername
	if newUsername == "" {
		newUsername = currentUser
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if err := h.saveSecrets(&secretsFile{
		Username:     newUsername,
		PasswordHash: string(hash),
	}); err != nil {
		http.Error(w, `{"error":"failed to save credentials"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("credentials updated (user: %s)", newUsername)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (h *AuthHandler) changePasswordMulti(w http.ResponseWriter, r *http.Request, req changePasswordRequest) {
	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"user context not found"}`, http.StatusInternalServerError)
		return
	}

	// Verify current password against DB
	user, err := h.userStore.GetUserByID(uc.ID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusInternalServerError)
		return
	}
	if !store.CheckPassword(user, req.CurrentPassword) {
		http.Error(w, `{"error":"current password is incorrect"}`, http.StatusUnauthorized)
		return
	}

	// Update password in DB
	if err := h.userStore.UpdatePassword(uc.ID, req.NewPassword); err != nil {
		http.Error(w, `{"error":"failed to update password"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("password updated for user: %s (id: %d)", uc.Username, uc.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
