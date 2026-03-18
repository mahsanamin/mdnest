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
	"golang.org/x/crypto/bcrypt"
)

// secretsFile stores hashed credentials on disk.
type secretsFile struct {
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
}

// AuthHandler handles login and credential management.
type AuthHandler struct {
	defaultUser     string
	defaultPassword string
	secretsPath     string
	secret          []byte
	mu              sync.RWMutex
	cached          *secretsFile // cached from disk
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token string `json:"token"`
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewUsername      string `json:"newUsername"`
	NewPassword     string `json:"newPassword"`
}

// NewAuthHandler creates a new auth handler.
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

// checkCredentials verifies username and password.
// Returns true if valid.
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

	if !h.checkCredentials(req.Username, req.Password) {
		http.Error(w, `{"error":"invalid credentials"}`, http.StatusUnauthorized)
		return
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": req.Username,
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(24 * time.Hour).Unix(),
	})

	tokenString, err := token.SignedString(h.secret)
	if err != nil {
		http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(loginResponse{Token: tokenString})
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
